"""The single engine `Client`, and the turn-driving surface over it.

Two things live here and they are deliberately separate:

- **`build_client`** — every option, host-config field and startup argument
  the product needs, in one function, so "how is this host configured" has one
  answer. It takes the provider as an **argument** and never constructs one;
  that single parameter is the entire difference between the offline test
  suite and production.
- **`AgentHost`** — the small, deep interface the API layer calls: send a
  goal, answer a question, interrupt, cancel, fork. The seed/dispatch split,
  the task-stream bookkeeping, the memory-seeding window and the workspace
  assembly all hide inside it. A handler never touches a `SeededTurn`.

## Configuration that silently breaks the product

Three SDK defaults are wrong for a coding agent and each fails *quietly*:

- `HostConfig.write_mode` defaults to `"dry_run"`, which stages a proposed
  diff and touches no disk. Every `edit` / `write` / `apply_patch` reports
  success and changes nothing. This is the single most likely way to ship a
  workbench where editing does not edit.
- `HostConfig.instructions_enabled` defaults to `False`, so the project's own
  `AGENTS.md` is never read.
- `Options.permission_mode` defaults to `"default"`, which gates every
  non-low-risk tool behind an approval this product has no UI for — the turn
  would park on a suspend nobody can answer.

They are set here, and pinned by a test, because a regression in any of them
looks like a product bug rather than a configuration one.

## Permissions: bypassed, exactly

`permission_mode="bypassPermissions"` on the compiled options, `can_use_tool`
left `None` (there is nothing to auto-resolve when nothing is gated), and —
the part that is easy to lose — **no turn-driving call ever passes a per-turn
`permission_mode`**. The per-turn value has the highest priority in the
runtime's resolution, above the host config, precisely so a frontend selector
cannot be a no-op; passing `"default"` on one turn therefore re-arms every
gate for that turn. This product has no selector, so it passes nothing.

## Startup and shutdown order

Start: build -> `subscribe` -> `add_sandbox_lifecycle_listener` ->
`start_workers`. Subscribing before the workers run matters because the
constructor has already re-driven any background subagent orphaned by a prior
crash, and the moment workers start, events flow.

Stop: detach our subscriber, then `Client.shutdown()`, which does the ordered
teardown itself — workers, then observers, then the OTLP exporter, then
containers. **The container step is not optional.** An interactive session
rests at `suspended` forever and never reaches a root terminal, so its
container is reaped only by that backstop: a process that skips `shutdown()`
leaks one container per live session.
"""
from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

from noeta.agent import models_config
from noeta.agent.config import Settings
from noeta.agent.host.memory import MemoryRoots
from noeta.agent.host.tiers import TierPolicy
from noeta.agent.host.title import fork_title
from noeta.agent.host.workspace import assemble
from noeta.agent.store import projects, sessions
from noeta.agent.store.errors import UnknownProjectError, UnknownSessionError
from noeta.presets import main_options, with_consolidation_agent
from noeta.sdk import (
    Client,
    EventEnvelope,
    HostConfig,
    ImageBlock,
    McpAnyServerSpec,
    OtlpTraceConfig,
    PluginError,
    PluginSet,
    StepContext,
    StreamDelta,
    load_plugins,
)

logger = logging.getLogger(__name__)

# --- the injected seams, as types -----------------------------------------
#
# Each of these is owned by a different module. They are parameters rather
# than imports so this module depends on none of them, and so the offline
# suite can build a fully wired host with none of them present.

#: `HostConfig.delta_sink`. Called **inside the LLM round trip on a worker
#: thread**, once per streamed chunk: never block, never raise.
DeltaSink = Callable[[StepContext, str, StreamDelta], None]

#: `HostConfig.mcp_server_resolver`. Takes the scoped connector token
#: (`"<project_id>:<alias>"`, per `store.projects.connector_token`) and returns
#: a connect spec **with credentials**, or `None`. Must be total: one bad token
#: skips one server and never sinks a turn.
McpServerResolver = Callable[[str], McpAnyServerSpec | None]

#: `HostConfig.provider_headers`. Extra headers for the LLM call of one step.
ProviderHeaders = Callable[[StepContext], Mapping[str, str]]

#: `HostConfig.sandbox_policy`. See `tiers.TierPolicy.wants_container`.
SandboxPolicy = Callable[[str, str | None], bool]

#: `HostConfig.memory_root_resolver`. See `memory.MemoryRoots.resolve`.
MemoryRootResolver = Callable[[str], Path | None]

#: `Client.subscribe`. Fires once per committed envelope, for **all** tasks,
#: on the worker thread that committed it.
EnvelopeSink = Callable[[EventEnvelope], None]

#: `Client.add_sandbox_lifecycle_listener`. `on_allocate` fires after a
#: container is provisioned and cached; `on_release` fires **before** teardown,
#: while the container is still reachable.
SandboxAllocated = Callable[[str, Any], None]
SandboxReleased = Callable[[str], None]

OTLP_SERVICE_NAME = "noeta-agent"


class HostError(Exception):
    """Base class for what the host refuses to do."""


class UnknownTaskStreamError(HostError):
    """A `task_id` that is not one of this session's streams.

    Either it does not exist or it belongs to a different session; the two are
    the same answer to a caller, and distinguishing them would leak the
    existence of another session's stream."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"no such task stream in this session: {task_id}")
        self.task_id = task_id


class NoTaskStreamError(HostError):
    """A verb that needs an existing stream, on a session that has none.

    A session is created with zero streams and the first message seeds the
    first one, so this is `answer` / `fork` arriving before any message did."""

    def __init__(self, session_id: str) -> None:
        super().__init__(f"session {session_id} has no task stream yet")
        self.session_id = session_id


class NotRewindableError(HostError):
    """A `rewind` anchor the stream cannot re-base to.

    The mirror of the engine's `NotForkableError`, which `rewind` does not
    raise: the SDK's rewind validation raises a plain `RuntimeError` for a
    `message_seq` that is not a real user-goal `MessagesAppended` on the stream,
    so the product wraps it in a coded error of its own to give the API a clean
    409 instead of a 500. Carries the underlying reason as its message."""


def _is_user_message_seq(events: Sequence[EventEnvelope], message_seq: int) -> bool:
    """True iff `message_seq` is a user-goal `MessagesAppended` on this stream.

    The product-side twin of the engine's own anchor predicate, used to
    pre-validate a `rewind` (the SDK's rewind raises a bare `RuntimeError`, not
    a coded refusal, so the check has to happen here to yield a clean 409)."""
    target = next((e for e in events if e.seq == message_seq), None)
    return (
        target is not None
        and target.type == "MessagesAppended"
        and bool(getattr(target.payload, "count", 0))
    )


# ---------------------------------------------------------------------------
# Building the Client
# ---------------------------------------------------------------------------


def _load_plugin_set() -> PluginSet | None:
    """The plugin set, or `None` when it cannot be loaded.

    A load fault is a bad plugin, not a bad product: degrading to no plugins
    keeps the workbench bootable and tells the user what happened, where
    refusing to boot leaves them with a process that will not start and no way
    to remove the plugin from inside it.

    Verified against 0.5.1: with the default sources (the built-in catalogue
    only, no entry points and no plugin directories) the compiled `AgentSpec`
    is *identical* with and without the loaded set — the built-in tools come
    from the runtime either way. So today this degradation costs nothing at
    all, and the only thing a future external plugin would lose is its own
    contributions."""
    try:
        return load_plugins()
    except PluginError:
        logger.warning(
            "plugin discovery failed; continuing without plugins", exc_info=True
        )
        return None


def build_client(
    settings: Settings,
    *,
    provider: Any,
    store: sqlite3.Connection,
    delta_sink: DeltaSink | None = None,
    mcp_server_resolver: McpServerResolver | None = None,
    provider_headers: ProviderHeaders | None = None,
    sandbox_provider: Any | None = None,
    sandbox_spec: Any | None = None,
    sandbox_backend_factory: Any | None = None,
    sandbox_browser_factory: Any | None = None,
    sandbox_policy: SandboxPolicy | None = None,
    memory_root_resolver: MemoryRootResolver | None = None,
) -> Client:
    """The one engine `Client` of this process.

    `provider` is required and is never constructed here: the offline suite
    passes a fake, production passes the configured gateway, and nothing else
    about the host differs between them.

    `store` is the app database connection — the same `sqlite3.Connection`
    every `noeta.agent.store` function takes — used by the tier policy and the
    memory-root resolver when those are not supplied explicitly.

    Every remaining keyword is a seam owned by another module (see the type
    aliases above). All of them default to `None`, and the host is fully
    functional with all of them absent: no delta sink means no token streaming
    (the durable `MessagesAppended` still arrives), no MCP resolver means no
    connectors resolve, no sandbox provider means every project runs local
    whatever its configured tier."""
    # Start from the official recipe and replace onto it. `plugins` is the
    # activation tuple, NOT the loaded plugin set: replacing it wholesale
    # would strip the preset's own activations (fs, web, todo_write,
    # ask_user_question, skill_invocation, memory, mcp) and quietly remove
    # capabilities from the agent. Nothing here needs to extend it, so it is
    # left alone entirely.
    options = replace(
        main_options(),
        # The whole permission answer. See the module docstring for why no
        # turn-driving call may pass a per-turn override.
        permission_mode="bypassPermissions",
        # Deliberately not set: there is nothing to auto-resolve when nothing
        # is gated, and a resolver would still cost a suspend/resume per call.
        can_use_tool=None,
        # The compaction summarize round-trip is issued non-streaming; the
        # per-turn model is used when this is None. A model that returns an
        # empty non-streaming body would fail every compaction with
        # `compaction_summary_failed`, so a deployment whose chat model has that
        # trait points this at one that answers non-streaming. Empty config =
        # None = keep the per-turn model (byte-identical to no knob).
        compaction_model=settings.compaction_model or None,
    )
    # `__consolidation__` is a reserved (`__`-prefixed) name, so registering it
    # adds a host-seedable root agent without touching main's spawnable roster
    # or its stable prefix.
    options = with_consolidation_agent(options)

    catalog = models_config.get_models(settings)

    host_config = HostConfig(
        # One string, resolved through the SDK's own storage stack, which
        # builds the event-log / content-store / dispatcher triple in the
        # order they depend on each other. The explicit triple is only worth
        # it when the host needs handles to close, and this process lives as
        # long as its stores do.
        storage_path=str(settings.engine_db_path),
        # NON-DEFAULT and load-bearing: the default stages every edit as a
        # dry-run diff that touches no disk.
        write_mode="apply",
        # The project's own AGENTS.md, plus the subdirectory instruction files
        # the model activates as it reads into them.
        instructions_enabled=True,
        instructions_discovery=True,
        # Left False: this product has no workflow feature, so the
        # `run_workflow` control tool would be a tool the model can call and
        # the product cannot serve.
        workflow_allowed=False,
        # `write_roots` is left None on purpose — the single-root wall. An
        # out-of-workspace write simply fails, which is the honest answer when
        # there is no approval UI to ask for a grant.
        delta_sink=delta_sink,
        mcp_server_resolver=mcp_server_resolver,
        provider_headers=provider_headers,
        sandbox_provider=sandbox_provider,
        sandbox_spec=sandbox_spec,
        # Left `None` these fall back to the SDK's own AIO adapters. The
        # product supplies its own (`sdk_sandbox_exec_env` /
        # `sdk_browser_backend`), which is why both are parameters rather than
        # imports: this module stays on the public SDK surface and the two
        # import-boundary exemptions stay confined to the adapters themselves.
        sandbox_backend_factory=sandbox_backend_factory,
        sandbox_browser_factory=sandbox_browser_factory,
        sandbox_policy=sandbox_policy or TierPolicy(store).wants_container,
        memory_root_resolver=(
            memory_root_resolver
            or MemoryRoots(store, settings.memories_path).resolve
        ),
        # The tail of the memory chain, reached only by `memory_root()` with
        # no task id: the resolver above is total and answers every task.
        memory_dir=settings.memories_path,
        otlp_traces=_otlp_config(settings),
    )

    return Client(
        options,
        provider=provider,
        # The process-level default only. Every session passes its project
        # directory at `seed_start(workspace_dir=…)`, which is welded into
        # `TaskHostBound` and fold-resolved by every later turn.
        workspace_dir=settings.workspaces_path,
        model=models_config.get_default_model(settings).id,
        # What makes a finishing turn land on a suspend instead of a terminal,
        # which is what keeps the conversation alive for the next message.
        multi_turn=True,
        host_config=host_config,
        # The FULL catalog. `None` would authorize only {opus, sonnet, haiku}
        # and reject every gateway model in models.json; `[]` would authorize
        # no per-turn selector at all and make the model dropdown a no-op.
        allowed_models=[m.id for m in catalog],
        plugins=_load_plugin_set(),
    )


def _otlp_config(settings: Settings) -> OtlpTraceConfig | None:
    """Trace export, opt-in through this product's own key only.

    `OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately not honoured as an enable
    switch (see `config.py`): a shared shell or a k8s operator injecting it for
    other processes must not silently start this one exporting a user's
    conversations. Headers are a different matter — they enable nothing by
    themselves — and `Settings.otlp_headers` does accept the ambient value."""
    if not settings.otlp_endpoint:
        return None
    return OtlpTraceConfig(
        endpoint=settings.otlp_endpoint,
        headers=settings.otlp_header_items,
        service_name=OTLP_SERVICE_NAME,
    )


# ---------------------------------------------------------------------------
# Driving turns
# ---------------------------------------------------------------------------


def _noop_allocate(root_task_id: str, handle: Any) -> None:
    del root_task_id, handle


def _noop_release(root_task_id: str) -> None:
    del root_task_id


class AgentHost:
    """The turn-driving interface the API layer calls.

    Every verb here follows the same shape, and the shape is the point:

        seed on the request thread  ->  bind the stream  ->  dispatch

    `seed_*` does every durable and validated step synchronously — create or
    wake the task, authorize the model selector, write the goal, take the
    dispatcher lease — so a typed rejection (`ModelSelectorError`,
    `NotResumableError`) still surfaces to the caller as a synchronous 4xx, and
    an acked message can never be lost to a crash. `dispatch_seeded` then hands
    the lease to the resident worker pool and returns immediately; the turn's
    progress rides the event stream.

    The alternative — driving on a thread the host owns — would mean owning
    concurrency limiting too, and would leave `start_workers` doing nothing but
    timer and stale-lease sweeping."""

    def __init__(
        self,
        client: Client,
        *,
        settings: Settings,
        store: sqlite3.Connection,
        memory_roots: MemoryRoots,
    ) -> None:
        self._client = client
        self._settings = settings
        self._store = store
        self._memory = memory_roots
        self._unsubscribe: Callable[[], None] | None = None
        self._started = False
        self._closed = False

    @property
    def client(self) -> Client:
        """The underlying `Client`, for the read surface (`events_after`,
        `messages`, `get_content`, `task_status`, `suspend_reason`) that the
        SSE and trace endpoints need. Turn *driving* goes through the verbs
        below so the seed/dispatch split and the stream bookkeeping stay in
        one place."""
        return self._client

    # -- process lifecycle ----------------------------------------------------

    def start(
        self,
        *,
        on_envelope: EnvelopeSink | None = None,
        on_sandbox_allocate: SandboxAllocated | None = None,
        on_sandbox_release: SandboxReleased | None = None,
    ) -> None:
        """Subscribe, register the sandbox listeners, start the workers.

        The order is the point. The `Client` constructor has already re-driven
        background subagents orphaned by a prior crash, and the instant the
        worker pool starts, envelopes flow — so a subscriber attached after
        `start_workers` misses the beginning of whatever the pool picks up."""
        if self._started:
            raise RuntimeError("the agent host is already started")
        self._started = True
        if on_envelope is not None:
            self._unsubscribe = self._client.subscribe(on_envelope)
        if on_sandbox_allocate is not None or on_sandbox_release is not None:
            self._client.add_sandbox_lifecycle_listener(
                on_sandbox_allocate or _noop_allocate,
                on_sandbox_release or _noop_release,
            )
        self._client.start_workers(self._settings.agent_num_workers)

    def close(self) -> None:
        """Detach our subscriber and shut the client down. Idempotent.

        `Client.shutdown()` owns the ordering that matters — workers, then
        observers, then the OTLP exporter, then containers — and the last step
        is the only thing that ever reaps an interactive session's container,
        because such a session rests at `suspended` and never terminates."""
        if self._closed:
            return
        self._closed = True
        if self._unsubscribe is not None:
            try:
                self._unsubscribe()
            except Exception:  # noqa: BLE001 - shutdown must reach the reap
                logger.warning("unsubscribing the envelope sink failed", exc_info=True)
            self._unsubscribe = None
        self._client.shutdown()

    def __enter__(self) -> AgentHost:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- turn driving ---------------------------------------------------------

    def send_goal(
        self,
        session_id: str,
        *,
        text: str,
        images: Sequence[ImageBlock] = (),
        model: str | None = None,
        effort: str | None = None,
        skills: Sequence[str] = (),
        task_id: str | None = None,
    ) -> str:
        """Run a user turn. Returns the task id it landed on.

        With no `task_id` the turn goes to the session's newest stream, or —
        when the session has none yet — seeds its first one against the
        project directory. That is the only place a root task is ever created,
        and the only place `workspace_dir` is ever passed.

        **This is also how a failed turn is retried, and the only way.** With
        `multi_turn=True` a provider fault parks the turn at a
        `TaskSuspended(turn_failed: …)` instead of sealing the ledger, and an
        ordinary `send_goal` on the same task resumes it with the whole
        conversation intact. Nothing here re-drives the parked turn: that turn
        is over, the next input is a *new* turn, and an auto-retry hidden in
        the host would replay a request the user never sent again.

        Raises `UnknownSessionError` / `UnknownProjectError` for a session or
        project that is gone, `ModelValidationError` (422) for a model or
        effort outside the configured catalog, `UnknownTaskStreamError` for a
        `task_id` that is not this session's, and the SDK's own
        `ModelSelectorError` / `NotResumableError` synchronously from the seed.

        The "a turn is already running" refusal is **not** here: session status
        is derived from the envelope stream and owned by the API layer that
        reads it, and a second source of truth for it would be a second thing
        to get wrong."""
        session, project = self._session_and_project(session_id)
        selector, chosen_effort = self._resolve_model(project, model, effort)
        assemble(project)
        enabled_mcp = self._enabled_mcp(project.id)
        stream_task_id = self._resolve_task_id(session_id, task_id)

        with self._memory.seeding(project.id):
            if stream_task_id is None:
                seeded = self._client.seed_start(
                    goal=text,
                    images=tuple(images),
                    model_selector=selector,
                    effort=chosen_effort,
                    enabled_mcp=enabled_mcp,
                    workspace_dir=project.directory,
                    activations=tuple(skills),
                    # permission_mode deliberately omitted — a per-turn value
                    # wins over the host config and would re-arm every gate.
                )
                self._bind(session_id, seeded.task_id, kind="root")
            else:
                seeded = self._client.seed_send_goal(
                    stream_task_id,
                    goal=text,
                    images=tuple(images),
                    model_selector=selector,
                    effort=chosen_effort,
                    enabled_mcp=enabled_mcp,
                    activations=tuple(skills),
                )
            self._client.dispatch_seeded(seeded)
        return seeded.task_id

    def inject_goal(
        self,
        session_id: str,
        *,
        text: str,
        images: Sequence[ImageBlock] = (),
        task_id: str | None = None,
    ) -> str:
        """Deliver a user message into a **running** turn (SDK `inject_goal`).

        This is the steer path. The SDK verb is status-dispatched on the task:
        a **running** task takes the message mid-turn — a lease-free
        `InjectionRequested` the running Engine drains at its next turn boundary,
        returning immediately without seeding a new turn — while a task
        **suspended on the next-goal handle** falls through to `send_goal`, the
        ordinary follow-up append. Any other state (terminal, or parked on a
        question / approval) raises `NotResumableError`, surfaced as the same 409
        the other human verbs give for a wrong wake.

        No per-turn `model` / `effort` / `skills` / MCP here, and that is the
        point: an injected message rides the in-flight turn's live binding, so
        swapping the model underneath it is exactly what must not happen. The
        composer freezes those pickers while steering for the same reason.

        Unlike `send_goal` there is no `seed` + `dispatch` split — the running
        path drives nothing on this thread. Returns the stream the message
        landed on (the same task, running or appended)."""
        _, project = self._session_and_project(session_id)
        stream_task_id = self._resolve_task_id(session_id, task_id)
        if stream_task_id is None:
            raise NoTaskStreamError(session_id)
        with self._memory.seeding(project.id):
            self._client.inject_goal(
                stream_task_id, goal=text, images=tuple(images)
            )
        return stream_task_id

    def answer(
        self,
        session_id: str,
        *,
        question_id: str,
        answers: dict[str, Any],
        task_id: str | None = None,
    ) -> str:
        """Answer a structured question and resume the turn."""
        session, project = self._session_and_project(session_id)
        stream_task_id = self._resolve_task_id(session_id, task_id)
        if stream_task_id is None:
            raise NoTaskStreamError(session.id)
        with self._memory.seeding(project.id):
            seeded = self._client.seed_answer(
                stream_task_id, question_id=question_id, answers=answers
            )
            self._client.dispatch_seeded(seeded)
        return seeded.task_id

    def interrupt(self, task_id: str) -> None:
        """Halt the in-flight turn and keep the conversation.

        Called directly on the request thread, not queued behind the drive:
        that is the design, not a shortcut. The durable `TurnInterrupted` is
        written before the process-local registry mark, and the engine polls
        for it at turn boundaries — so it lands between steps and cannot abort
        a tool call already executing.

        The registry mark is set **only when a turn is in flight**, which is
        what makes this safe to call on a resting conversation: on an idle one
        an armed mark would sit there and swallow the user's next message.

        Raises `TaskAlreadyTerminalError` on a task that is already dead."""
        self._client.interrupt(task_id)

    def cancel(self, task_id: str) -> None:
        """Kill the conversation. Terminal, and not resumable.

        `interrupt` is what a Stop button wants; this is what deleting a
        session wants."""
        self._client.cancel(task_id)

    def fork(
        self, session_id: str, *, task_id: str, message_seq: int
    ) -> tuple[str, str]:
        """Branch at a user message, keeping the original. Returns the child.

        A fork is a **new child session**, not a sibling stream: the forked task
        becomes the child's own `root` stream, and the child records its
        parentage (`parent_session_id`, `source_task_id`, `branched_at_seq`) so
        the sidebar can nest it and the hub can splice its inherited history.
        Both sessions still share the project directory, because `fork`
        deliberately does not restore workspace files (that is `rewind`, exposed
        separately as "undo last turn"). Say so in the UI.

        Returns `(child_session_id, root_task_id)`: the session to open, and the
        stream the edited message is sent on.

        Raises `NotForkableError` for a source that cannot be branched (a
        subtask, a non-user message, the opening message with no prior turn)."""
        session, _ = self._session_and_project(session_id)
        source = self._resolve_task_id(session_id, task_id)
        if source is None:
            raise NoTaskStreamError(session_id)
        outcome = self._client.fork(source, message_seq=message_seq)
        child = sessions.create_session(
            self._store,
            session.project_id,
            title=fork_title(session.title),
            parent_session_id=session.id,
            source_task_id=source,
            branched_at_seq=message_seq,
        )
        self._bind(child.id, outcome.task_id, kind="root")
        return child.id, outcome.task_id

    def rewind(self, session_id: str, *, task_id: str, message_seq: int) -> str:
        """Undo the last turn(s): re-base **this** session's stream to before
        the user message at `message_seq`, restoring workspace files.

        The mirror of `fork` with the opposite retention. Both anchor on the
        same thing — the seq of a user-goal `MessagesAppended` — but where
        `fork` mints a new child session and leaves this stream untouched,
        `rewind` re-bases *this* stream in place: the anchored message, the
        output it triggered and every later turn become dead history (append
        only — a `TaskRewound` marker names a new fold baseline, nothing is
        deleted), and the workspace files the undone span edited are restored
        to their pre-turn bytes. There is **no** child session and nothing to
        navigate to; the conversation lands back on the prior turn boundary,
        immediately live. Returns the (unchanged) stream id.

        Under one directory per project every session shares one workspace, so
        this restore reverts files another session may have written after this
        point — the risk the UI must state before it calls this.

        Raises `NoTaskStreamError` on a session with no stream, and
        `NotRewindableError` for an anchor the stream cannot re-base to (not a
        user-goal message on it). The SDK raises a bare `RuntimeError` for the
        latter, so we pre-validate with the same predicate to give the API a
        coded 409, and wrap the call as a backstop against a validation race."""
        self._session_and_project(session_id)
        source = self._resolve_task_id(session_id, task_id)
        if source is None:
            raise NoTaskStreamError(session_id)
        if not _is_user_message_seq(self._client.events(source), message_seq):
            raise NotRewindableError(
                f"seq {message_seq} is not a user message on this stream"
            )
        try:
            outcome = self._client.rewind(source, message_seq=message_seq)
        except RuntimeError as exc:
            # The SDK's own anchor check raises a plain RuntimeError; a race
            # between our pre-validation and the driver would otherwise surface
            # as a 500. Re-raise as the coded refusal so it lands as a 409.
            raise NotRewindableError(str(exc)) from exc
        return outcome.task_id

    # -- internals ------------------------------------------------------------

    def _session_and_project(
        self, session_id: str
    ) -> tuple[sessions.Session, projects.Project]:
        session = sessions.get_session(self._store, session_id)
        if session is None:
            raise UnknownSessionError(session_id)
        project = projects.get_project(self._store, session.project_id)
        if project is None:
            # Cascading delete makes this unreachable through the API; it is
            # here so a corrupted row fails by name instead of by AttributeError
            # three frames into the seed.
            raise UnknownProjectError(session.project_id)
        return session, project

    def _resolve_model(
        self, project: projects.Project, model: str | None, effort: str | None
    ) -> tuple[str | None, str | None]:
        """The model and effort this turn runs at, validated.

        The turn's own choice wins, then the project's default, then nothing —
        in which case the host default model binds. Validation happens here so
        an unknown model, or an effort outside that model's ladder, is a
        synchronous 422 that **never reaches a gateway**.

        The two sources fail differently on purpose. A value the turn asked for
        is rejected: the user picked something that does not exist and has to
        be told. A value inherited from the project's saved defaults is dropped
        with a warning, because `models.json` can change under a project that
        was configured months ago, and refusing every turn of that project
        until someone edits its settings is a far worse failure than running it
        on the host default."""
        default_id = models_config.get_default_model(self._settings).id
        selector = model or project.default_model or None
        try:
            definition = models_config.validate_model(
                self._settings, selector or default_id
            )
        except models_config.ModelValidationError:
            if model:
                raise
            logger.warning(
                "project %s has a default model that is no longer configured (%r); "
                "falling back to %s",
                project.id,
                selector,
                default_id,
            )
            selector = None
            definition = models_config.validate_model(self._settings, default_id)

        chosen_effort = effort or project.default_effort or None
        if chosen_effort is not None and chosen_effort not in definition.efforts:
            if effort:
                raise models_config.ModelValidationError(
                    f"unknown effort for model {definition.id}: {chosen_effort}"
                )
            logger.warning(
                "project %s has a default effort %r that model %s does not offer; "
                "using the model's own default",
                project.id,
                chosen_effort,
                definition.id,
            )
            chosen_effort = None
        return selector, chosen_effort

    def _enabled_mcp(self, project_id: str) -> tuple[str, ...]:
        """The project's enabled connector tokens, computed once per turn.

        Per turn rather than per process, so editing a connector applies from
        the next message instead of mid-turn. A store failure degrades to no
        MCP: losing the connectors of one turn is recoverable, sinking the turn
        is not."""
        try:
            return projects.enabled_connector_tokens(self._store, project_id)
        except Exception:  # noqa: BLE001 - degrade to no MCP, never sink a turn
            logger.exception("could not read MCP connectors for project %s", project_id)
            return ()

    def _resolve_task_id(self, session_id: str, task_id: str | None) -> str | None:
        """Which stream a verb addresses. `None` means the session has none.

        An explicit `task_id` is checked against the reverse index rather than
        trusted: it arrives from a query string, and a task id from another
        session would otherwise splice two conversations together."""
        if task_id:
            binding = sessions.find_task_binding(self._store, task_id)
            if binding is None or binding.session_id != session_id:
                raise UnknownTaskStreamError(task_id)
            return task_id
        latest = sessions.latest_task_stream(self._store, session_id)
        return latest.task_id if latest is not None else None

    def _bind(
        self,
        session_id: str,
        task_id: str,
        *,
        kind: str,
        source_task_id: str | None = None,
        branched_at_seq: int | None = None,
    ) -> None:
        """Record a new stream against its session, without letting a failure
        strand the seed.

        The lease is already persisted by the time this runs. If a bookkeeping
        error propagated, nothing would ever dispatch it and the task would sit
        wedged until the worker pool's stale sweep reclaimed it minutes later —
        so a lost binding is logged and the turn drives anyway. The cost of the
        lost binding is that this task's memory resolves to the quarantine and
        its events cannot be routed to a session; the cost of the stalled lease
        is a session nobody can use."""
        try:
            sessions.add_task_stream(
                self._store,
                session_id,
                task_id,
                kind=kind,
                source_task_id=source_task_id,
                branched_at_seq=branched_at_seq,
            )
        except Exception:  # noqa: BLE001 - see the docstring
            logger.exception(
                "could not bind task %s to session %s; driving it anyway",
                task_id,
                session_id,
            )


def build_host(
    settings: Settings,
    *,
    provider: Any,
    store: sqlite3.Connection,
    delta_sink: DeltaSink | None = None,
    mcp_server_resolver: McpServerResolver | None = None,
    provider_headers: ProviderHeaders | None = None,
    sandbox_provider: Any | None = None,
    sandbox_spec: Any | None = None,
    sandbox_backend_factory: Any | None = None,
    sandbox_browser_factory: Any | None = None,
) -> AgentHost:
    """The whole engine-facing half of the process, in one call.

    What the FastAPI lifespan builds at startup and `close()`s at teardown.
    The tier policy and the memory-root resolver are constructed here so they
    share the connection the rest of the host reads, rather than being wired
    twice from two places."""
    memory_roots = MemoryRoots(store, settings.memories_path)
    client = build_client(
        settings,
        provider=provider,
        store=store,
        delta_sink=delta_sink,
        mcp_server_resolver=mcp_server_resolver,
        provider_headers=provider_headers,
        sandbox_provider=sandbox_provider,
        sandbox_spec=sandbox_spec,
        sandbox_backend_factory=sandbox_backend_factory,
        sandbox_browser_factory=sandbox_browser_factory,
        sandbox_policy=TierPolicy(store).wants_container,
        memory_root_resolver=memory_roots.resolve,
    )
    return AgentHost(
        client, settings=settings, store=store, memory_roots=memory_roots
    )
