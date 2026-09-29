"""The sandbox preview gateway: a token registry plus its own tiny origin.

The container fronts every one of its services — noVNC, a web terminal,
code-server, websockify — on one port. This module publishes a *slice* of that
port to the browser under an unguessable token, on a **separate origin**, and
proxies both HTTP and WebSocket traffic to it.

## Origin isolation is a reversal that must not be undone

The preview runs on its own port served by a deliberately **blank origin**:
nothing but `/sandbox-preview/*`. No API, no SPA, no cookies of ours. The
blankness *is* the security property.

Why it has to be that way: these panels need `allow-same-origin` on the iframe
(noVNC keeps settings in `localStorage`, code-server registers a service
worker), and an iframe with `allow-same-origin` is same-origin with whatever
serves it. Serving them off the main port would therefore hand a compromised
container's JavaScript the API origin and the whole control plane. An earlier
single-port design relied on `sandbox="allow-scripts"` *without*
`allow-same-origin`, i.e. an opaque origin; that still works for plain
model-written HTML, and it is the right answer for *that* case — but it cannot
run noVNC or code-server. The two mechanisms coexist on purpose.

A bind failure on the preview port must **not** block the agent path: it is
logged, the discovery payload carries no port, and the client hides the panels.
Conversations keep working; only the panels go missing.

## The registry

`token -> {session_id, base_url, auth, roots}`. The token is
`secrets.token_urlsafe(16)`, so it is unguessable, and it is the *only* thing
the browser ever holds — the container credential is fetched fresh per request
from a callable and rides only the gateway-to-container leg, so rotating the
secret takes effect immediately and it never reaches the browser.

All roots of one session share one token and only the last release unmounts it.
A container rebuilt on a new port changes `base_url`, which mints a new token
and immediately invalidates the old one: a stale iframe must 404 rather than
quietly attach to a different container.

`mount_session` is the **lazy fallback**. After a process restart, requeued
tasks take the `attach` path and fire no allocate listener, so a live container
can exist with nothing registered against it; discovery then looks the handle up
from the provider and mounts it on the spot.
"""
from __future__ import annotations

import logging
import secrets
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

from noeta.agent.host import ws_proxy

logger = logging.getLogger(__name__)

__all__ = [
    "MOUNT_LIMIT",
    "PREVIEW_PREFIX",
    "Mount",
    "PreviewGateway",
    "panel_paths",
]

#: The one path prefix this origin answers on. Everything else is a 404 —
#: including `/`, so a human who opens the port sees nothing at all.
PREVIEW_PREFIX = "/sandbox-preview"

#: How many sessions may hold a mount at once; the oldest is evicted (dict
#: insertion order). A ceiling matters because nothing else ever expires a
#: token: a session whose container was reaped by the idle sweep leaves its
#: mount behind, and without a bound they accumulate for the process lifetime.
MOUNT_LIMIT = 64

#: Fetch-fresh auth: called per proxied request so a rotated container secret
#: is picked up without re-mounting.
AuthHeaders = Callable[[], Mapping[str, str]]

#: Request headers never forwarded. The hop-by-hop ones are RFC 9110's; the
#: rest are ours: `accept-encoding` because we do not want to re-encode a body
#: we are only relaying, and `origin` / `referer` / `cookie` because the browser
#: would otherwise leak the preview origin's context into the container.
_DROP_REQUEST_HEADERS = frozenset(
    {
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "accept-encoding",
        "origin",
        "referer",
        "cookie",
    }
)

#: Response headers never forwarded back. `content-length` is re-derived from
#: the body we actually send; the rest are hop-by-hop.
_DROP_RESPONSE_HEADERS = frozenset(
    {
        "content-length",
        "connection",
        "keep-alive",
        "proxy-connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
    }
)

#: How long one proxied HTTP request may take.
_HTTP_TIMEOUT_S = 30.0

_UNKNOWN_TOKEN_BODY = b'{"error":"unknown preview token"}'
_UNREACHABLE_BODY = b'{"error":"sandbox unreachable"}'


def panel_paths(token: str) -> dict[str, str]:
    """The three panel URLs for a token, as absolute paths on this origin.

    Every quirk below is real, pinned against the live image, and each one is a
    bug that was paid for once already:

    - **browser** needs the explicit `path=` query because the container serves
      websockify at the root `/websockify`, and noVNC's default absolute path
      would escape the token prefix and hit this origin's 404.
    - **terminal** must have **no** trailing slash: the page resolves its PTY
      WebSocket *relative to the URL*, and only `.../terminal` resolves onto the
      container's shell endpoint.
    - **code** must have one: `code-server/` with the slash, or its relative
      asset URLs resolve one segment too high.
    """
    base = f"{PREVIEW_PREFIX}/{quote(token, safe='')}"
    return {
        "browser": (
            f"{base}/vnc/index.html?autoconnect=true&resize=scale"
            f"&path=sandbox-preview/{token}/websockify"
        ),
        "terminal": f"{base}/terminal",
        "code": f"{base}/code-server/",
    }


@dataclass
class Mount:
    """One session's published container."""

    token: str
    session_id: str
    base_url: str
    auth: Optional[AuthHeaders] = None
    #: The root task ids holding this mount open. Empty for a lazy mount, which
    #: is why release also accepts the session key.
    roots: set[str] = field(default_factory=set)

    def headers(self) -> dict[str, str]:
        """The container credential, read fresh. A failing fetch is not fatal:
        an unauthenticated request gets a 401 from the container, which is a far
        better failure than a 500 from the gateway."""
        if self.auth is None:
            return {}
        try:
            return dict(self.auth())
        except Exception:  # noqa: BLE001 - one request, never the gateway
            logger.warning("preview auth fetch failed for %s", self.session_id, exc_info=True)
            return {}


class _NoRedirects(HTTPRedirectHandler):
    """Redirects are relayed, never followed.

    Following one server-side would resolve it against the *container's* URL
    space and return a body the browser then interprets as belonging to the
    requested path. Relaying it lets the browser re-request through the token
    prefix, which is the only place the rewrite below can be applied."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


class PreviewGateway:
    """The token registry and the origin that serves it.

    Construction opens nothing. `serve()` binds the port, and a bind failure is
    a warning rather than an exception — see the module docstring.
    """

    def __init__(self, *, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._requested_port = port
        self._lock = threading.RLock()
        self._mounts: dict[str, Mount] = {}
        self._token_by_session: dict[str, str] = {}
        self._server: Optional[ThreadingHTTPServer] = None
        self._thread: Optional[threading.Thread] = None
        self._port: Optional[int] = None

    # -- lifecycle ---------------------------------------------------------- #

    @property
    def host(self) -> str:
        """The address the origin binds. Follows the main server's `host`, so a
        workbench opened over a LAN address can reach the panels (see
        `api/preview.gateway_of`)."""
        return self._host

    @property
    def port(self) -> Optional[int]:
        """The bound port, or `None` when the origin is not up."""
        return self._port

    def serve(self) -> Optional[int]:
        """Bind the preview origin. Idempotent; `None` when it could not bind.

        The port defaults to ephemeral and is discovered at boot, so nothing
        needs configuring for it to work; a deployment behind a firewall pins
        it. A failure here is deliberately survivable — the agent path does not
        depend on the preview origin existing."""
        with self._lock:
            if self._server is not None:
                return self._port
            handler = _handler_class(self)
            try:
                server = ThreadingHTTPServer((self._host, self._requested_port), handler)
            except OSError as exc:
                logger.warning(
                    "sandbox preview port %s could not be bound (%s); "
                    "panels will be unavailable",
                    self._requested_port,
                    exc,
                )
                return None
            server.daemon_threads = True
            self._server = server
            self._port = int(server.server_address[1])
            self._thread = threading.Thread(
                target=server.serve_forever,
                name="sandbox-preview",
                daemon=True,
            )
            self._thread.start()
            logger.info("sandbox preview origin on http://%s:%d", self._host, self._port)
            return self._port

    def close(self) -> None:
        with self._lock:
            server, thread = self._server, self._thread
            self._server = None
            self._thread = None
            self._port = None
            self._mounts.clear()
            self._token_by_session.clear()
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5.0)

    # -- registry ----------------------------------------------------------- #

    def mount_root(
        self,
        root_task_id: str,
        session_id: str,
        base_url: str,
        auth: Optional[AuthHeaders] = None,
    ) -> str:
        """Publish a container on behalf of one root task stream.

        Idempotent for an unchanged `base_url` — the token is reused, so an
        open iframe keeps working when a second task stream of the same session
        starts."""
        return self._mount(session_id, base_url, auth, root_task_id=root_task_id)

    def mount_session(
        self,
        session_id: str,
        base_url: str,
        auth: Optional[AuthHeaders] = None,
    ) -> str:
        """The lazy fallback: publish a container discovery found running.

        Holds no root, so `release_root` falls back to the session key to take
        it down. See the module docstring for when this is the only path taken.
        """
        return self._mount(session_id, base_url, auth, root_task_id=None)

    def _mount(
        self,
        session_id: str,
        base_url: str,
        auth: Optional[AuthHeaders],
        *,
        root_task_id: Optional[str],
    ) -> str:
        base_url = base_url.rstrip("/")
        with self._lock:
            token = self._token_by_session.get(session_id)
            mount = self._mounts.get(token) if token else None
            if mount is not None and mount.base_url == base_url:
                mount.auth = auth or mount.auth
                if root_task_id:
                    mount.roots.add(root_task_id)
                return mount.token
            if mount is not None:
                # A rebuilt container on a new port. The old token dies here
                # rather than pointing at whatever now listens on that address.
                self._drop(mount.token)
            token = secrets.token_urlsafe(16)
            self._mounts[token] = Mount(
                token=token,
                session_id=session_id,
                base_url=base_url,
                auth=auth,
                roots={root_task_id} if root_task_id else set(),
            )
            self._token_by_session[session_id] = token
            while len(self._mounts) > MOUNT_LIMIT:
                self._drop(next(iter(self._mounts)))
            return token

    def release_root(
        self, root_task_id: str, *, session_id: Optional[str] = None
    ) -> None:
        """Drop one root's hold. Only the session's **last** one unmounts.

        Under D2 every session of a project shares one container, and a session
        can hold several task streams; tearing the mount down on the first
        release would blank a panel another stream is still using."""
        with self._lock:
            token = self._token_for(root_task_id, session_id)
            if token is None:
                return
            mount = self._mounts[token]
            mount.roots.discard(root_task_id)
            if mount.roots:
                return
            self._drop(token)

    def unmount_session(self, session_id: str) -> None:
        """Force-unmount, ignoring the refcount. The deletion path."""
        with self._lock:
            token = self._token_by_session.get(session_id)
            if token is not None:
                self._drop(token)

    def lookup(self, token: str) -> Optional[Mount]:
        with self._lock:
            return self._mounts.get(token)

    def token_for_session(self, session_id: str) -> Optional[str]:
        with self._lock:
            return self._token_by_session.get(session_id)

    def panels(self, token: str) -> dict[str, str]:
        return panel_paths(token)

    def _token_for(
        self, root_task_id: str, session_id: Optional[str]
    ) -> Optional[str]:
        for token, mount in self._mounts.items():
            if root_task_id in mount.roots:
                return token
        if session_id is None:
            return None
        return self._token_by_session.get(session_id)

    def _drop(self, token: str) -> None:
        mount = self._mounts.pop(token, None)
        if mount is None:
            return
        if self._token_by_session.get(mount.session_id) == token:
            del self._token_by_session[mount.session_id]


# ---------------------------------------------------------------------------
# The origin
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Route:
    mount: Mount
    #: The container-relative target, query included and untouched.
    target: str


def _parse(path: str, gateway: PreviewGateway) -> Optional[_Route]:
    """`/sandbox-preview/<token>/<sub>?<query>` -> the mount and the sub-target.

    `None` for anything else, which is what makes this origin blank: `/`, the
    API paths of the main port and an unknown token are all indistinguishable
    404s from the outside."""
    raw_path, _, query = path.partition("?")
    if not raw_path.startswith(PREVIEW_PREFIX + "/"):
        return None
    remainder = raw_path[len(PREVIEW_PREFIX) + 1 :]
    token, _, sub = remainder.partition("/")
    if not token:
        return None
    mount = gateway.lookup(token)
    if mount is None:
        return None
    target = "/" + sub
    if query:
        target = f"{target}?{query}"
    return _Route(mount=mount, target=target)


def _rewrite_location(value: str, token: str) -> str:
    """Keep a container-issued redirect inside the token prefix.

    code-server answers `/code-server/` with a redirect to an absolute path,
    and an absolute path on this origin that is not under the prefix is a 404 —
    so the panel would die on its first request. Only root-relative locations
    are touched; an absolute URL is the container naming somewhere else, and
    rewriting that would be inventing a destination."""
    if not value.startswith("/") or value.startswith(PREVIEW_PREFIX + "/"):
        return value
    return f"{PREVIEW_PREFIX}/{token}{value}"


def _handler_class(gateway: PreviewGateway) -> type[BaseHTTPRequestHandler]:
    """Bind one gateway into a handler class.

    A closure rather than an attribute on the server object: the handler is
    instantiated per request by `socketserver`, and reaching back through
    `self.server` for state is the shape that makes a handler impossible to
    test on its own.
    """

    opener = build_opener(_NoRedirects)

    class PreviewHandler(BaseHTTPRequestHandler):
        # HTTP/1.1 so keep-alive works; code-server opens many small requests.
        protocol_version = "HTTP/1.1"
        server_version = "noeta-preview"
        sys_version = ""

        def log_message(self, fmt: str, *args: object) -> None:
            # The default writes every request to stderr. A code-server tab
            # would flood the process log with asset requests.
            logger.debug("preview %s - %s", self.address_string(), fmt % args)

        # -- entry points --------------------------------------------------- #

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's contract
            self._dispatch("GET")

        def do_HEAD(self) -> None:  # noqa: N802
            self._dispatch("HEAD")

        def do_POST(self) -> None:  # noqa: N802
            self._dispatch("POST")

        def do_PUT(self) -> None:  # noqa: N802
            self._dispatch("PUT")

        def do_PATCH(self) -> None:  # noqa: N802
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:  # noqa: N802
            self._dispatch("DELETE")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self._dispatch("OPTIONS")

        # -- routing -------------------------------------------------------- #

        def _dispatch(self, method: str) -> None:
            route = _parse(self.path, gateway)
            if route is None:
                self._refuse(404, _UNKNOWN_TOKEN_BODY)
                return
            if self._wants_websocket():
                self._websocket(route)
                return
            self._passthrough(method, route)

        def _wants_websocket(self) -> bool:
            upgrade = self.headers.get("Upgrade", "")
            return upgrade.strip().lower() == "websocket"

        # -- HTTP ----------------------------------------------------------- #

        def _passthrough(self, method: str, route: _Route) -> None:
            body = self._read_body()
            headers = {
                name: value
                for name, value in self.headers.items()
                if name.lower() not in _DROP_REQUEST_HEADERS
            }
            # Injected fresh, and only here: the credential never reaches the
            # browser, only the gateway-to-container leg.
            headers.update(route.mount.headers())
            request = Request(  # noqa: S310 - loopback container URL
                route.mount.base_url + route.target,
                data=body,
                headers=headers,
                method=method,
            )
            try:
                with opener.open(request, timeout=_HTTP_TIMEOUT_S) as response:
                    self._relay(response.status, response.headers, response.read(), route)
            except HTTPError as exc:
                # A 4xx/5xx from the container is a real answer, not a gateway
                # failure — relay it verbatim so the panel sees what it expects.
                self._relay(exc.code, exc.headers, exc.read(), route)
            except (URLError, OSError, ValueError) as exc:
                logger.info("preview upstream unreachable: %s", exc)
                self._refuse(502, _UNREACHABLE_BODY)

        def _read_body(self) -> Optional[bytes]:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            return self.rfile.read(length) if length > 0 else None

        def _relay(self, status: int, headers, body: bytes, route: _Route) -> None:
            self.send_response(status)
            for name, value in headers.items():
                lowered = name.lower()
                if lowered in _DROP_RESPONSE_HEADERS:
                    continue
                # **No CORS headers on this origin.** The panels are same-origin
                # with it, so they never need one; relaying an
                # `Access-Control-Allow-Origin: *` from a compromised container
                # would hand its responses to any page on the internet.
                if lowered.startswith("access-control-"):
                    continue
                if lowered == "location":
                    value = _rewrite_location(value, route.mount.token)
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _refuse(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        # -- WebSocket ------------------------------------------------------ #

        def _websocket(self, route: _Route) -> None:
            """Upgrade, but only after the container leg is up.

            The ordering is the whole point: an unreachable container must
            surface as a 502, not as a 101 followed by an abrupt close. noVNC
            and xterm.js get no close frame from that and cannot report what
            went wrong."""
            self.close_connection = True
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._refuse(400, b'{"error":"missing Sec-WebSocket-Key"}')
                return
            # Precomputed before the dial so both legs are told the same answer.
            subprotocol = ws_proxy.negotiated_subprotocol(
                self.headers.get("Sec-WebSocket-Protocol")
            )
            upstream_url = route.mount.base_url + route.target
            try:
                upstream = ws_proxy.open_upstream(
                    upstream_url,
                    headers=route.mount.headers(),
                    subprotocol=subprotocol,
                )
            except ws_proxy.UpstreamUnreachable as exc:
                logger.info("preview websocket upstream unreachable: %s", exc)
                self._refuse(502, _UNREACHABLE_BODY)
                return
            # From here on this connection is no longer HTTP. Nothing below may
            # write a status line.
            ws_proxy.proxy(
                client_sock=self.connection,
                client_stream=self.rfile,
                client_key=key,
                upstream=upstream,
                write=self.connection.sendall,
            )

    return PreviewHandler


def discovery_payload(gateway: PreviewGateway, token: str) -> dict[str, object]:
    """`{token, port, panels}` — the discovery response body.

    `port` is `None` when the origin could not bind, and the client hides the
    panels rather than rendering iframes that cannot load."""
    return {
        "token": token,
        "port": gateway.port,
        "panels": gateway.panels(token),
    }
