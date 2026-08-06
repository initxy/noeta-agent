"""`SdkSandboxExecEnv` — the container fs/shell transport over the official SDK.

The adapter overrides exactly three primitives (`_shell` / `read_bytes` /
`write_bytes`), so what has to be pinned is (a) that each one issues the right
SDK call and maps the typed result back to the exact shape the *inherited*
methods parse, and (b) that the inherited methods therefore still behave
byte-for-byte as they did over the hand-written wire. Most tests below reach the
transport through an inherited method for exactly that reason.

Nothing here opens a socket: the SDK client is a fake exposing `.shell` and
`.file`.
"""
from __future__ import annotations

import base64
from pathlib import Path
from typing import Any
from collections.abc import Callable

import httpx
import pytest
from agent_sandbox.core.api_error import ApiError
from noeta.builtins.sandbox.impl.exec_env import (
    AioSandboxError,
    ExclusiveCreateExists,
)

from noeta.agent.host.sdk_sandbox_exec_env import SdkSandboxExecEnv

BASE = "http://127.0.0.1:54321"


class Data:
    """Stands in for the SDK's typed `.data` model, which allows extras."""

    def __init__(self, **fields: Any) -> None:
        self.__dict__.update(fields)


class Resp:
    def __init__(
        self, data: Any, success: bool | None = True, message: str | None = None
    ) -> None:
        self.data = data
        self.success = success
        self.message = message


class FakeShell:
    def __init__(self, script: Callable[[str], Any]) -> None:
        #: Returns a `Data` (wrapped in a success `Resp`) or a whole `Resp`, so
        #: a `success=false` reply can be scripted.
        self._script = script
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    def exec_command(
        self, *, command: str, request_options: dict[str, Any] | None = None
    ) -> Resp:
        self.calls.append((command, request_options))
        result = self._script(command)
        return result if isinstance(result, Resp) else Resp(result)


class FakeFile:
    def __init__(
        self,
        reads: dict[str, bytes] | None = None,
        text_reads: dict[str, str] | None = None,
        errors: dict[str, Exception] | None = None,
        write_response: Resp | None = None,
        read_response: Resp | None = None,
    ) -> None:
        self.reads = reads or {}
        self.text_reads = text_reads or {}
        self.errors = errors or {}
        self.write_response = write_response
        self.read_response = read_response
        self.writes: list[tuple[str, str, str | None]] = []
        self.downloads: list[tuple[str, dict[str, Any] | None]] = []
        self.file_reads: list[tuple[str, dict[str, Any] | None]] = []

    def download_file(
        self, *, path: str, request_options: dict[str, Any] | None = None
    ):
        self.downloads.append((path, request_options))
        if path in self.errors:
            raise self.errors[path]
        # Two chunks, so the reassembly is genuinely exercised.
        blob = self.reads.get(path, b"")
        yield blob[: len(blob) // 2]
        yield blob[len(blob) // 2 :]

    def read_file(
        self, *, file: str, request_options: dict[str, Any] | None = None
    ) -> Resp:
        """The native `/v1/file/read` text endpoint — `read_text`'s utf-8 path."""
        self.file_reads.append((file, request_options))
        if file in self.errors:
            raise self.errors[file]
        if self.read_response is not None:
            return self.read_response
        return Resp(Data(file=file, content=self.text_reads.get(file, "")))

    def write_file(
        self,
        *,
        file: str,
        content: str,
        encoding: str | None = None,
        request_options: dict[str, Any] | None = None,
    ) -> Resp:
        self.writes.append((file, content, encoding))
        if self.write_response is not None:
            return self.write_response
        return Resp(Data(file=file, bytes_written=len(content)))


class FakeSandbox:
    def __init__(self, shell: FakeShell, file: FakeFile) -> None:
        self.shell = shell
        self.file = file


def _completed(
    *, exit_code: int = 0, output: str = "", spill: str | None = None
) -> Data:
    data = Data(session_id="s1", status="completed", exit_code=exit_code, output=output)
    if spill is not None:
        data.full_output_file_path = spill
    return data


def _running(output: str = "") -> Data:
    """A command that did NOT complete: the server reports no exit code."""
    return Data(session_id="s1", status="running", exit_code=None, output=output)


def _env(
    *,
    shell: FakeShell | None = None,
    file: FakeFile | None = None,
    **kwargs: Any,
) -> tuple[SdkSandboxExecEnv, FakeShell, FakeFile]:
    shell = shell or FakeShell(lambda _command: _completed())
    file = file or FakeFile()
    env = SdkSandboxExecEnv(base_url=BASE, client=FakeSandbox(shell, file), **kwargs)
    return env, shell, file


# --------------------------------------------------------------------------
# Construction and the tripwire
# --------------------------------------------------------------------------


def test_an_empty_base_url_is_refused_at_construction() -> None:
    with pytest.raises(AioSandboxError):
        SdkSandboxExecEnv(
            base_url="", client=FakeSandbox(FakeShell(lambda _c: _completed()), FakeFile())
        )


def test_call_is_a_tripwire_naming_the_three_primitives() -> None:
    """`__init__` deliberately never runs the parent's, so the urllib transport
    attributes do not exist. Without this override a future parent method that
    bypasses the three primitives would fail with a confusing AttributeError
    instead of saying what went wrong."""
    env, _, _ = _env()

    with pytest.raises(AioSandboxError, match="bypassed _shell/read_bytes/write_bytes"):
        env._call("/v1/file/read", {"file": "/x"})


# --------------------------------------------------------------------------
# 91 — run_argv's inherited command shape
# --------------------------------------------------------------------------


def test_run_argv_sends_cd_then_the_shell_quoted_argv() -> None:
    """cwd is expressed lexically rather than through an unconfirmed request
    field, and the argv is quoted so the remote shell re-runs the exact tokens."""
    env, shell, _ = _env(
        shell=FakeShell(lambda _c: _completed(output="hello\n"))
    )

    outcome = env.run_argv(
        ["echo", "hello world"], cwd=Path("/work/dir"), timeout_s=30, output_cap=1000
    )

    command, request_options = shell.calls[0]
    assert command == "cd /work/dir && echo 'hello world'"
    # The caller's per-command budget rides as the SDK per-call timeout: the
    # container never hard-kills a slow exec, so the transport timeout IS the
    # effective bound.
    assert request_options == {"timeout_in_seconds": 30}
    assert outcome.returncode == 0
    assert outcome.stdout == b"hello\n"
    # The container merges the streams into one `output`, so there is no stderr
    # channel to invent.
    assert outcome.stderr == b""
    assert outcome.timed_out is False


def test_run_argv_propagates_a_nonzero_exit() -> None:
    env, _, _ = _env(shell=FakeShell(lambda _c: _completed(exit_code=7, output="boom")))

    outcome = env.run_argv(["false"], cwd=Path("/w"), timeout_s=5, output_cap=100)

    assert outcome.returncode == 7
    assert outcome.stdout == b"boom"


def test_the_preamble_is_minted_fresh_for_every_exec() -> None:
    env, shell, _ = _env(preamble=lambda _argv: "export T=1 && ")

    env.run_argv(["echo", "x"], cwd=Path("/w"), timeout_s=5, output_cap=100)

    assert shell.calls[0][0] == "cd /w && export T=1 && echo x"


# --------------------------------------------------------------------------
# 92 — a missing exit code must stay missing
# --------------------------------------------------------------------------


def test_a_missing_exit_code_is_passed_through_absent() -> None:
    """The consumers disagree on the right default, and each of them is right:
    stat reads absence as failure, `run_argv` keeps 0. Normalising to 0 in the
    transport would make `is_file()` answer True for a command that never ran."""
    env, _, _ = _env(shell=FakeShell(lambda _c: _running(output="x")))

    assert env.is_file(Path("/a")) is False
    assert env.exists(Path("/a")) is False
    assert env.run_argv(["true"], cwd=Path("/w"), timeout_s=5, output_cap=100).returncode == 0


# --------------------------------------------------------------------------
# 93 / 94 — spilled output, and the forward-looking canary
# --------------------------------------------------------------------------


def test_spilled_output_is_recovered_with_a_bounded_tail() -> None:
    """The inline echo is lossy when the stream is large. Reading the spill
    whole would hit the very response cap the spill exists to dodge, so the
    inherited reader pulls `cap + 1` bytes off the end."""

    def script(command: str) -> Data:
        if command.startswith("tail -c"):
            return _completed(output="full-spilled-output")
        return _completed(output="truncated", spill="/tmp/spill.log")

    env, shell, _ = _env(shell=FakeShell(script))

    outcome = env.run_argv(["make"], cwd=Path("/w"), timeout_s=30, output_cap=1000)

    assert outcome.stdout == b"full-spilled-output"
    assert any(command == "tail -c 1001 -- /tmp/spill.log" for command, _ in shell.calls)


def test_the_spill_field_survives_the_real_generated_shell_model() -> None:
    """A forward-looking canary. `full_output_file_path` is NOT a declared field
    of the SDK's `ShellCommandResult`; the adapter reads it with `getattr` and
    that works only because the generated models allow extras. Validating the
    REAL model with the key present means an SDK bump that tightens the models
    fails loudly here, instead of silently losing every spilled build log."""
    from agent_sandbox.types.shell_command_result import ShellCommandResult

    model = ShellCommandResult.model_validate(
        {
            "session_id": "s",
            "command": "c",
            "status": "completed",
            "output": "x",
            "exit_code": 0,
            "full_output_file_path": "/tmp/spill.log",
        }
    )

    assert getattr(model, "full_output_file_path", None) == "/tmp/spill.log"


# --------------------------------------------------------------------------
# 95 — in-band failures (200 + success:false)
# --------------------------------------------------------------------------


def test_an_in_band_shell_failure_raises_with_the_server_message() -> None:
    """The generated client parses `200 + success:false` without raising, so
    the adapter has to check. Left unchecked, every shell-backed inherited
    method would read an empty result as a clean success."""
    env, _, _ = _env(
        shell=FakeShell(lambda _c: Resp(None, success=False, message="shell down"))
    )

    with pytest.raises(AioSandboxError, match="shell down"):
        env.unlink(Path("/x"))


def test_an_in_band_write_failure_maps_its_error_type() -> None:
    """The one that costs the most when missed: without this check `edit` and
    `apply_patch` report success with the file unchanged."""
    env, _, _ = _env(
        file=FakeFile(
            write_response=Resp(
                Data(error_type="permission_denied"), success=False, message="denied"
            )
        )
    )

    with pytest.raises(PermissionError, match="denied"):
        env.write_bytes(Path("/ro/x"), b"body")


def test_an_in_band_failure_without_an_error_type_degrades_to_a_typed_error() -> None:
    env, _, _ = _env(file=FakeFile(write_response=Resp(None, success=False, message="disk full")))

    with pytest.raises(AioSandboxError, match="disk full"):
        env.write_bytes(Path("/x"), b"body")


# --------------------------------------------------------------------------
# 96 — a timeout and an ApiError are two different outcomes of the same type
# --------------------------------------------------------------------------


def test_a_transport_read_timeout_is_a_timed_out_run() -> None:
    def slow(_command: str) -> Data:
        raise httpx.ReadTimeout("read deadline")

    env, _, _ = _env(shell=FakeShell(slow))

    outcome = env.run_argv(["sleep", "99"], cwd=Path("/w"), timeout_s=1, output_cap=100)

    assert outcome.timed_out is True
    assert outcome.returncode == -1


def test_an_api_error_is_a_failed_run_carrying_the_server_message() -> None:
    def boom(_command: str) -> Data:
        raise ApiError(status_code=500, headers={}, body={"message": "kaboom"})

    env, _, _ = _env(shell=FakeShell(boom))

    outcome = env.run_argv(["x"], cwd=Path("/w"), timeout_s=5, output_cap=100)

    assert outcome.returncode == -1
    assert outcome.timed_out is False
    assert b"kaboom" in outcome.stderr


# --------------------------------------------------------------------------
# 97 — create_exclusive's noclobber gate
# --------------------------------------------------------------------------


def test_create_exclusive_gates_with_noclobber_then_writes() -> None:
    env, shell, file = _env()

    env.create_exclusive(Path("/n.txt"), b"body")

    assert shell.calls[0][0] == "set -C; : > /n.txt"
    assert file.writes[0][0] == "/n.txt"
    assert base64.b64decode(file.writes[0][1]) == b"body"


def test_create_exclusive_refuses_when_the_gate_reports_the_path_exists() -> None:
    env, _, _ = _env(shell=FakeShell(lambda _c: _completed(exit_code=1)))

    with pytest.raises(ExclusiveCreateExists):
        env.create_exclusive(Path("/taken.txt"), b"body")


def test_an_indeterminate_gate_is_treated_as_exists_not_as_opened() -> None:
    """A safety branch that only works because the transport passes a missing
    exit code through: read as "opened", an existing file would be silently
    overwritten."""
    env, _, _ = _env(shell=FakeShell(lambda _c: _running()))

    with pytest.raises(ExclusiveCreateExists):
        env.create_exclusive(Path("/racy.txt"), b"body")


# --------------------------------------------------------------------------
# 98 — reads: byte-exact, and bounded
# --------------------------------------------------------------------------


def test_a_download_stream_is_reassembled_byte_exact() -> None:
    """`download_file` streams the raw bytes, which is what makes this correct
    for binary as well as text — the defect the hand-written wire had."""
    payload = bytes(range(256))
    env, _, _ = _env(file=FakeFile(reads={"/f.bin": payload}))

    assert env.read_bytes(Path("/f.bin")) == payload


def test_read_text_utf8_uses_the_native_text_endpoint() -> None:
    """0.6.1: `read_text` at the default utf-8 reads the native text endpoint
    (`file.read_file`), not the byte stream — the text endpoint's own shape."""
    file = FakeFile(text_reads={"/u.txt": "héllo wörld ✓"})
    env, _, _ = _env(file=file)

    assert env.read_text(Path("/u.txt")) == "héllo wörld ✓"
    # Went through read_file, not download_file.
    assert file.file_reads == [("/u.txt", None)]
    assert file.downloads == []


def test_read_text_non_utf8_takes_the_byte_exact_path() -> None:
    """A non-utf-8 encoding must not go through the utf-8 text endpoint: the
    parent reads exact bytes and decodes locally."""
    file = FakeFile(reads={"/latin.txt": "café".encode("latin-1")})
    env, _, _ = _env(file=file)

    assert env.read_text(Path("/latin.txt"), encoding="latin-1") == "café"
    # Went through download_file, not read_file.
    assert file.file_reads == []
    assert file.downloads == [("/latin.txt", None)]


def test_a_read_over_the_total_cap_raises_instead_of_growing() -> None:
    env, _, _ = _env(file=FakeFile(reads={"/big": b"x" * 100}), total_cap=64)

    with pytest.raises(AioSandboxError, match="total cap"):
        env.read_bytes(Path("/big"))


def test_a_missing_file_maps_to_filenotfounderror() -> None:
    """The read tool and the instruction-restore path both branch on this exact
    type, so a generic error here changes product behaviour."""
    env, _, _ = _env(
        file=FakeFile(
            errors={"/missing": ApiError(status_code=404, headers={}, body={"message": "nope"})}
        )
    )

    with pytest.raises(FileNotFoundError):
        env.read_bytes(Path("/missing"))


def test_a_forbidden_read_maps_to_permissionerror() -> None:
    env, _, _ = _env(
        file=FakeFile(
            errors={"/x": ApiError(status_code=403, headers={}, body={"message": "denied"})}
        )
    )

    with pytest.raises(PermissionError):
        env.read_bytes(Path("/x"))


def test_writes_send_base64_so_the_bytes_are_exact() -> None:
    env, _, file = _env()

    env.write_bytes(Path("/out.bin"), b"\x00\x01\x02payload")

    path, content, encoding = file.writes[0]
    assert path == "/out.bin"
    assert encoding == "base64"
    assert base64.b64decode(content) == b"\x00\x01\x02payload"


# --------------------------------------------------------------------------
# 99 — auth rides per call, not on the client
# --------------------------------------------------------------------------


def test_auth_headers_ride_as_a_per_call_request_option() -> None:
    """Per call rather than client-level state, so a credential that expires
    mid-session is minted fresh for every request."""
    env, shell, file = _env(auth_headers=lambda: {"X-AIO-API-Key": "secret"})

    env.run_argv(["echo", "x"], cwd=Path("/w"), timeout_s=10, output_cap=100)
    env.read_bytes(Path("/f"))

    assert shell.calls[0][1]["additional_headers"] == {"X-AIO-API-Key": "secret"}
    assert file.downloads[0][1]["additional_headers"] == {"X-AIO-API-Key": "secret"}


# --------------------------------------------------------------------------
# The inherited surface stays inherited
# --------------------------------------------------------------------------


def test_glob_still_expands_through_the_inherited_shell_command() -> None:
    env, shell, _ = _env(
        shell=FakeShell(lambda _c: _completed(output="/base/a.txt\n/base/b.txt\n"))
    )

    found = sorted(str(path) for path in env.glob(Path("/base"), "*.txt"))

    assert found == ["/base/a.txt", "/base/b.txt"]
    # The command shape is the parent's, unchanged by the transport swap.
    assert "globstar" in shell.calls[0][0]


def test_tree_snapshot_still_folds_the_whole_walk_into_one_exec() -> None:
    def b64(raw: bytes) -> str:
        return base64.b64encode(raw).decode("ascii")

    listing = f"F {b64(b'/r/a.txt')}\nC {b64(b'/r/SKILL.md')} {b64(b'skill body')}\n"
    env, shell, _ = _env(shell=FakeShell(lambda _c: _completed(output=listing)))

    snapshot = env.tree_snapshot([Path("/r")], content_name="SKILL.md")

    assert snapshot.files == (Path("/r/SKILL.md"), Path("/r/a.txt"))
    assert snapshot.contents == {Path("/r/SKILL.md"): b"skill body"}
    assert shell.calls[0][0].startswith("find -L /r -type f")
    assert len(shell.calls) == 1


def test_background_shell_is_refused_under_a_container() -> None:
    env, _, _ = _env()

    assert env.supports_background is False


# --------------------------------------------------------------------------
# close
# --------------------------------------------------------------------------


def test_close_is_a_no_op_for_an_injected_client_and_is_idempotent() -> None:
    """The manager duck-typed-closes an evicted backend on a teardown path, so
    a raise here would surface as a shutdown failure."""
    env, _, _ = _env()

    env.close()
    env.close()


# --------------------------------------------------------------------------
# The factory the host config takes
# --------------------------------------------------------------------------


def test_the_factory_matches_the_seam_and_wires_auth_off_the_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`HostConfig.sandbox_backend_factory` is called as
    `factory(handle, preamble)`, and the handle's `SandboxAuth` is a live
    strategy — wiring `connect_headers` rather than its *result* is what keeps
    the credential off the adapter and lets it rotate mid-session."""
    from noeta.sdk import SandboxHandle, StaticApiKeyAuth

    from noeta.agent.host.sdk_sandbox_exec_env import sdk_exec_env_factory

    handle = SandboxHandle(
        base_url=BASE,
        sandbox_id="noeta-sbx-p1",
        auth=StaticApiKeyAuth("SANDBOX_KEY_UNDER_TEST"),
        workdir="/workspace",
    )

    backend = sdk_exec_env_factory(handle, lambda _argv: "export T=1 && ")
    try:
        assert isinstance(backend, SdkSandboxExecEnv)
        assert backend._preamble is not None
        # Read at call time, not at construction: the key set now is the one
        # the next request carries.
        monkeypatch.setenv("SANDBOX_KEY_UNDER_TEST", "rotated")
        assert backend._request_options(None) == {
            "additional_headers": {"X-AIO-API-Key": "rotated"}
        }
    finally:
        backend.close()
