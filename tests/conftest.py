"""The Python test harness.

Four things live here, and each one is a scar rather than a preference.

**A real uvicorn, never starlette's `TestClient`.** `TestClient` does not truly
stream a response body; the SSE endpoint is an infinite stream, so consuming it
synchronously blocks forever. The harness boots uvicorn on `127.0.0.1:0` in a
daemon thread with `lifespan="on"`, polls for the bound socket, and reads the
port back **off that socket** — never guessing or pre-picking one, which races
with anything else on the machine.

**Settings are constructed and injected, never read from the developer's
`.env`.** Anything that parses `.env` on first touch contaminates every test on
a machine that happens to have a real gateway, a real secondary gateway, or a
retired key configured. `make_settings` builds a `Settings(_env_file=None, …)`
from an explicit baseline, and `_isolated_env` strips every key the model reads
out of the ambient environment first.

**The baseline is deliberate, key by key** (see `make_settings`).

**Two helpers Phase 1 depends on**: the SSE reader (`SSEReader` /
`parse_sse_lines`), whose framing rules are pinned by `tests/test_sse_reader.py`
today, and `wait_status`, which polls the session detail endpoint Phase 1
introduces.

**No test can reach Docker.** The tier used to be the global `SANDBOX_ENABLED`,
which the harness forced off so a developer running Docker locally could not
change the test baseline. The key is gone and the tier is now a per-project
column, so the isolation is re-established one layer down: every app this
harness boots installs its engine runtime with `sandbox=None`, so no container
provider is wired at all and a project that somehow asked for the sandbox tier
would run local rather than provisioning. `store.projects.create_project`
defaults to `tier="local"`, so nothing asks for it in the first place.
"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastapi import FastAPI

from noeta.agent import config as config_module
from noeta.agent.api.runtime import install_runtime
from noeta.agent.config import Settings
from noeta.agent.main import create_app

# The checkout root, derived from this file so the suite does not care what
# directory pytest was invoked from.
REPO_ROOT = Path(__file__).resolve().parents[1]

# How long to wait for uvicorn's listening socket before declaring boot failed.
SERVER_BOOT_TIMEOUT = 15.0

# The whole session status vocabulary. `wait_status` rejects anything else, so a
# typo in an expected status fails immediately instead of polling for 15s.
SESSION_STATUSES = frozenset({"idle", "running", "waiting"})

STATUS_POLL_INTERVAL = 0.05
STATUS_TIMEOUT = 15.0

# SSE field separator: key, colon, EXACTLY ONE SPACE. Emitters write `id: 12`,
# never `id:12`, and the reader splits on this literal so a drifting emitter
# fails loudly here rather than confusing a downstream assertion.
SSE_FIELD_SEPARATOR = ": "

# Every environment variable `Settings` can read, so the suite starts from a
# machine-independent baseline.
_SETTINGS_ENV_KEYS = tuple(sorted(name.upper() for name in Settings.model_fields))

# Honoured as a fallback by `otlp_headers`, and its endpoint sibling, which is
# deliberately NOT an enable switch — clear both so neither can be mistaken for
# one on a machine where an operator injected them.
#: `SANDBOX_API_KEY` is the *value* behind `Settings.sandbox_api_key_env` (which
#: holds only the name), so it is not in `_SETTINGS_ENV_KEYS` — yet the sandbox
#: provider reads `os.environ` directly to decide whether to pass a credential
#: into `docker run`. A developer who actually runs a sandbox would otherwise
#: shift the baseline.
_AMBIENT_ENV_KEYS = (
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "SANDBOX_API_KEY",
)

# Retired keys. `extra="ignore"` means they cannot break construction, but a
# developer `.env` still carrying them must not be able to imply otherwise.
_RETIRED_ENV_KEYS = ("SANDBOX_ENABLED", "ADMIN_USERS", "SESSION_SECRET")


# ---------------------------------------------------------------------------
# Environment isolation and settings
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip every key `Settings` reads out of the ambient environment.

    Autouse and unconditional: a test that wants a key set does so itself, and
    then it is testing that key rather than inheriting it."""
    for key in _SETTINGS_ENV_KEYS + _AMBIENT_ENV_KEYS + _RETIRED_ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    # `get_settings` is lru_cached and is the one function allowed to read the
    # developer's .env; a stray call must not leak its result into the next test.
    config_module.get_settings.cache_clear()


@pytest.fixture
def make_settings(tmp_path: Path) -> Callable[..., Settings]:
    """Build a `Settings` from the test baseline, with overrides.

    Why each baseline value is what it is:

    - `llm_provider="mock"` plus empty gateway keys — the suite never reaches a
      network, and the mock is a real product feature, not a stub.
    - **The secondary gateway keys are cleared explicitly.** A developer machine
      may have a real one configured, and routing behaves differently when it is
      present.
    - `data_dir` under `tmp_path` — every test gets an empty data tree, so the
      suite passes on a second consecutive run, not only on a clean checkout.
    - `models_config` pinned to the checkout's **`models.json.example`**. Not
      the relative default, which would resolve against pytest's working
      directory — and deliberately not the developer's own `models.json`,
      which is gitignored (deployment-specific ids), so a suite that read it
      would assert against a file CI does not have and every machine spells
      differently. The example is tracked, neutral, and shipped, so pinning it
      also keeps it honest: a broken example now fails the suite.
    - `memory_consolidation=False` — the first turn boundary is immediately due
      (no debounce marker exists yet), so leaving it on spawns a background
      curation task in *every* test.
    """

    def _make(**overrides: Any) -> Settings:
        baseline: dict[str, Any] = {
            "llm_provider": "mock",
            "llm_base_url": "",
            "llm_api_key": "",
            "secondary_llm_base_url": "",
            "secondary_llm_api_key": "",
            "data_dir": str(tmp_path / "data"),
            "projects_dir": str(tmp_path / "projects"),
            "models_config": str(REPO_ROOT / "models.json.example"),
            "memory_consolidation": False,
        }
        baseline.update(overrides)
        return Settings(_env_file=None, **baseline)

    return _make


@pytest.fixture
def settings(make_settings: Callable[..., Settings]) -> Settings:
    return make_settings()


def build_app(settings: Settings, **runtime: Any) -> FastAPI:
    """The application under test, with the engine runtime re-installed.

    Always with injected settings — a bare `create_app()` falls back to
    `get_settings()` and reads the real `.env`. `create_app` installs the
    configured runtime itself; installing over it **replaces** the plan (it
    never nests), which is how the suite pins `sandbox=None` and how a test
    that wants a scripted provider swaps one in."""
    app = create_app(settings)
    install_runtime(app, settings, sandbox=None, **runtime)
    return app


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return build_app(settings)


# ---------------------------------------------------------------------------
# A real uvicorn on an ephemeral port
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LiveServer:
    """A booted backend: its base URL and the settings it was built from."""

    base_url: str
    settings: Settings


def _await_bound_port(server: uvicorn.Server, thread: threading.Thread) -> int:
    """The port uvicorn actually bound, read off the socket itself.

    Port 0 means the kernel picks, so the number is only knowable after the
    bind. Anything that pre-picks a port races with whatever else is on the
    machine, and the failure looks like a flaky test rather than a busy port."""
    deadline = time.monotonic() + SERVER_BOOT_TIMEOUT
    while time.monotonic() < deadline:
        for bound in getattr(server, "servers", ()) or ():
            for sock in bound.sockets:
                return int(sock.getsockname()[1])
        if not thread.is_alive():
            raise RuntimeError("uvicorn thread exited before binding a socket")
        time.sleep(0.01)
    raise RuntimeError(f"uvicorn did not bind a socket within {SERVER_BOOT_TIMEOUT}s")


@contextmanager
def serve_app(app: FastAPI, settings: Settings) -> Iterator[LiveServer]:
    """Run `app` on an ephemeral port for the duration of the block.

    `lifespan="on"` is required, not incidental: everything with a process
    lifetime (the database connection, and from Phase 1 the engine Client) is
    acquired in the lifespan, so a harness that skips it tests a different
    application than the one that ships."""
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=0,
        lifespan="on",
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="test-uvicorn", daemon=True)
    thread.start()
    try:
        port = _await_bound_port(server, thread)
        yield LiveServer(base_url=f"http://127.0.0.1:{port}", settings=settings)
    finally:
        server.should_exit = True
        thread.join(timeout=10.0)


@pytest.fixture
def serve() -> Iterator[Callable[[Settings], LiveServer]]:
    """Boot a backend from arbitrary settings, torn down at test end.

    Use this when the test is *about* a configuration; use `live_server` when
    the baseline will do."""
    with ExitStack() as stack:

        def _serve(settings: Settings) -> LiveServer:
            return stack.enter_context(serve_app(build_app(settings), settings))

        yield _serve


@pytest.fixture
def live_server(app: FastAPI, settings: Settings) -> Iterator[LiveServer]:
    with serve_app(app, settings) as server:
        yield server


@pytest.fixture
def http(live_server: LiveServer) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=live_server.base_url, timeout=10.0) as client:
        yield client


# ---------------------------------------------------------------------------
# SSE
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SSEFrame:
    """One dispatched SSE frame. `seq` is `None` when the frame carried no
    `id:` line — which is the normal, load-bearing case for deltas and every
    synthetic frame, not an error."""

    event: str | None
    data: Any
    seq: int | None


def _build_frame(fields: dict[str, str]) -> SSEFrame | None:
    if not fields:
        return None
    raw = fields.get("data")
    data: Any = None
    if raw is not None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AssertionError(
                f"`data` must be single-line JSON, got {raw!r}"
            ) from exc
    seq_raw = fields.get("id")
    return SSEFrame(
        event=fields.get("event"),
        data=data,
        seq=int(seq_raw) if seq_raw is not None else None,
    )


def parse_sse_lines(
    lines: Iterable[str],
    *,
    limit: int | None = None,
    until: Callable[[SSEFrame], bool] | None = None,
) -> list[SSEFrame]:
    """Parse decoded SSE lines into frames.

    The rules, all of them pinned by `tests/test_sse_reader.py`:

    - a blank line terminates a frame;
    - a line starting with `:` is a comment (the heartbeat, and the `: connected`
      preamble) and is skipped;
    - every other line splits on `": "` exactly once — a line without that
      separator is an emitter bug and fails here, loudly;
    - `data` must be single-line JSON;
    - a frame with no `id:` line yields `seq = None`.

    **On read timeout it returns what it has** instead of raising. That single
    property is what makes a test that expected an event and got nothing fail on
    *content* — `assert frames == [...]`, showing exactly what did arrive —
    rather than on a timeout traceback that says nothing about the bug."""
    frames: list[SSEFrame] = []
    fields: dict[str, str] = {}
    try:
        for raw_line in lines:
            line = raw_line.rstrip("\r\n")
            if line.startswith(":"):
                continue
            if not line:
                frame = _build_frame(fields)
                fields = {}
                if frame is None:
                    continue
                frames.append(frame)
                if until is not None and until(frame):
                    return frames
                if limit is not None and len(frames) >= limit:
                    return frames
                continue
            key, separator, value = line.partition(SSE_FIELD_SEPARATOR)
            assert separator, (
                f"SSE line {line!r} does not use the {SSE_FIELD_SEPARATOR!r} "
                "separator — emit `id: 12`, not `id:12`"
            )
            assert key not in fields, (
                f"repeated {key!r} field in one frame; multi-line `data` is not "
                "part of this contract"
            )
            fields[key] = value
    except (httpx.TimeoutException, TimeoutError):
        # Deliberate. See the docstring: content failures beat timeout tracebacks.
        pass
    return frames


@dataclass(frozen=True)
class SSEReader:
    """Reads an SSE endpoint off a live server.

    Separate from `parse_sse_lines` so the framing rules can be pinned without a
    server, and so the transport can be swapped without touching them."""

    base_url: str

    def read(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        limit: int | None = None,
        until: Callable[[SSEFrame], bool] | None = None,
        timeout: float = 5.0,
    ) -> list[SSEFrame]:
        """Read frames until `until` matches, `limit` is reached, the stream
        ends, or `timeout` seconds pass with no data — whichever comes first.

        `timeout` is the *read* timeout, so it bounds silence rather than the
        whole call: a stream that keeps delivering is never cut short."""
        timeouts = httpx.Timeout(connect=5.0, read=timeout, write=5.0, pool=5.0)
        with httpx.Client(base_url=self.base_url, timeout=timeouts) as client:
            with client.stream("GET", path, params=params) as response:
                response.raise_for_status()
                return parse_sse_lines(response.iter_lines(), limit=limit, until=until)


@pytest.fixture
def sse(live_server: LiveServer) -> SSEReader:
    return SSEReader(live_server.base_url)


# ---------------------------------------------------------------------------
# Status polling
# ---------------------------------------------------------------------------


def wait_status(
    http: httpx.Client,
    session_id: str,
    expected: str | Sequence[str],
    *,
    timeout: float = STATUS_TIMEOUT,
    interval: float = STATUS_POLL_INTERVAL,
) -> str:
    """Poll the session detail endpoint until its status is one of `expected`.

    The status vocabulary is exactly `idle` / `running` / `waiting`, and an
    unknown expectation is rejected up front rather than polled for 15s.

    Turns run on engine worker threads while the request that started them has
    already returned, so there is no request whose completion means "the turn is
    over" — polling is the honest way to wait, and 50 ms is short enough that
    the wait does not dominate a test."""
    wanted = {expected} if isinstance(expected, str) else set(expected)
    unknown = wanted - SESSION_STATUSES
    assert not unknown, f"not session statuses: {sorted(unknown)}"

    deadline = time.monotonic() + timeout
    last: str | None = None
    while time.monotonic() < deadline:
        response = http.get(f"/api/v1/sessions/{session_id}")
        if response.status_code == 200:
            last = response.json().get("status")
            if last in wanted:
                return last
        else:
            last = f"HTTP {response.status_code}"
        time.sleep(interval)
    raise AssertionError(
        f"session {session_id} was {last!r} and never reached "
        f"{sorted(wanted)} within {timeout}s"
    )
