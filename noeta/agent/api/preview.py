"""Preview discovery: where this session's container panels can be reached.

`GET /sessions/{id}/preview` -> `{token, port, panels}`, and **404 when the
session has no container** — disabled, not yet allocated, or already released.
The client hides the panel strip on that 404 rather than rendering three
iframes that cannot load, so the 404 is a normal answer and not an error.

It may shell out to `docker`, so it runs off the event loop.

The panels are served from a **separate origin** on their own port; see
`host/preview_gateway.py` for why that is a reversal not to undo.

The mount is **lazy**. `mount_root` on an allocate lifecycle hook is the
efficient path, but it cannot be the only one: after a process restart requeued
tasks take the `attach` path and fire no allocate listener, so a live container
exists with nothing registered against it. Discovery therefore looks the handle
up from the provider itself and mounts on the spot, which makes this endpoint
correct on its own and the hook a pure optimization.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Optional

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.deps import db_of, require_project, require_session
from noeta.agent.api.errors import APIError, ContractRoute
from noeta.agent.host.preview_gateway import PreviewGateway, discovery_payload

logger = logging.getLogger(__name__)

router = APIRouter(tags=["preview"], route_class=ContractRoute)

#: Guards the lazy construction below. Two tabs asking for a preview at once
#: must not bind two ports.
_INSTALL_LOCK = threading.Lock()


def install(app: Any, gateway: PreviewGateway) -> None:
    """Publish a gateway on an application, so the composition root can own its
    lifetime instead of leaving it to the first request."""
    app.state.preview_gateway = gateway


def gateway_of(request: Request) -> PreviewGateway:
    """The process's preview gateway, created and bound on first use.

    Lazy on purpose: the origin binds a second port, and a workbench that never
    opens a sandbox project should never bind it. The bind happens *after* the
    container lookup below has already succeeded, so a machine with no Docker
    never reaches this at all.

    **The gateway binds the same host as the main server.** The panels are
    iframes whose src the browser builds from `window.location.hostname` and the
    discovered port, so a preview origin on `127.0.0.1` is unreachable the moment
    the workbench is opened over anything but loopback — the SPA loads (the main
    port is on `settings.host`), but every panel iframe dials a port that is not
    listening for it. Following `settings.host` keeps the two on one reachability
    boundary; it widens no exposure the main port did not already have, and the
    channel stays token-guarded exactly as before (see `LEDGER §6.2`).
    """
    existing = getattr(request.app.state, "preview_gateway", None)
    if existing is not None:
        return existing
    with _INSTALL_LOCK:
        existing = getattr(request.app.state, "preview_gateway", None)
        if existing is not None:
            return existing
        settings = request.app.state.settings
        gateway = PreviewGateway(
            host=str(getattr(settings, "host", "127.0.0.1")),
            port=int(getattr(settings, "sandbox_preview_port", 0)),
        )
        install(request.app, gateway)
        return gateway


def _live_container(request: Request, session_id: str) -> Optional[tuple[str, Any]]:
    """`(base_url, connect_headers)` for this session's running container.

    `None` covers every reason there is nothing to show, and they are all the
    same answer to the client: the project is on the `local` tier, the sandbox
    tier was never wired, the container was never allocated, or the idle reaper
    already removed it.
    """
    conn = db_of(request)
    session = require_session(conn, session_id)
    project = require_project(conn, session.project_id)
    runtime = getattr(request.app.state, "runtime", None)
    tier = getattr(runtime, "sandbox", None)
    if tier is None or project.tier != "sandbox":
        # A `local` project has no container by definition. Short-circuiting
        # here matters because the lookup below shells out to `docker`, and
        # paying a subprocess to be told "no" on every panel poll of every
        # local project is a cost with nothing to show for it.
        return None
    # Under D2 the container's natural key is the PROJECT: every session of a
    # project shares one container, and one directory.
    handle = tier.provider.live_handle(project.id)
    if handle is None:
        return None
    auth = getattr(handle, "auth", None)
    # The credential is a *callable*, never a value: it is re-read per proxied
    # request so a rotated secret takes effect without a re-mount, and it never
    # leaves the gateway-to-container leg.
    return handle.base_url, getattr(auth, "connect_headers", None)


@router.get("/sessions/{session_id}/preview")
async def session_preview(request: Request, session_id: str) -> Any:
    """Discovery for this session's sandbox panels.

    `port` is `null` when the preview origin could not bind — a busy port must
    cost the panels, never the conversation — and the client hides the panels
    on that too.
    """
    found = await run_in_threadpool(_live_container, request, session_id)
    if found is None:
        raise APIError(
            404, "no_preview", f"session {session_id} has no running sandbox container"
        )
    base_url, auth = found
    gateway = gateway_of(request)
    # Binding is a socket operation and the discovery call is already off the
    # loop's thread; `serve` is idempotent, so repeat calls are a dict lookup.
    await run_in_threadpool(gateway.serve)
    token = gateway.mount_session(session_id, base_url, auth)
    return discovery_payload(gateway, token)
