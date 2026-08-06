"""What every handler reads off `app.state`, and how it is assembled.

The HTTP surface needs exactly three process-lived things: the store
connection (`app.state.db`, opened by the application factory), the engine
host, and the event hub. This module builds the second and third, in the one
order that works, and releases them in the one order that does not leak a
container.

**Startup order.** Build the provider, build the host, attach the hub to the
client, *rebuild the routing map from the database*, then start the workers.
The map has to exist first: the worker pool's stale-lease sweep re-drives tasks
that were mid-turn when the process died, and their envelopes arrive with no
session to route to if the map is still empty.

**Shutdown order.** `host.close()` before the store closes. An interactive
session rests at `suspended` forever and never reaches a root terminal, so the
client's ordered shutdown is the only thing that ever reaps its container.

The hub and the client are mutually dependent — the hub is the delta sink, and
`HostConfig` takes that at build time — so the hub is constructed first and
handed the client afterwards with `attach`.
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI

from noeta.agent.config import Settings
from noeta.agent.host import provider as provider_module
from noeta.agent.host import sandbox as sandbox_module
from noeta.agent.host import title as title_module
from noeta.agent.host.client import AgentHost, build_host
from noeta.agent.host.hub import EventHub
from noeta.agent.store import projects, sessions
from noeta.sdk import McpAnyServerSpec, McpHttpServerSpec, McpServerSpec

logger = logging.getLogger(__name__)

#: "Not supplied" for a parameter whose `None` is a meaningful value.
_DEFAULT: Any = object()


@dataclass
class Runtime:
    """The engine-side half of the process, as the API layer sees it."""

    settings: Settings
    hub: EventHub
    host: AgentHost
    provider_name: str
    sandbox: Optional[sandbox_module.SandboxTier] = None

    def close(self) -> None:
        # The reaper first: it is a patrol over the provider, and a sweep
        # racing the ordered client shutdown would be reclaiming containers
        # the shutdown is already reaping.
        if self.sandbox is not None:
            self.sandbox.close()
        self.host.close()


def mcp_resolver(store: sqlite3.Connection) -> Any:
    """`HostConfig.mcp_server_resolver` over the project's connectors.

    **Total by construction.** A malformed, unknown, disabled or wrong-scope
    token resolves to `None`, which skips one server; raising here would sink
    the whole turn over one bad row. The resolved spec carries the **clean
    alias**, never the scoped token — the token is our addressing scheme and
    the agent sees tool names built from the alias.
    """

    def resolve(token: str) -> Optional[McpAnyServerSpec]:
        try:
            connector = projects.resolve_connector_token(store, token)
        except Exception:  # noqa: BLE001 - one server, never the turn
            logger.exception("could not resolve MCP token %r", token)
            return None
        if connector is None:
            return None
        if connector.transport == "http":
            return McpHttpServerSpec(
                alias=connector.alias,
                url=connector.url,
                headers=dict(connector.headers),
                tool_subset=tuple(connector.tool_subset),
            )
        return McpServerSpec(
            alias=connector.alias,
            argv=tuple(connector.argv),
            env=dict(connector.env),
            tool_subset=tuple(connector.tool_subset),
        )

    return resolve


def _title_service(
    settings: Settings, store: sqlite3.Connection, hub: EventHub
) -> title_module.TitleService:
    """The sidebar-label generator, wired to the store and the hub.

    Every seam it takes is a one-liner over something that already exists,
    which is the point of it taking seams at all: the orchestration is
    testable without a gateway, and the title thread never learns what a
    session row looks like."""

    def read_session(session_id: str) -> Optional[title_module.TitleTarget]:
        session = sessions.get_session(store, session_id)
        if session is None:
            return None
        streams = sessions.list_task_streams(store, session_id)
        # The *first* stream: a title describes how the conversation opened,
        # and a fork must not re-title the session it branched inside.
        return title_module.TitleTarget(
            task_id=streams[0].task_id if streams else "",
            generated=session.title_generated,
        )

    def save_title(session_id: str, title: str) -> None:
        sessions.update_session(store, session_id, title=title, title_generated=True)

    return title_module.TitleService(
        settings,
        read_session=read_session,
        save_title=save_title,
        push_frame=hub.push,
        events_after=lambda task_id: hub.raw_events(task_id, None),
        deref=hub.deref,
    )


def build_runtime(
    settings: Settings,
    store: sqlite3.Connection,
    *,
    provider: Any = None,
    provider_name: Optional[str] = None,
    provider_headers: Any = None,
    sandbox: Any = _DEFAULT,
) -> Runtime:
    """Assemble the engine host and the event hub. See the module docstring.

    `provider` is injectable so a test can drive the whole HTTP surface
    against a scripted model without a gateway; leaving it out builds the
    configured one, which on a credential-free machine is the offline mock.

    `sandbox` is the execution tier. Left out it is composed from settings,
    which costs nothing on a machine that never runs a `sandbox` project (see
    `host/sandbox.py`); pass `None` to build a host that cannot containerise at
    all, which is what the offline suite does so no test can reach Docker.
    """
    image_binder: Any = None
    if provider is None:
        build = provider_module.build_provider(settings)
        provider = build.provider
        provider_name = build.name
        provider_headers = build.provider_headers
        image_binder = build.image_binder

    tier: Optional[sandbox_module.SandboxTier]
    if sandbox is _DEFAULT:
        tier = sandbox_module.build_sandbox_tier(settings, store)
    else:
        tier = sandbox

    hub = EventHub(store)
    # The title service reads through the hub and pushes back into it, so it
    # is built second and registered as the hub's turn-boundary hook.
    hub.set_turn_boundary_hook(_title_service(settings, store, hub).maybe_generate)

    host = build_host(
        settings,
        provider=provider,
        store=store,
        delta_sink=hub.on_delta,
        mcp_server_resolver=mcp_resolver(store),
        provider_headers=provider_headers,
        sandbox_provider=tier.provider if tier else None,
        sandbox_spec=tier.spec if tier else None,
        sandbox_backend_factory=sandbox_module.exec_env_factory if tier else None,
        sandbox_browser_factory=sandbox_module.browser_factory if tier else None,
    )
    hub.attach(host.client)
    # The gateway provider was built before the client existed; now that it
    # does, wire its deferred image-deref to `get_content`, so an image-bearing
    # turn can pull the `ImageBlock` bytes out of the ContentStore by hash. A
    # missing blob raises rather than sending an empty image — a stored hash
    # that no longer resolves is corruption, not a case to paper over. The mock
    # path leaves `image_binder` None and skips this.
    if image_binder is not None:
        client = host.client

        def _resolve_image(ref: Any) -> bytes:
            data = client.get_content(ref.hash)
            if data is None:
                raise RuntimeError(
                    f"image content {ref.hash!r} is absent from the ContentStore"
                )
            return data

        image_binder.bind(_resolve_image)
    bound = hub.rebuild()
    if bound:
        logger.info("re-bound %d task streams from the store", bound)
    host.start(on_envelope=hub.on_envelope)
    if tier is not None:
        tier.start()
    return Runtime(
        settings=settings,
        hub=hub,
        host=host,
        provider_name=provider_name or settings.effective_provider,
        sandbox=tier,
    )


def install(app: FastAPI, runtime: Runtime) -> None:
    """Publish the runtime where the handlers look for it."""
    app.state.runtime = runtime
    app.state.hub = runtime.hub
    app.state.host = runtime.host


#: Where the pending runtime configuration is parked between `install_runtime`
#: and the lifespan that consumes it.
_PLAN = "_runtime_plan"


def install_runtime(app: FastAPI, settings: Settings, **kwargs: Any) -> None:
    """Compose the engine runtime onto an application's lifespan.

    Wrapping rather than editing the factory's own lifespan is what keeps the
    ordering honest from either caller: the store opens first and closes last,
    because everything here lives strictly inside it.

    **Calling it twice replaces the configuration; it never nests.** The
    application factory installs the configured runtime, and a test that needs
    a different provider installs over it — two engine clients on one storage
    path would be two writers to the same event log, which is a corruption bug
    dressed up as a flaky test.
    """
    already_installed = getattr(app.state, _PLAN, None) is not None
    setattr(app.state, _PLAN, (settings, kwargs))
    if already_installed:
        return

    inner = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(scoped: FastAPI) -> AsyncIterator[Any]:
        async with inner(scoped) as state:
            planned_settings, planned_kwargs = getattr(scoped.state, _PLAN)
            runtime = build_runtime(
                planned_settings, scoped.state.db, **planned_kwargs
            )
            install(scoped, runtime)
            try:
                yield state
            finally:
                # The preview origin is built lazily, on the first discovery
                # call, so that a workbench which never opens a sandbox project
                # never binds a second port. Its *close* cannot be lazy: the
                # thread is a daemon, so without this the port is released only
                # at process exit and a reload cannot rebind it.
                gateway = getattr(scoped.state, "preview_gateway", None)
                if gateway is not None:
                    gateway.close()
                runtime.close()

    app.router.lifespan_context = lifespan
