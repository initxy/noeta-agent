"""`SdkSandboxExecEnv` — the container fs/shell transport, over the official SDK.

The product-layer replacement for the hand-rolled `urllib` wire inside the
runtime's `AioSandboxExecEnv`: every file and shell side effect goes through the
official `agent-sandbox` client (`client.shell` / `client.file`).

**It is deliberately a thin subclass overriding only the transport
primitives** — `_shell`, `read_bytes`, `write_bytes`, and `_read_content`
(the whole-file text read). In the parent, *all* of `glob` / `rglob` /
`exists` / `is_file` / `mkdir` / `unlink` / `create_exclusive` /
`tree_snapshot` / `run_argv` are expressed on top of `_shell` /
`read_bytes` / `write_bytes`, and `read_text`'s utf-8 path on `_read_content`.
Overriding only them leaves every higher-level method — **and its exact
recorded output shape** — inherited byte-for-byte, so the event log and the
model-facing tool contract do not move while the transport does. Anything wider
would be a rewrite of the tool contract disguised as a transport change.

It also fixes a real defect at the root: the old `read_bytes` sent a
non-existent `encoding=base64` field to `/v1/file/read` and base64-decoded a
raw-text reply. `file.download_file` streams the exact bytes, correct for text
*and* binary.

## Why this module is one of the two import-boundary exemptions

`noeta.agent.*` may import only `noeta.sdk` / `noeta.presets`. This module and
`sdk_browser_backend` are the sole exceptions, declared in `pyproject.toml`'s
import-linter contract, because they **extend concrete AIO adapters the SDK
keeps off its public surface**: the surface exposes the `ExecEnv` /
`BrowserBackend` protocols and their factory types, while the concrete adapters
are slated for retirement and must not become user-facing API. The exemption
list may only shrink.

## Faults, and the one that is silent

The v1 container wire signals **most faults in-band**: HTTP 200 with
`success: false` and a `data.error_type`. The generated client parses that
without raising, so this adapter has to check explicitly. Missing the check on
`write_file` is the expensive one — `edit` / `apply_patch` would report success
with the file unchanged.

`exit_code` is passed through **only when the server reported one**. A missing
code means the command did not complete, and each inherited consumer already
applies the right default for that (the stat / unlink / mkdir /
`create_exclusive` failure branches assume 1; `run_argv` assumes 0). Normalising
it to 0 here would make `is_file()` and `exists()` answer True for a command
that never ran.
"""
from __future__ import annotations

import base64
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Callable

import httpx
from agent_sandbox import Sandbox
from agent_sandbox.core.api_error import ApiError
from noeta.sdk import BoundPreamble, ExecEnv, SandboxHandle

# The concrete AIO adapter is an SDK internal, NOT on the `noeta.sdk` public
# surface. This is one of the two import-linter exemptions (see the module
# docstring, and the contract in pyproject.toml).
from noeta.builtins.sandbox.impl.exec_env import (
    DEFAULT_AIO_TIMEOUT_S,
    AioSandboxError,
    AioSandboxExecEnv,
)

__all__ = ["SdkSandboxExecEnv", "sdk_exec_env_factory"]

#: Cap on one read's reassembled bytes, matching the bound the urllib backend
#: put on a response body. A huge container file must raise cleanly rather than
#: exhaust host memory. (The parent's own constant is private and this layer
#: cannot import it, so the value is restated.)
_DEFAULT_TOTAL_CAP = 32 * 1024 * 1024

#: In-band `data.error_type` → the stdlib `OSError` subclass the fs tools branch
#: on, so a remote fault is indistinguishable from the local backend's.
_ERROR_TYPES: dict[str, type[OSError]] = {
    "not_found": FileNotFoundError,
    "permission_denied": PermissionError,
    "already_exists": FileExistsError,
}


class SdkSandboxExecEnv(AioSandboxExecEnv):
    """`ExecEnv` over the `agent-sandbox` client.

    Overrides the transport primitives and nothing else; every other
    method is inherited unchanged."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        auth_headers: Callable[[], Mapping[str, str]] | None = None,
        preamble: Callable[[Sequence[str]], str] | None = None,
        timeout_s: float = DEFAULT_AIO_TIMEOUT_S,
        total_cap: int = _DEFAULT_TOTAL_CAP,
        client: Sandbox | None = None,
    ) -> None:
        if not base_url:
            raise AioSandboxError("aio sandbox base_url is empty")
        # `super().__init__` is deliberately NOT called: it builds the urllib
        # transport this subclass exists to replace. Only the attributes the
        # inherited methods actually read are set — `_preamble` (`run_argv`) and
        # `_total_cap` — plus our own `_auth_headers`. The `_call` override
        # below is what turns any future bypass of the three primitives into a
        # self-describing failure rather than an AttributeError on the parent
        # attributes this constructor never sets.
        self._preamble = preamble
        self._auth_headers = auth_headers
        self._total_cap = total_cap
        static_headers: dict[str, str] = {}
        if api_key:
            static_headers["X-AIO-API-Key"] = api_key
        # `trust_env=False`: the container is at 127.0.0.1, and an ambient
        # HTTP(S)_PROXY that routes a loopback call makes it hang rather than
        # fail. An injected `client` is the test seam; `_httpx_client` is kept
        # only when this instance built (and therefore owns) the pool, so
        # `close` never touches an injected one.
        self._httpx_client: httpx.Client | None = None
        if client is None:
            self._httpx_client = httpx.Client(timeout=timeout_s, trust_env=False)
            client = Sandbox(
                base_url=base_url.rstrip("/"),
                headers=static_headers or None,
                httpx_client=self._httpx_client,
            )
        self._client: Sandbox = client

    def close(self) -> None:
        """Release the owned connection pool. Idempotent, never raises.

        The SDK's manager duck-typed-closes an evicted backend, and that path
        is a teardown — a raise there would surface as a shutdown failure."""
        if self._httpx_client is not None:
            try:
                self._httpx_client.close()
            except Exception:  # noqa: BLE001 - teardown must not raise
                pass

    # -- per-call request options ----------------------------------------- #

    def _request_options(self, timeout_s: float | None) -> dict[str, Any] | None:
        """Timeout and auth for one call.

        Auth rides as a **per-call** request option rather than client-level
        state, so a credential that expires mid-session is minted fresh for
        every request and never held on a long-lived object."""
        options: dict[str, Any] = {}
        if timeout_s is not None:
            options["timeout_in_seconds"] = int(timeout_s)
        if self._auth_headers is not None:
            headers = self._auth_headers()
            if headers:
                options["additional_headers"] = dict(headers)
        return options or None

    # -- fault mapping ----------------------------------------------------- #

    @staticmethod
    def _api_error_message(exc: ApiError) -> str:
        body = exc.body
        if isinstance(body, Mapping):
            message = body.get("message")
            if isinstance(message, str) and message:
                return message
        if isinstance(body, str) and body:
            return body
        return f"request failed (status {exc.status_code})"

    def _file_error(self, exc: ApiError, path: Path) -> OSError:
        """An SDK file `ApiError` → the `OSError` subclass the tools expect.

        `404` **must** become `FileNotFoundError`: the read tool and the
        instruction-restore path both branch on it."""
        message = self._api_error_message(exc)
        if exc.status_code == 404:
            return FileNotFoundError(f"{path}: {message}")
        if exc.status_code in (401, 403):
            return PermissionError(f"{path}: {message}")
        return AioSandboxError(f"{path}: {message}")

    @staticmethod
    def _response_failure(response: Any, context: str) -> OSError:
        """A 2xx `success: false` reply → the `OSError` subclass tools expect.

        `error_type` is not a declared field of the generated models; `getattr`
        reads it off the `extra="allow"` model. Without one, degrade to a
        generic sandbox error carrying the server's message."""
        message = getattr(response, "message", None) or f"{context}: request failed"
        error_type = getattr(getattr(response, "data", None), "error_type", None)
        return _ERROR_TYPES.get(error_type or "", AioSandboxError)(message)

    def _call(
        self, path: str, body: dict[str, Any], *, timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Tripwire: this subclass has no urllib wire.

        Every inherited method reaches its transport through `_shell` /
        `read_bytes` / `write_bytes` / `_read_content`, all overridden below. If
        a future parent change calls `_call` directly, fail with the diagnosis
        instead of an AttributeError on attributes `__init__` deliberately never
        sets."""
        raise AioSandboxError(
            f"SdkSandboxExecEnv has no urllib wire for {path}: a new "
            "AioSandboxExecEnv method bypassed _shell/read_bytes/write_bytes"
        )

    # -- the three transport primitives ------------------------------------ #

    def _shell(
        self, command: str, *, timeout_s: float | None = None
    ) -> dict[str, Any]:
        """Run `command`, returning the dict the inherited methods parse.

        The shape is `{"output", "exit_code"?, "full_output_file_path"?}` — the
        same one the old `/v1/shell/exec` `data` object had, so nothing above
        the seam notices the swap."""
        try:
            response = self._client.shell.exec_command(
                command=command, request_options=self._request_options(timeout_s)
            )
        except httpx.TimeoutException as exc:
            # Surfaced as the builtin TimeoutError so `run_argv` classifies a
            # wedged command as a *timed-out* run; every other caller sees an
            # OSError either way.
            raise TimeoutError(f"/v1/shell/exec timed out: {exc}") from exc
        except ApiError as exc:
            raise AioSandboxError(
                f"/v1/shell/exec: {self._api_error_message(exc)}"
            ) from exc
        except AioSandboxError:
            raise
        except Exception as exc:  # noqa: BLE001 - any other transport fault
            raise AioSandboxError(f"/v1/shell/exec: transport error: {exc}") from exc
        if response.success is False:
            raise self._response_failure(response, "/v1/shell/exec")
        data = response.data
        if data is None:
            raise AioSandboxError("/v1/shell/exec: response missing data")
        result: dict[str, Any] = {"output": data.output}
        # Only when the server reported one — see the module docstring. A
        # missing code means the command did not complete, and each inherited
        # consumer has its own default for that.
        if data.exit_code is not None:
            result["exit_code"] = data.exit_code
        # `full_output_file_path` is not a declared field of the generated shell
        # result model; it survives only because the models allow extras. The
        # spilled full output is read from it by the inherited `_read_spill`.
        spill = getattr(data, "full_output_file_path", None)
        if isinstance(spill, str) and spill:
            result["full_output_file_path"] = spill
        return result

    def read_bytes(self, path: Path) -> bytes:
        """Read raw file bytes via `file.download_file`.

        The stream is reassembled byte-exact and bounded at `total_cap`, so a
        huge container file raises cleanly instead of exhausting host memory."""
        try:
            buffer = bytearray()
            for chunk in self._client.file.download_file(
                path=str(path), request_options=self._request_options(None)
            ):
                buffer.extend(chunk)
                if len(buffer) > self._total_cap:
                    raise AioSandboxError(f"read {path}: response exceeded total cap")
            return bytes(buffer)
        except ApiError as exc:
            raise self._file_error(exc, path) from exc
        except AioSandboxError:
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"read {path} timed out: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - any other transport fault
            raise AioSandboxError(f"read {path}: transport error: {exc}") from exc

    def _read_content(self, path: Path | str) -> str:
        """Whole-file text via `file.read_file` — the native `/v1/file/read`.

        The parent's 0.6.1 `read_text` splits utf-8 (this native text endpoint)
        from every other encoding (byte-exact `read_bytes` + local decode). It
        reaches the text path through `_read_content`, which upstream calls
        `_call("/v1/file/read")`; this subclass has no urllib wire, so the one
        method that used it is overridden to the SDK client's `read_file`.
        Fault mapping mirrors `read_bytes`: an `ApiError` becomes the matching
        `OSError`, and an in-band `success: false` maps by `error_type`."""
        try:
            response = self._client.file.read_file(
                file=str(path), request_options=self._request_options(None)
            )
        except ApiError as exc:
            raise self._file_error(exc, Path(path)) from exc
        except AioSandboxError:
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"read {path} timed out: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - any other transport fault
            raise AioSandboxError(f"read {path}: transport error: {exc}") from exc
        if response.success is False:
            raise self._response_failure(response, f"read {path}")
        content = getattr(response.data, "content", None)
        if not isinstance(content, str):
            raise AioSandboxError(f"read {path}: response missing 'content'")
        return content

    def write_bytes(self, path: Path, body: bytes) -> None:
        try:
            response = self._client.file.write_file(
                file=str(path),
                content=base64.b64encode(body).decode("ascii"),
                encoding="base64",
                request_options=self._request_options(None),
            )
        except ApiError as exc:
            raise self._file_error(exc, path) from exc
        except AioSandboxError:
            raise
        except httpx.TimeoutException as exc:
            raise TimeoutError(f"write {path} timed out: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - any other transport fault
            raise AioSandboxError(f"write {path}: transport error: {exc}") from exc
        if response.success is False:
            # The in-band failure channel. Dropping it silently is what lets
            # edit / apply_patch report success with the file unchanged.
            raise self._response_failure(response, f"write {path}")


def sdk_exec_env_factory(
    handle: SandboxHandle, preamble: BoundPreamble | None = None
) -> ExecEnv:
    """`HostConfig.sandbox_backend_factory` over this adapter.

    The handle's live `SandboxAuth` is wired in as the per-call header factory,
    so the credential is fetched fresh on the wire for every request and never
    held on a durable object."""
    return SdkSandboxExecEnv(
        base_url=handle.base_url,
        auth_headers=handle.auth.connect_headers,
        preamble=preamble,
    )
