"""The preview gateway — `LEDGER §9.9` rows 57-62.

Row 63 is the WebSocket ordering rule and lives in `tests/test_ws_proxy.py`.

Two of these are security properties rather than features, and both are stated
as tests because both are the kind of thing a later refactor "simplifies" away:

- **the preview origin is blank.** It answers `/sandbox-preview/<valid-token>/*`
  and nothing else — not `/`, not an unknown token, not the main port's API
  paths. That blankness is what makes it safe to give the panels
  `allow-same-origin`, which noVNC and code-server require.
- **no CORS headers on it, ever**, and the container credential appears only on
  the gateway-to-container leg. The browser holds the token and nothing else.
"""
from __future__ import annotations

import socket
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator, Optional

import httpx
import pytest

from noeta.agent.api.runtime import install_runtime
from noeta.agent.config import Settings
from noeta.agent.host.preview_gateway import (
    MOUNT_LIMIT,
    PreviewGateway,
    panel_paths,
)
from noeta.agent.host.reaper import SandboxIdleReaper
from noeta.agent.host.sandbox import SandboxTier, sandbox_spec
from noeta.agent.main import create_app
from tests.conftest import serve_app

TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# A fake container fronting plain HTTP
# ---------------------------------------------------------------------------


@dataclass
class Recorded:
    path: str
    headers: dict[str, str]


class FakeContainer:
    """One HTTP listener standing in for the AIO sandbox's single port."""

    def __init__(self) -> None:
        self.requests: list[Recorded] = []
        #: Set to make the container answer with a root-relative redirect, the
        #: shape code-server actually returns for `/code-server/`.
        self.redirect_to: Optional[str] = None
        #: Set to make the container emit CORS headers, so the gateway's own
        #: refusal to relay them can be asserted rather than assumed.
        self.cors = False
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                recorder.requests.append(
                    Recorded(
                        path=self.path,
                        headers={k.lower(): v for k, v in self.headers.items()},
                    )
                )
                if recorder.redirect_to is not None:
                    self.send_response(302)
                    self.send_header("Location", recorder.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = f"served {self.path}".encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                if recorder.cors:
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = int(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture
def container() -> Iterator[FakeContainer]:
    fake = FakeContainer()
    try:
        yield fake
    finally:
        fake.close()


@pytest.fixture
def gateway() -> Iterator[PreviewGateway]:
    gate = PreviewGateway()
    assert gate.serve() is not None
    try:
        yield gate
    finally:
        gate.close()


@pytest.fixture
def fetch(gateway: PreviewGateway) -> Callable[..., httpx.Response]:
    """A GET against the preview origin, redirects left alone.

    Following them would hide the one thing worth checking about a redirect:
    whether the rewritten `Location` stays inside the token prefix."""

    def _get(path: str, **kwargs: Any) -> httpx.Response:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{gateway.port}",
            timeout=TIMEOUT,
            follow_redirects=False,
        ) as client:
            return client.get(path, **kwargs)

    return _get


# ---------------------------------------------------------------------------
# Row 57 / 58 / 59 — the registry
# ---------------------------------------------------------------------------


def test_roots_of_one_session_share_one_token_and_only_the_last_release_unmounts(
    gateway: PreviewGateway,
):
    """Row 57. Under D2 one container serves every session of a project, and a
    session can hold several task streams — so unmounting on the first release
    would blank a panel another stream is still using."""
    first = gateway.mount_root("task-a", "sess", "http://127.0.0.1:9")
    second = gateway.mount_root("task-b", "sess", "http://127.0.0.1:9")

    assert first == second

    gateway.release_root("task-a")
    assert gateway.lookup(first) is not None

    gateway.release_root("task-b")
    assert gateway.lookup(first) is None


def test_a_rebuilt_container_rotates_the_token_and_404s_the_old_one(
    gateway: PreviewGateway, fetch: Callable[..., httpx.Response]
):
    """Row 58. A rebuilt container comes up on a *different* host port, so a
    stale iframe holding the old token must fail rather than quietly attach to
    whatever now listens there."""
    old = gateway.mount_root("task-a", "sess", "http://127.0.0.1:9001")
    new = gateway.mount_root("task-a", "sess", "http://127.0.0.1:9002")

    assert new != old
    assert gateway.lookup(old) is None
    assert fetch(f"/sandbox-preview/{old}/anything").status_code == 404


def test_lazy_mount_is_idempotent_and_release_falls_back_to_the_session_key(
    gateway: PreviewGateway,
):
    """Row 59. After a process restart requeued tasks take the `attach` path
    and fire no allocate listener, so discovery mounts on the spot — with no
    root to hold it. Release has to work anyway, keyed on the session."""
    first = gateway.mount_session("sess", "http://127.0.0.1:9")
    second = gateway.mount_session("sess", "http://127.0.0.1:9")

    assert first == second

    gateway.release_root("task-never-allocated", session_id="sess")
    assert gateway.lookup(first) is None


def test_unmount_session_ignores_the_refcount(gateway: PreviewGateway):
    """The deletion path: the session is gone, so its mount goes with it
    however many roots still claim to hold it."""
    token = gateway.mount_root("task-a", "sess", "http://127.0.0.1:9")
    gateway.mount_root("task-b", "sess", "http://127.0.0.1:9")

    gateway.unmount_session("sess")

    assert gateway.lookup(token) is None


def test_the_mount_limit_evicts_the_oldest(gateway: PreviewGateway):
    """Nothing else expires a token — a session whose container the idle sweep
    reaped leaves its mount behind — so without a bound they accumulate for the
    lifetime of the process."""
    tokens = [
        gateway.mount_session(f"sess-{index}", f"http://127.0.0.1:{9000 + index}")
        for index in range(MOUNT_LIMIT + 3)
    ]

    assert [t for t in tokens if gateway.lookup(t) is not None] == tokens[3:]


# ---------------------------------------------------------------------------
# Row 60 — the panel URL shapes
# ---------------------------------------------------------------------------


def test_the_three_panel_url_shapes(gateway: PreviewGateway):
    """Row 60. Each quirk is real and pinned against the live image:

    - the explicit `path=` query, because the container serves websockify at
      the root and noVNC's default absolute path would escape the prefix;
    - **no** trailing slash on the terminal, because the page resolves its PTY
      WebSocket relative to the URL;
    - a trailing slash on code-server, because its asset URLs are relative.
    """
    panels = panel_paths("TOK")

    assert panels["browser"] == (
        "/sandbox-preview/TOK/vnc/index.html"
        "?autoconnect=true&resize=scale&path=sandbox-preview/TOK/websockify"
    )
    assert panels["terminal"] == "/sandbox-preview/TOK/terminal"
    assert not panels["terminal"].endswith("/")
    assert panels["code"] == "/sandbox-preview/TOK/code-server/"
    assert panels["code"].endswith("/")


# ---------------------------------------------------------------------------
# Row 61 — no CORS, and the credential stays on the container leg
# ---------------------------------------------------------------------------


def test_the_credential_is_fetched_fresh_and_never_reaches_the_browser(
    gateway: PreviewGateway, container: FakeContainer, fetch: Callable[..., httpx.Response]
):
    """Row 61. The auth callable is read **per request**, so rotating the
    container secret takes effect without re-mounting — and the value rides
    only the gateway-to-container leg. Header names are compared lowercased:
    urllib normalizes case and an exact-case assertion would pass by luck."""
    secret = {"value": "first"}
    token = gateway.mount_session(
        "sess", container.base_url, lambda: {"X-Api-Key": secret["value"]}
    )

    first = fetch(f"/sandbox-preview/{token}/v1/sandbox")
    secret["value"] = "rotated"
    second = fetch(f"/sandbox-preview/{token}/v1/sandbox")

    assert first.status_code == 200 and second.status_code == 200
    assert [r.headers.get("x-api-key") for r in container.requests] == [
        "first",
        "rotated",
    ]
    # The browser never sees it.
    for response in (first, second):
        assert not [name for name in response.headers if "api-key" in name.lower()]


def test_no_cors_headers_on_the_preview_origin(
    gateway: PreviewGateway, container: FakeContainer, fetch: Callable[..., httpx.Response]
):
    """Row 61. The panels are same-origin with this port, so they never need a
    CORS header — and relaying one the container emitted would hand its
    responses to any page on the internet."""
    container.cors = True
    token = gateway.mount_session("sess", container.base_url)

    response = fetch(f"/sandbox-preview/{token}/index.html")

    assert response.status_code == 200
    assert not [
        name for name in response.headers if name.lower().startswith("access-control-")
    ]


def test_browser_context_headers_are_not_forwarded_into_the_container(
    gateway: PreviewGateway, container: FakeContainer, fetch: Callable[..., httpx.Response]
):
    """`origin`, `referer` and `cookie` describe the browser's relationship
    with *this* origin; forwarding them leaks it into the container."""
    token = gateway.mount_session("sess", container.base_url)

    fetch(
        f"/sandbox-preview/{token}/index.html",
        headers={
            "Origin": "http://localhost:8000",
            "Referer": "http://localhost:8000/",
            "Cookie": "session=abc",
            "X-Kept": "yes",
        },
    )

    seen = container.requests[-1].headers
    assert "origin" not in seen
    assert "referer" not in seen
    assert "cookie" not in seen
    assert seen["x-kept"] == "yes"


# ---------------------------------------------------------------------------
# Row 62 — the origin is blank
# ---------------------------------------------------------------------------


def test_the_preview_port_serves_only_valid_token_paths(
    gateway: PreviewGateway, container: FakeContainer, fetch: Callable[..., httpx.Response]
):
    """Row 62, and the security property the whole separate port exists for.

    An `allow-same-origin` iframe is same-origin with whatever serves it, so
    this origin must have nothing on it worth reaching."""
    token = gateway.mount_session("sess", container.base_url)

    assert fetch(f"/sandbox-preview/{token}/ok").status_code == 200
    for blank in (
        "/",
        "/index.html",
        "/api/v1/sessions",
        "/sandbox-preview/",
        "/sandbox-preview/not-a-token/anything",
    ):
        assert fetch(blank).status_code == 404, blank


def test_an_unreachable_container_is_502(
    gateway: PreviewGateway, fetch: Callable[..., httpx.Response]
):
    """Distinct from the 404: the token is real, the container is not."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        dead = int(sock.getsockname()[1])
    token = gateway.mount_session("sess", f"http://127.0.0.1:{dead}")

    response = fetch(f"/sandbox-preview/{token}/anything")

    assert response.status_code == 502
    assert response.json() == {"error": "sandbox unreachable"}


def test_a_container_redirect_is_kept_inside_the_token_prefix(
    gateway: PreviewGateway, container: FakeContainer, fetch: Callable[..., httpx.Response]
):
    """code-server answers its entry point with a root-relative redirect. An
    absolute path on this origin that is not under the prefix is a 404, so
    relaying it untouched would kill the panel on its first request."""
    container.redirect_to = "/code-server/?folder=/home/gem"
    token = gateway.mount_session("sess", container.base_url)

    response = fetch(f"/sandbox-preview/{token}/code-server/")

    assert response.status_code == 302
    assert response.headers["location"] == (
        f"/sandbox-preview/{token}/code-server/?folder=/home/gem"
    )


# ---------------------------------------------------------------------------
# A bind failure must cost the panels, never the conversation
# ---------------------------------------------------------------------------


def test_a_bind_failure_is_survivable():
    """The agent path does not depend on the preview origin existing. A busy
    port is logged, `port` is `None`, and the client hides the panels."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as taken:
        taken.bind(("127.0.0.1", 0))
        taken.listen(1)
        busy = int(taken.getsockname()[1])

        gateway = PreviewGateway(port=busy)
        try:
            assert gateway.serve() is None
            assert gateway.port is None
            # The registry still works; only the transport is missing.
            assert gateway.mount_session("sess", "http://127.0.0.1:9")
        finally:
            gateway.close()


# ---------------------------------------------------------------------------
# Discovery through the API
# ---------------------------------------------------------------------------


class FakeProvider:
    """Stands in for `LocalDockerSandboxProvider` at the one method discovery
    calls. Nothing here reaches Docker."""

    def __init__(self, handle: Any = None) -> None:
        self.handle = handle
        self.asked: list[str] = []

    def live_handle(self, container_id: str) -> Any:
        self.asked.append(container_id)
        return self.handle

    # The reaper's surface, never exercised here.
    def force_release(self, container_id: str) -> None: ...

    def stop_idle(self, container_id: str) -> bool:
        return False


def fake_tier(settings: Settings, handle: Any) -> SandboxTier:
    provider = FakeProvider(handle)
    reaper = SandboxIdleReaper.from_hours(
        provider=provider,
        activity=lambda: [],
        stop_hours=0.0,
        remove_hours=0.0,
        check_interval_hours=1.0,
    )
    return SandboxTier(provider=provider, spec=sandbox_spec(settings), reaper=reaper)


@contextmanager
def sandbox_api(settings: Settings, handle: Any) -> Iterator[httpx.Client]:
    """A booted backend whose sandbox tier is a fake with a live handle.

    The shared `build_app` pins `sandbox=None` so no test can reach Docker;
    this one needs a *tier* and gets one that reaches Docker even less — a fake
    provider answering the single method discovery calls. `install_runtime`
    replaces the plan rather than nesting, so installing over the factory's own
    is the supported way to swap it.

    The yielded client carries the `app` on `client.app` — a test that needs to
    read what the lazy discovery built (the gateway, say) reaches it there rather
    than through a second boot."""
    app = create_app(settings)
    install_runtime(app, settings, sandbox=fake_tier(settings, handle))
    try:
        with serve_app(app, settings) as server:
            with httpx.Client(base_url=server.base_url, timeout=TIMEOUT) as client:
                client.app = app  # type: ignore[attr-defined]  # test-only handle
                yield client
    finally:
        # The gateway is created lazily by the first discovery call and its
        # server thread is a daemon, so nothing else would ever release the
        # port it bound. Real processes exit; a test process runs on.
        lazy = getattr(app.state, "preview_gateway", None)
        if lazy is not None:
            lazy.close()


def _project(client: httpx.Client, directory: Path, tier: str) -> dict[str, Any]:
    directory.mkdir(parents=True, exist_ok=True)
    response = client.post(
        "/api/v1/projects",
        json={"name": directory.name, "directory": str(directory), "tier": tier},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _session(client: httpx.Client, project_id: str) -> dict[str, Any]:
    response = client.post(f"/api/v1/projects/{project_id}/sessions", json={})
    assert response.status_code == 201, response.text
    return response.json()


def test_discovery_404s_when_the_session_has_no_container(
    settings: Settings, tmp_path: Path
):
    """Disabled, not yet allocated, or already released — one answer for all
    three, and the client hides the panel strip on it."""
    with sandbox_api(settings, handle=None) as client:
        project = _project(client, tmp_path / "sbx", tier="sandbox")
        session = _session(client, project["id"])

        response = client.get(f"/api/v1/sessions/{session['id']}/preview")

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "no_preview"


def test_a_local_project_never_asks_docker(settings: Settings, tmp_path: Path):
    """A `local` project has no container by definition, and paying a
    subprocess to be told so on every panel poll is a cost with nothing to
    show for it."""
    handle = SimpleNamespace(base_url="http://127.0.0.1:9", auth=None)
    with sandbox_api(settings, handle=handle) as client:
        project = _project(client, tmp_path / "loc", tier="local")
        session = _session(client, project["id"])

        assert client.get(f"/api/v1/sessions/{session['id']}/preview").status_code == 404


def test_discovery_returns_a_token_a_port_and_the_three_panels(
    settings: Settings, tmp_path: Path, container: FakeContainer
):
    """The lazy path end to end: nothing was mounted, discovery finds the live
    container from the provider and publishes it on the spot."""
    handle = SimpleNamespace(
        base_url=container.base_url,
        auth=SimpleNamespace(connect_headers=lambda: {"X-Api-Key": "k"}),
    )
    with sandbox_api(settings, handle=handle) as client:
        project = _project(client, tmp_path / "sbx", tier="sandbox")
        session = _session(client, project["id"])

        body = client.get(f"/api/v1/sessions/{session['id']}/preview").json()

        assert set(body) == {"token", "port", "panels"}
        assert body["port"] and isinstance(body["port"], int)
        assert body["panels"] == panel_paths(body["token"])
        # Reachable on the port it reported, and only under its own token.
        with httpx.Client(
            base_url=f"http://127.0.0.1:{body['port']}", timeout=TIMEOUT
        ) as preview:
            assert preview.get(body["panels"]["terminal"]).status_code == 200
            assert preview.get("/api/v1/sessions").status_code == 404


def test_discovery_binds_the_same_host_as_the_main_server(
    make_settings: Callable[..., Settings], tmp_path: Path, container: FakeContainer
):
    """The preview origin follows `settings.host`.

    The panels are iframes whose src the browser builds from
    `window.location.hostname` and the discovered port. A workbench reached over
    anything but loopback loads its SPA (the main port is on `settings.host`) but
    every panel would then dial a `127.0.0.1` port that is not listening for it —
    the exact "sandbox won't open" a hardcoded loopback bind produces. Binding
    the gateway to `settings.host` keeps both legs on one reachability boundary.

    Asserted on the gateway the discovery call constructed rather than end to
    end: the whole point is *which host it binds*, and a machine whose loopback
    routes only `127.0.0.1` (many do) cannot prove that with a second address.
    """
    settings = make_settings(host="0.0.0.0")
    handle = SimpleNamespace(base_url=container.base_url, auth=None)
    with sandbox_api(settings, handle=handle) as client:
        project = _project(client, tmp_path / "sbx", tier="sandbox")
        session = _session(client, project["id"])

        # The lazy mount builds the gateway; it must have taken the server's host.
        assert client.get(f"/api/v1/sessions/{session['id']}/preview").status_code == 200
        gateway = client.app.state.preview_gateway  # type: ignore[attr-defined]
        assert gateway.host == settings.host


def test_discovery_is_idempotent_for_one_session(
    settings: Settings, tmp_path: Path, container: FakeContainer
):
    """A second call must not rotate the token: an open iframe would go blank
    every time the panel strip re-polled."""
    handle = SimpleNamespace(base_url=container.base_url, auth=None)
    with sandbox_api(settings, handle=handle) as client:
        project = _project(client, tmp_path / "sbx", tier="sandbox")
        session = _session(client, project["id"])
        url = f"/api/v1/sessions/{session['id']}/preview"

        assert client.get(url).json()["token"] == client.get(url).json()["token"]

def test_deleting_a_session_invalidates_its_preview_token(
    settings: Settings, tmp_path: Path, container: FakeContainer
):
    """A token that outlives its session is a live URL onto a container nobody
    can name any more, and the 64-entry LRU would only reclaim it after 64 more
    sessions."""
    handle = SimpleNamespace(base_url=container.base_url, auth=None)
    with sandbox_api(settings, handle=handle) as client:
        project = _project(client, tmp_path / "sbx", tier="sandbox")
        session = _session(client, project["id"])
        body = client.get(f"/api/v1/sessions/{session['id']}/preview").json()

        with httpx.Client(
            base_url=f"http://127.0.0.1:{body['port']}", timeout=TIMEOUT
        ) as preview:
            assert preview.get(body["panels"]["terminal"]).status_code == 200

            assert client.delete(f"/api/v1/sessions/{session['id']}").status_code == 204

            assert preview.get(body["panels"]["terminal"]).status_code == 404


def test_the_lifespan_releases_the_preview_port(
    settings: Settings, tmp_path: Path, container: FakeContainer
):
    """The origin binds lazily and its server thread is a daemon, so without an
    explicit close the port is released only at process exit — and a reload
    cannot rebind it."""
    handle = SimpleNamespace(base_url=container.base_url, auth=None)
    app = create_app(settings)
    install_runtime(app, settings, sandbox=fake_tier(settings, handle))
    with serve_app(app, settings) as server:
        with httpx.Client(base_url=server.base_url, timeout=TIMEOUT) as client:
            project = _project(client, tmp_path / "sbx", tier="sandbox")
            session = _session(client, project["id"])
            port = client.get(f"/api/v1/sessions/{session['id']}/preview").json()["port"]

    assert port
    # The lifespan has exited by here. Binding the same port proves it was let
    # go; a leaked listener makes this raise.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", port))
    finally:
        probe.close()
