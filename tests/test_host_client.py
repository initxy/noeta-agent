"""The engine `Client`: how it is built, how it starts and stops, how it drives.

Three families here, and each guards a different kind of failure:

- **Configuration** — `bypassPermissions`, `write_mode="apply"`, the full model
  allowlist. Every one of these fails *silently* when it regresses: the product
  boots, answers, and quietly does nothing useful.
- **Lifecycle** — the startup and shutdown order, both of which are bug fixes
  rather than style.
- **Turn driving and the resolvers** — against a real `Client` and a fake
  provider, because the interaction between the seed lease, the durable
  task-stream binding and the memory-root window is exactly what a unit test of
  any one of them alone would miss.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from noeta.agent.config import Settings
from noeta.agent.host import client as host_client
from noeta.agent.host.client import AgentHost, build_client, build_host
from noeta.agent.host.memory import QUARANTINE_NAME, MemoryRoots
from noeta.agent.host.tiers import LOCAL, SANDBOX
from noeta.agent.host.workspace import AGENT_FILE_NAME
from noeta.agent.models_config import ModelValidationError, get_models
from noeta.agent.store import db, projects, sessions
from noeta.agent.store.errors import UnknownSessionError
from noeta.sdk import (
    LLMResponse,
    NotForkableError,
    PluginError,
    SandboxSpec,
    TextBlock,
    ToolUseBlock,
    Usage,
)
from noeta.sdk.testing import FakeLLMProvider

# Bounds a hang, not a slow machine: the fake provider answers instantly.
TURN_TIMEOUT = 20.0
POLL = 0.02


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    conn = db.connect(tmp_path / "app.db")
    db.bootstrap(conn)
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture
def provider() -> FakeLLMProvider:
    """A provider that answers every request with one line of text.

    A `responder` rather than a scripted list: the positional cursor of a
    scripted `FakeLLMProvider` is order-dependent and unusable the moment two
    turns run on two worker threads."""
    return FakeLLMProvider(
        responder=lambda request: LLMResponse(
            stop_reason="end_turn",
            content=(TextBlock(text="done"),),
            usage=Usage(),
        )
    )


@pytest.fixture
def make_project(store: sqlite3.Connection, tmp_path: Path) -> Callable[..., Any]:
    counter = iter(range(1, 1000))

    def _make(*, tier: str = LOCAL, **kwargs: Any) -> projects.Project:
        directory = tmp_path / f"project-{next(counter)}"
        directory.mkdir()
        return projects.create_project(
            store, name=directory.name, directory=str(directory), tier=tier, **kwargs
        )

    return _make


def tool_then_text(tool_name: str, arguments: dict[str, Any]) -> FakeLLMProvider:
    """A provider that calls one tool and then finishes.

    Routed on request *content* rather than a positional cursor: the scripted
    cursor of a `FakeLLMProvider` races the moment two turns run on two worker
    threads, and here it would also depend on how many rounds the loop takes."""

    def responder(request: Any) -> LLMResponse:
        already_called = any(
            isinstance(block, ToolUseBlock) or getattr(block, "call_id", None)
            for message in getattr(request, "messages", ())
            for block in getattr(message, "content", ())
        )
        if already_called:
            return LLMResponse(
                stop_reason="end_turn",
                content=(TextBlock(text="done"),),
                usage=Usage(),
            )
        return LLMResponse(
            stop_reason="tool_use",
            content=(
                ToolUseBlock(
                    call_id="call-1", tool_name=tool_name, arguments=arguments
                ),
            ),
            usage=Usage(),
        )

    return FakeLLMProvider(responder=responder)


@contextmanager
def started_host(
    settings: Settings, store: sqlite3.Connection, provider: FakeLLMProvider
) -> Iterator[AgentHost]:
    settings.ensure_data_dirs()
    built = build_host(settings, provider=provider, store=store)
    built.start()
    try:
        yield built
    finally:
        built.close()


@pytest.fixture
def host(
    settings: Settings, store: sqlite3.Connection, provider: FakeLLMProvider
) -> Iterator[AgentHost]:
    with started_host(settings, store, provider) as built:
        yield built


# ---------------------------------------------------------------------------
# Waiting for a turn
# ---------------------------------------------------------------------------


def suspend_count(host: AgentHost, task_id: str) -> int:
    return sum(1 for e in host.client.events(task_id) if e.type == "TaskSuspended")


def wait_parked(host: AgentHost, task_id: str, *, suspends: int) -> Any:
    """Poll until the stream has parked `suspends` times. Returns `TaskStatus`.

    Counting parks rather than reading the status is what makes a *second* turn
    waitable: the task is already `suspended` from the first one the moment the
    second is dispatched, so a status check returns immediately and the test
    races the worker."""
    deadline = time.monotonic() + TURN_TIMEOUT
    while time.monotonic() < deadline:
        status = host.client.task_status(task_id)
        if status is not None and status.status == "terminal":
            return status
        if suspend_count(host, task_id) >= suspends and status is not None:
            if status.status == "suspended":
                return status
        time.sleep(POLL)
    raise AssertionError(
        f"task {task_id} parked {suspend_count(host, task_id)} times, "
        f"wanted {suspends}; status {host.client.task_status(task_id)!r}"
    )


def drive(
    host: AgentHost, store: sqlite3.Connection, session_id: str, **kwargs: Any
) -> str:
    """Send a message and wait for the turn it starts to park."""
    latest = sessions.latest_task_stream(store, session_id)
    before = suspend_count(host, latest.task_id) if latest is not None else 0
    task_id = host.send_goal(session_id, **kwargs)
    wait_parked(host, task_id, suspends=before + 1)
    return task_id


def user_message_seqs(host: AgentHost, task_id: str) -> list[int]:
    """The `seq` of every user-goal `MessagesAppended` — the anchor `fork`
    takes. The bodies are `ContentRef`s, so they have to be deref'd."""
    seqs: list[int] = []
    for envelope in host.client.events(task_id):
        if envelope.type != "MessagesAppended":
            continue
        ref = getattr(envelope.payload, "messages_ref", None)
        if ref is None:
            continue
        raw = host.client.get_content(ref.hash)
        if raw is None:
            continue
        messages = json.loads(raw)
        if any(m.get("role") == "user" and not m.get("origin") for m in messages):
            seqs.append(envelope.seq)
    return seqs


# ---------------------------------------------------------------------------
# Configuration — the defaults that break the product silently
# ---------------------------------------------------------------------------


class _Capture:
    """Records the `Client` construction arguments instead of building one."""

    def __init__(self) -> None:
        self.args: tuple[Any, ...] = ()
        self.kwargs: dict[str, Any] = {}

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        self.args = args
        self.kwargs = kwargs
        return object()


@pytest.fixture
def capture(monkeypatch: pytest.MonkeyPatch) -> _Capture:
    recorder = _Capture()
    monkeypatch.setattr(host_client, "Client", recorder)
    return recorder


@pytest.fixture
def built(
    capture: _Capture,
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> _Capture:
    build_client(settings, provider=provider, store=store)
    return capture


def test_options_carry_bypass_permissions(built: _Capture) -> None:
    """D4. Anything else parks the turn on an approval suspend this product has
    no UI to answer, so the session wedges."""
    assert built.args[0].permission_mode == "bypassPermissions"


def test_can_use_tool_is_left_unset(built: _Capture) -> None:
    """It is a fallback, not a bypass: the tool still gets gated, the approval
    is still recorded, and each gated call costs a suspend/resume round. With
    nothing gated there is nothing for it to resolve."""
    assert built.args[0].can_use_tool is None


def test_the_preset_activations_are_not_replaced(built: _Capture) -> None:
    """`Options.plugins` is the activation tuple. Replacing it wholesale is the
    documented way to silently strip the agent of fs, web, memory and the
    rest."""
    from noeta.presets import main_options

    assert built.args[0].plugins == main_options().plugins


def test_host_config_applies_writes(built: _Capture) -> None:
    """The SDK default is `dry_run`, which stages a proposed diff and touches
    no disk: every edit reports success and changes nothing. This is the single
    most likely way to ship a workbench where editing does not edit."""
    assert built.kwargs["host_config"].write_mode == "apply"


def test_host_config_reads_project_instructions(built: _Capture) -> None:
    config = built.kwargs["host_config"]
    assert config.instructions_enabled is True
    assert config.instructions_discovery is True


def test_workflow_stays_off(built: _Capture) -> None:
    """There is no workflow feature, so `run_workflow` would be a tool the
    model can call and the product cannot serve."""
    assert built.kwargs["host_config"].workflow_allowed is False


def test_write_roots_keeps_the_single_root_wall(built: _Capture) -> None:
    """No approval UI means nobody to ask for a grant, so an out-of-workspace
    write failing is the honest answer."""
    assert built.kwargs["host_config"].write_roots is None


def test_the_whole_catalog_is_authorized(built: _Capture, settings: Settings) -> None:
    """`None` would authorize only {opus, sonnet, haiku} and reject every
    gateway model in models.json; `[]` would authorize no per-turn selector at
    all and make the dropdown a no-op."""
    assert list(built.kwargs["allowed_models"]) == [m.id for m in get_models(settings)]


def test_compaction_model_defaults_to_none(built: _Capture) -> None:
    """Empty `COMPACTION_MODEL` must reach the SDK as `None` — the summarize
    call then uses the per-turn model, byte-identical to having no knob. An
    empty string here would be a bogus model selector."""
    assert built.args[0].compaction_model is None


def test_compaction_model_is_wired_when_configured(
    capture: _Capture,
    make_settings: Callable[..., Settings],
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> None:
    """The compaction summarize call is non-streaming; the default chat model
    returns an empty non-streaming body and fails every compaction with
    `compaction_summary_failed`. Routing the summary to a model that answers
    non-streaming is the fix, so a configured `COMPACTION_MODEL` must land on
    `Options.compaction_model`."""
    build_client(
        make_settings(compaction_model="model_api/experimental_0723"),
        provider=provider,
        store=store,
    )
    assert capture.args[0].compaction_model == "model_api/experimental_0723"


def test_the_client_is_multi_turn(built: _Capture) -> None:
    """What makes a finishing turn land on a suspend instead of a terminal, so
    the session stays alive for the next message."""
    assert built.kwargs["multi_turn"] is True


def test_storage_points_at_the_engine_database(
    built: _Capture, settings: Settings
) -> None:
    """`noeta.db`, never `app.db`: the engine's log and the product's index are
    separate databases on purpose."""
    assert built.kwargs["host_config"].storage_path == str(settings.engine_db_path)
    assert built.kwargs["host_config"].storage_path != str(settings.app_db_path)


def test_trace_export_is_off_without_our_own_key(built: _Capture) -> None:
    assert built.kwargs["host_config"].otlp_traces is None


def test_the_ambient_otel_endpoint_does_not_enable_export(
    monkeypatch: pytest.MonkeyPatch,
    capture: _Capture,
    make_settings: Callable[..., Settings],
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> None:
    """A shared shell or a k8s operator injecting the OTel-standard variable
    for other processes must not silently start this one exporting a user's
    conversations. Only this product's own key enables it."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector/v1/traces")
    build_client(make_settings(), provider=provider, store=store)
    assert capture.kwargs["host_config"].otlp_traces is None


def test_our_own_key_does_enable_export(
    capture: _Capture,
    make_settings: Callable[..., Settings],
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> None:
    build_client(
        make_settings(
            otlp_endpoint="http://collector/v1/traces",
            otlp_headers="authorization=Bearer%20t",
        ),
        provider=provider,
        store=store,
    )
    traces = capture.kwargs["host_config"].otlp_traces
    assert traces is not None
    assert traces.endpoint == "http://collector/v1/traces"
    assert traces.headers == (("authorization", "Bearer t"),)


def test_the_seams_default_to_absent(built: _Capture) -> None:
    """No delta sink, no MCP resolver, no sandbox provider: the offline product
    is the same host with fewer things plugged into it."""
    config = built.kwargs["host_config"]
    assert config.delta_sink is None
    assert config.mcp_server_resolver is None
    assert config.provider_headers is None
    assert config.sandbox_provider is None


def test_the_injected_seams_reach_the_host_config(
    capture: _Capture,
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> None:
    sink, resolver, headers, sandbox = object(), object(), object(), object()
    build_client(
        settings,
        provider=provider,
        store=store,
        delta_sink=sink,  # type: ignore[arg-type]
        mcp_server_resolver=resolver,  # type: ignore[arg-type]
        provider_headers=headers,  # type: ignore[arg-type]
        sandbox_provider=sandbox,
    )
    config = capture.kwargs["host_config"]
    assert config.delta_sink is sink
    assert config.mcp_server_resolver is resolver
    assert config.provider_headers is headers
    assert config.sandbox_provider is sandbox


def test_the_tier_policy_and_memory_resolver_are_wired_by_default(
    built: _Capture,
) -> None:
    assert built.kwargs["host_config"].sandbox_policy is not None
    assert built.kwargs["host_config"].memory_root_resolver is not None


def test_a_plugin_load_fault_degrades_instead_of_refusing_to_boot(
    monkeypatch: pytest.MonkeyPatch,
    capture: _Capture,
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
) -> None:
    """A bad plugin is not a bad product. Refusing to boot leaves the user with
    a process that will not start and no way to remove the plugin from inside
    it."""

    def explode(**_: Any) -> Any:
        raise PluginError("broken manifest")

    monkeypatch.setattr(host_client, "load_plugins", explode)
    build_client(settings, provider=provider, store=store)
    assert capture.kwargs["plugins"] is None


def test_a_real_client_builds_and_shuts_down(
    settings: Settings, store: sqlite3.Connection, provider: FakeLLMProvider
) -> None:
    """The capture tests above never construct a `Client`; this one does, so a
    configuration those tests approve of but the SDK rejects fails here."""
    settings.ensure_data_dirs()
    client = build_client(settings, provider=provider, store=store)
    client.shutdown()


def test_an_edit_actually_touches_the_disk(
    settings: Settings, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """The end-to-end form of `write_mode="apply"`, and worth its cost.

    Under the SDK default the same call still records `success=True` and a
    summary reading `+1/-0 (7B, proposed)` — a staged diff nobody applies. The
    only observable difference is the file, so the file is what the test looks
    at. An assertion on the config value would pass against a runtime that
    stopped honouring it."""
    provider = tool_then_text("Write", {"file_path": "hello.txt", "content": "written"})
    with started_host(settings, store, provider) as built:
        project = make_project()
        session = sessions.create_session(store, project.id)
        drive(built, store, session.id, text="write hello.txt")
        assert (Path(project.directory) / "hello.txt").read_text() == "written"


def test_a_high_risk_tool_runs_without_an_approval_round(
    settings: Settings, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """The end-to-end form of `bypassPermissions`.

    `Write` is declared high-risk, so under the SDK's default mode this turn
    parks on a `approval-call-1` wake handle instead of finishing — and this
    product has no approval UI, so nothing would ever answer it and the session
    would wedge with the composer disabled."""
    provider = tool_then_text("Write", {"file_path": "hello.txt", "content": "written"})
    with started_host(settings, store, provider) as built:
        project = make_project()
        session = sessions.create_session(store, project.id)
        task_id = drive(built, store, session.id, text="write hello.txt")
        types = [e.type for e in built.client.events(task_id)]
        assert "ToolCallApprovalRequested" not in types
        assert built.client.task_status(task_id).wake_handle == "noeta-code-next-goal"


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


class _RecordingClient:
    """Records the order of the lifecycle calls `AgentHost` makes."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.workers: int | None = None

    def subscribe(self, callback: Any) -> Callable[[], None]:
        self.calls.append("subscribe")

        def _unsubscribe() -> None:
            self.calls.append("unsubscribe")

        return _unsubscribe

    def add_sandbox_lifecycle_listener(self, on_allocate: Any, on_release: Any) -> None:
        self.calls.append("add_sandbox_lifecycle_listener")

    def start_workers(self, num_workers: int) -> None:
        self.calls.append("start_workers")
        self.workers = num_workers

    def shutdown(self) -> None:
        self.calls.append("shutdown")


def make_host(
    settings: Settings, store: sqlite3.Connection
) -> tuple[AgentHost, _RecordingClient]:
    recorder = _RecordingClient()
    built = AgentHost(
        recorder,  # type: ignore[arg-type]
        settings=settings,
        store=store,
        memory_roots=MemoryRoots(store, settings.memories_path),
    )
    return built, recorder


def test_startup_subscribes_before_the_workers_run(
    settings: Settings, store: sqlite3.Connection
) -> None:
    """The constructor has already re-driven any background subagent orphaned
    by a prior crash, and the moment the pool starts, envelopes flow — so a
    subscriber attached afterwards misses the beginning of whatever the pool
    picks up."""
    built, recorder = make_host(settings, store)
    built.start(on_envelope=lambda env: None, on_sandbox_allocate=lambda *a: None)
    assert recorder.calls == [
        "subscribe",
        "add_sandbox_lifecycle_listener",
        "start_workers",
    ]


def test_the_worker_count_comes_from_settings(
    make_settings: Callable[..., Settings], store: sqlite3.Connection
) -> None:
    built, recorder = make_host(make_settings(agent_num_workers=3), store)
    built.start()
    assert recorder.workers == 3


def test_shutdown_detaches_before_it_reaps(
    settings: Settings, store: sqlite3.Connection
) -> None:
    """`Client.shutdown()` owns the ordering that matters — workers, observers,
    OTLP, then containers. Ours is only to let go of our own subscriber first."""
    built, recorder = make_host(settings, store)
    built.start(on_envelope=lambda env: None)
    built.close()
    assert recorder.calls[-2:] == ["unsubscribe", "shutdown"]


def test_shutdown_is_idempotent(settings: Settings, store: sqlite3.Connection) -> None:
    """The lifespan teardown can run more than once, and a second shutdown that
    raised would mask whatever it was cleaning up after."""
    built, recorder = make_host(settings, store)
    built.start(on_envelope=lambda env: None)
    built.close()
    built.close()
    assert recorder.calls.count("shutdown") == 1


def test_shutdown_reaps_even_when_unsubscribing_fails(
    settings: Settings, store: sqlite3.Connection
) -> None:
    """An interactive session rests at `suspended` forever and never reaches a
    root terminal, so its container is reaped only by the shutdown backstop.
    Losing that to a failing observer would leak one container per live
    session."""
    built, recorder = make_host(settings, store)

    def subscribe(callback: Any) -> Callable[[], None]:
        recorder.calls.append("subscribe")

        def _boom() -> None:
            raise RuntimeError("observer already gone")

        return _boom

    recorder.subscribe = subscribe  # type: ignore[method-assign]
    built.start(on_envelope=lambda env: None)
    built.close()
    assert "shutdown" in recorder.calls


def test_starting_twice_is_refused(
    settings: Settings, store: sqlite3.Connection
) -> None:
    """`start_workers` raises on a second call anyway; failing here says which
    layer double-started."""
    built, _ = make_host(settings, store)
    built.start()
    with pytest.raises(RuntimeError):
        built.start()


def test_the_host_is_a_context_manager(
    settings: Settings, store: sqlite3.Connection
) -> None:
    built, recorder = make_host(settings, store)
    with built:
        built.start()
    assert recorder.calls[-1] == "shutdown"


def test_shutdown_runs_while_a_session_is_still_parked(
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
    make_project: Callable[..., Any],
) -> None:
    """The reason shutdown is mandatory rather than tidy.

    An interactive session rests at `suspended` forever and never reaches a
    root terminal, so the container it holds is released only by
    `teardown_exec_env` at the end of `Client.shutdown()`. A process that exits
    without it leaks one container per live session — and "live" here means
    every session the user ever opened."""
    with started_host(settings, store, provider) as built:
        project = make_project()
        session = sessions.create_session(store, project.id)
        task_id = drive(built, store, session.id, text="hello")
        assert built.client.task_status(task_id).status == "suspended"
        assert built.client.workers_running is True
    assert built.client.workers_running is False


# ---------------------------------------------------------------------------
# Turn driving, against a real Client
# ---------------------------------------------------------------------------


def test_the_first_message_seeds_a_root_stream(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """A session is created with zero streams; the first message mints one and
    binds it, which is what makes the reverse index answer for it afterwards."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    assert sessions.list_task_streams(store, session.id) == []

    task_id = drive(host, store, session.id, text="hello")

    streams = sessions.list_task_streams(store, session.id)
    assert [(s.task_id, s.kind) for s in streams] == [(task_id, "root")]


def test_a_second_message_reuses_the_same_stream(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    first = drive(host, store, session.id, text="hello")
    second = drive(host, store, session.id, text="again")
    assert second == first
    assert len(sessions.list_task_streams(store, session.id)) == 1


def test_the_turn_lands_on_a_suspend_not_a_terminal(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """`multi_turn=True`. A terminal here would end the conversation after one
    answer."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    assert host.client.task_status(task_id).status == "suspended"
    assert host.client.suspend_reason(task_id).kind == "waiting_human"


def test_the_project_directory_becomes_the_workspace(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """D2: every session of a project shares the project directory. The path is
    welded into `TaskHostBound` at `seed_start`, which is also what makes the
    tier deterministic across a resume."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    bound = [e for e in host.client.events(task_id) if e.type == "TaskHostBound"]
    assert bound, "no TaskHostBound on the stream"
    assert bound[0].payload.workspace_dir == project.directory


def test_two_sessions_of_one_project_share_the_directory(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    tasks = [
        drive(host, store, sessions.create_session(store, project.id).id, text="hello")
        for _ in range(2)
    ]
    assert tasks[0] != tasks[1]
    workspaces = {
        e.payload.workspace_dir
        for task_id in tasks
        for e in host.client.events(task_id)
        if e.type == "TaskHostBound"
    }
    assert workspaces == {project.directory}


def test_no_turn_passes_a_per_turn_permission_mode(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
) -> None:
    """The per-turn value has the HIGHEST priority in the runtime's
    resolution — above the host config — precisely so a frontend selector is
    not a no-op. Passing even `"default"` on one turn therefore re-arms every
    gate for that turn, and this product has no UI to answer them with."""
    seen: list[dict[str, Any]] = []
    for verb in ("seed_start", "seed_send_goal", "seed_answer"):
        original = getattr(type(host.client), verb)

        def spy(self: Any, *args: Any, _original: Any = original, **kwargs: Any) -> Any:
            seen.append(kwargs)
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(type(host.client), verb, spy)

    project = make_project()
    session = sessions.create_session(store, project.id)
    drive(host, store, session.id, text="hello")
    drive(host, store, session.id, text="again")

    assert len(seen) == 2
    assert all("permission_mode" not in kwargs for kwargs in seen)


def test_an_unknown_session_is_refused_by_name(host: AgentHost) -> None:
    with pytest.raises(UnknownSessionError):
        host.send_goal("no-such-session", text="hello")


def test_an_unknown_model_never_reaches_the_provider(
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    provider: FakeLLMProvider,
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(ModelValidationError):
        host.send_goal(session.id, text="hello", model="not-a-model")
    assert provider.received_requests == []
    assert sessions.list_task_streams(store, session.id) == []


def test_an_effort_the_model_does_not_offer_is_refused(
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    settings: Settings,
    provider: FakeLLMProvider,
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(ModelValidationError):
        host.send_goal(
            session.id,
            text="hello",
            model=get_models(settings)[0].id,
            effort="not-an-effort",
        )
    assert provider.received_requests == []


def test_a_stale_project_default_does_not_wedge_the_project(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """`models.json` can change under a project configured months ago.
    Refusing every one of its turns until someone edits its settings is a far
    worse failure than running on the host default — which is why an inherited
    value is dropped where a value the turn asked for is rejected."""
    project = make_project(default_model="retired-model", default_effort="nope")
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    assert host.client.task_status(task_id).status == "suspended"


def test_the_project_default_model_binds_when_the_turn_asks_for_nothing(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    settings: Settings,
) -> None:
    model = get_models(settings)[0]
    effort = model.efforts[0]
    project = make_project(default_model=model.id, default_effort=effort)
    session = sessions.create_session(store, project.id)

    seen: list[dict[str, Any]] = []
    original = type(host.client).seed_start

    def spy(self: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        return original(self, **kwargs)

    monkeypatch.setattr(type(host.client), "seed_start", spy)
    drive(host, store, session.id, text="hello")
    assert seen[0]["model_selector"] == model.id
    assert seen[0]["effort"] == effort


def test_assembly_runs_before_the_turn(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """Per turn rather than once at creation, so a persona edit applies from
    the next message — the same rule the enabled-MCP alias list follows."""
    project = make_project(persona="Answer only in haiku.")
    session = sessions.create_session(store, project.id)
    drive(host, store, session.id, text="hello")
    assert (
        "Answer only in haiku."
        in (Path(project.directory) / AGENT_FILE_NAME).read_text()
    )


def test_the_enabled_connectors_ride_the_turn(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
) -> None:
    """Computed at seed time, so a connector edit applies from the next turn
    rather than mid-turn; disabled connectors never appear."""
    project = make_project()
    projects.create_connector(
        store, project.id, "search", transport="http", url="http://x"
    )
    projects.create_connector(
        store, project.id, "off", transport="http", url="http://y", enabled=False
    )
    session = sessions.create_session(store, project.id)

    seen: list[dict[str, Any]] = []
    original = type(host.client).seed_start

    def spy(self: Any, **kwargs: Any) -> Any:
        seen.append(kwargs)
        return original(self, **kwargs)

    monkeypatch.setattr(type(host.client), "seed_start", spy)
    drive(host, store, session.id, text="hello")
    assert seen[0]["enabled_mcp"] == (f"{project.id}:search",)


def test_a_store_failure_degrades_to_no_mcp_rather_than_sinking_the_turn(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
) -> None:
    def explode(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("app.db is on fire")

    monkeypatch.setattr(host_client.projects, "enabled_connector_tokens", explode)
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    assert host.client.task_status(task_id).status == "suspended"


def test_an_explicit_task_id_from_another_session_is_refused(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """It arrives from a query string. Trusting it would splice two
    conversations together."""
    project = make_project()
    mine = sessions.create_session(store, project.id)
    theirs = sessions.create_session(store, project.id)
    other_task = drive(host, store, theirs.id, text="hello")
    with pytest.raises(host_client.UnknownTaskStreamError):
        host.send_goal(mine.id, text="hello", task_id=other_task)


def test_an_unknown_task_id_is_refused(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(host_client.UnknownTaskStreamError):
        host.send_goal(session.id, text="hello", task_id="task-nobody-knows")


def test_answering_before_any_message_is_refused_by_name(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(host_client.NoTaskStreamError):
        host.answer(session.id, question_id="q", answers={})


def test_interrupt_keeps_the_conversation_alive(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """The distinction the whole of Phase 2 rests on: `interrupt` stops the
    turn, `cancel` kills the conversation."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    host.interrupt(task_id)
    assert host.client.task_status(task_id).status == "suspended"
    resumed = drive(host, store, session.id, text="carry on")
    assert resumed == task_id
    assert host.client.task_status(task_id).status == "suspended"


def test_cancel_is_terminal(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    host.cancel(task_id)
    assert host.client.task_status(task_id).status == "terminal"


def test_a_fork_is_an_independent_child_session(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """A fork mints a NEW session, nested under its parent, with the forked
    task as that child's own `root` stream. Both sessions still share the
    project directory, which is why `rewind` is not exposed."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    root = drive(host, store, session.id, text="hello")
    drive(host, store, session.id, text="and again")
    anchor = user_message_seqs(host, root)[-1]

    child_id, branch = host.fork(session.id, task_id=root, message_seq=anchor)

    # A second session, not a sibling stream: the parent keeps its lone root.
    assert child_id != session.id
    assert branch != root
    parent_streams = sessions.list_task_streams(store, session.id)
    assert [s.task_id for s in parent_streams] == [root]

    # The child owns the forked task as its own root, and records its lineage.
    child = sessions.get_session(store, child_id)
    assert child is not None
    assert child.project_id == project.id
    assert child.parent_session_id == session.id
    assert child.source_task_id == root
    assert child.branched_at_seq == anchor
    child_streams = sessions.list_task_streams(store, child_id)
    assert [(s.task_id, s.kind) for s in child_streams] == [(branch, "root")]


def test_a_fork_inherits_the_project_memory_pool(
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    settings: Settings,
) -> None:
    """The child session is in the same project, so its root task resolves
    through the reverse index to the same memory pool — no special case."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    root = drive(host, store, session.id, text="hello")
    drive(host, store, session.id, text="and again")
    _, branch = host.fork(
        session.id, task_id=root, message_seq=user_message_seqs(host, root)[-1]
    )
    assert host.client.memory_root(branch) == settings.memories_path / project.id


def test_forking_the_opening_message_is_refused_by_name(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """0.5.1 exports `NotForkableError`, so it is caught by name rather than
    through `CodedError` plus a code string."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    root = drive(host, store, session.id, text="hello")
    opening = user_message_seqs(host, root)[0]
    with pytest.raises(NotForkableError):
        host.fork(session.id, task_id=root, message_seq=opening)
    assert len(sessions.list_task_streams(store, session.id)) == 1


def test_forking_a_session_with_no_stream_is_refused_by_name(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(host_client.NoTaskStreamError):
        host.fork(session.id, task_id="", message_seq=0)


def test_a_rewind_rebases_the_same_stream(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """The mirror of fork, and the opposite retention: rewind re-bases THIS
    stream in place rather than minting a child. No new session, same stream,
    and the undone turn is gone from a fresh fold of it."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    root = drive(host, store, session.id, text="hello")
    drive(host, store, session.id, text="and again")
    seqs_before = user_message_seqs(host, root)
    assert len(seqs_before) == 2
    anchor = seqs_before[-1]

    task_id = host.rewind(session.id, task_id=root, message_seq=anchor)

    # Same stream, no child: the project still has exactly one session and the
    # rewound task IS the stream we asked for.
    assert task_id == root
    assert len(sessions.list_task_streams(store, session.id)) == 1
    assert sessions.get_session(store, session.id).parent_session_id is None
    # A `TaskRewound` marker was appended (append-only — the dead tail stays on
    # the raw log), re-basing the stream to before the undone turn. Its
    # `target_seq` is below the anchor, which is the baseline the client folds
    # the tail away from (the client-side truncation is covered by the web fold
    # tests; the host contract is that the marker exists and points correctly).
    rewound = [e for e in host.client.events(root) if e.type == "TaskRewound"]
    assert len(rewound) == 1
    assert rewound[0].payload.target_seq < anchor
    # The stream is immediately live again — a following send drives a fresh
    # turn from the re-based baseline rather than 409-ing.
    resumed = drive(host, store, session.id, text="third")
    assert resumed == root


def test_a_rewind_restores_the_disk(
    settings: Settings, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """The file half of a rewind — the whole reason D6 was cautious. A turn
    that wrote a file, undone, leaves the disk as it was before that turn.

    The provider writes only on the turn whose message contains ``writeit`` and
    has no prior tool call, so the write lands squarely in the second turn — the
    one the rewind undoes. (A cursor-scripted provider would write on turn one
    and the file would sit *before* the rewind boundary, proving nothing.)"""

    def responder(request: Any) -> LLMResponse:
        text = " ".join(
            getattr(block, "text", "")
            for message in getattr(request, "messages", ())
            for block in getattr(message, "content", ())
        )
        already_called = any(
            getattr(block, "call_id", None)
            for message in getattr(request, "messages", ())
            for block in getattr(message, "content", ())
        )
        if "writeit" in text and not already_called:
            return LLMResponse(
                stop_reason="tool_use",
                content=(
                    ToolUseBlock(
                        call_id="c1",
                        tool_name="Write",
                        arguments={"file_path": "made.txt", "content": "v2"},
                    ),
                ),
                usage=Usage(),
            )
        return LLMResponse(
            stop_reason="end_turn", content=(TextBlock(text="done"),), usage=Usage()
        )

    with started_host(settings, store, FakeLLMProvider(responder=responder)) as built:
        project = make_project()
        session = sessions.create_session(store, project.id)
        first = drive(built, store, session.id, text="hello")
        drive(built, store, session.id, text="writeit please")
        made = Path(project.directory) / "made.txt"
        assert made.read_text() == "v2"

        # Undo the second turn (the write's turn): its file had no pre-turn
        # baseline, so restoring means deleting it.
        anchor = user_message_seqs(built, first)[-1]
        built.rewind(session.id, task_id=first, message_seq=anchor)
        assert not made.exists()


def test_rewinding_a_non_user_seq_is_refused_by_name(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """A bad anchor is a product-coded `NotRewindableError` (a clean 409), not
    the bare `RuntimeError` the SDK raises — the product pre-validates so the
    API never has to string-match an exception."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    root = drive(host, store, session.id, text="hello")
    # A seq that is not a user-goal MessagesAppended on this stream.
    bogus = max(e.seq for e in host.client.events(root)) + 1
    with pytest.raises(host_client.NotRewindableError):
        host.rewind(session.id, task_id=root, message_seq=bogus)


def test_rewinding_a_session_with_no_stream_is_refused_by_name(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    project = make_project()
    session = sessions.create_session(store, project.id)
    with pytest.raises(host_client.NoTaskStreamError):
        host.rewind(session.id, task_id="", message_seq=0)


def test_a_binding_failure_still_drives_the_turn(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
) -> None:
    """The seed has already persisted the lease. If bookkeeping propagated,
    nothing would dispatch it and the task would sit wedged until the worker
    pool's stale sweep reclaimed it minutes later. A lost binding costs this
    task its memory pool and its event routing; a stalled lease costs the user
    the session."""

    def explode(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("app.db is on fire")

    monkeypatch.setattr(host_client.sessions, "add_task_stream", explode)
    project = make_project()
    session = sessions.create_session(store, project.id)
    task_id = host.send_goal(session.id, text="hello")
    assert wait_parked(host, task_id, suspends=1).status == "suspended"


# ---------------------------------------------------------------------------
# Memory roots
# ---------------------------------------------------------------------------


def test_memory_keys_on_the_project_not_the_session(
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    settings: Settings,
) -> None:
    """D2. Sessions in a project are the same body of work, so a memory written
    in one has to be recallable in the next."""
    project = make_project()
    roots = {
        host.client.memory_root(
            drive(
                host, store, sessions.create_session(store, project.id).id, text="hello"
            )
        )
        for _ in range(2)
    }
    assert roots == {settings.memories_path / project.id}


def test_two_projects_never_share_a_memory_pool(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    roots = []
    for _ in range(2):
        project = make_project()
        session = sessions.create_session(store, project.id)
        roots.append(host.client.memory_root(drive(host, store, session.id, text="hi")))
    assert roots[0] != roots[1]


def test_the_memory_root_is_resolved_during_the_seed_not_after(
    monkeypatch: pytest.MonkeyPatch,
    host: AgentHost,
    store: sqlite3.Connection,
    make_project: Callable[..., Any],
    settings: Settings,
) -> None:
    """Correcting the host guide, which says a mapping registered *between*
    `seed_start` and the dispatch is early enough: the resolver is already
    called inside `seed_start`, on the seeding thread. Without the thread-local
    window the very first engine of every new session would resolve to the
    quarantine — and engines are cached per resolved root.

    Pinned by resolving **from another thread**, which is what the durable
    index alone can answer at that moment — and which also pins the window as
    thread-local rather than process-wide, the property that keeps two
    concurrent seeds from seeing each other's project."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    elsewhere = MemoryRoots(store, settings.memories_path)

    seen: list[Path] = []
    original = type(host.client).seed_start

    def spy(self: Any, **kwargs: Any) -> Any:
        seeded = original(self, **kwargs)
        # Exactly what the resolver faced a moment ago: the task exists in the
        # engine, and in no table of ours.
        assert sessions.find_task_binding(store, seeded.task_id) is None
        off_thread: list[Path] = []
        worker = threading.Thread(
            target=lambda: off_thread.append(elsewhere.resolve(seeded.task_id))
        )
        worker.start()
        worker.join()
        seen.extend(off_thread)
        return seeded

    monkeypatch.setattr(type(host.client), "seed_start", spy)
    task_id = drive(host, store, session.id, text="hello")

    assert seen == [settings.memories_path / QUARANTINE_NAME]
    assert host.client.memory_root(task_id) == settings.memories_path / project.id


def test_the_seeding_window_answers_from_the_first_call(
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
    make_project: Callable[..., Any],
) -> None:
    """The positive half of the test above: with the window open, the resolver
    answers the project pool from its very first call — the one inside
    `seed_start`, before any binding exists — so no engine is ever cached
    against the quarantine."""
    settings.ensure_data_dirs()
    roots = MemoryRoots(store, settings.memories_path)
    answered: list[Path] = []

    def recording(task_id: str) -> Path:
        resolved = roots.resolve(task_id)
        answered.append(resolved)
        return resolved

    client = build_client(
        settings, provider=provider, store=store, memory_root_resolver=recording
    )
    built = AgentHost(client, settings=settings, store=store, memory_roots=roots)
    built.start()
    try:
        project = make_project()
        session = sessions.create_session(store, project.id)
        drive(built, store, session.id, text="hello")
    finally:
        built.close()

    assert answered, "the memory root resolver was never consulted"
    assert set(answered) == {settings.memories_path / project.id}


def test_an_unresolvable_task_is_quarantined_not_pooled(
    store: sqlite3.Connection, settings: Settings
) -> None:
    """A resolution failure must yield NO recall, never another project's.
    Returning `None` would fall through to `HostConfig.memory_dir` — a pool
    every project reads."""
    roots = MemoryRoots(store, settings.memories_path)
    quarantine = settings.memories_path / QUARANTINE_NAME
    assert roots.resolve("task-nobody-knows") == quarantine
    assert roots.resolve("") == quarantine
    assert roots.resolve(None) == quarantine


def test_a_failing_store_quarantines_instead_of_raising(
    tmp_path: Path, settings: Settings
) -> None:
    conn = db.connect(tmp_path / "closed.db")
    db.bootstrap(conn)
    conn.close()
    roots = MemoryRoots(conn, settings.memories_path)
    assert roots.resolve("t") == settings.memories_path / QUARANTINE_NAME


def test_a_project_id_that_is_not_a_path_segment_is_quarantined(
    store: sqlite3.Connection, settings: Settings
) -> None:
    """Ids are uuid4 hex, so this never fires on a real row — it is here so a
    corrupted one cannot turn a memory root into a path traversal."""
    roots = MemoryRoots(store, settings.memories_path)
    quarantine = settings.memories_path / QUARANTINE_NAME
    for bad in ("..", "../../etc", "a/b", "", "with space", "/abs"):
        assert roots.root_for_project(bad) == quarantine, bad


def test_the_seeding_window_is_per_thread(
    store: sqlite3.Connection, settings: Settings
) -> None:
    """The resolver runs on the thread that called `seed_start`, so two
    requests seeding two sessions concurrently must not see each other's
    project."""
    roots = MemoryRoots(store, settings.memories_path)
    observed: dict[str, Path] = {}
    both_inside = threading.Barrier(2)

    def seed(project_id: str) -> None:
        with roots.seeding(project_id):
            both_inside.wait(timeout=5)
            observed[project_id] = roots.resolve("unbound-task")

    threads = [threading.Thread(target=seed, args=(pid,)) for pid in ("aaa", "bbb")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert observed == {
        "aaa": settings.memories_path / "aaa",
        "bbb": settings.memories_path / "bbb",
    }


def test_the_seeding_window_closes(
    store: sqlite3.Connection, settings: Settings
) -> None:
    roots = MemoryRoots(store, settings.memories_path)
    with roots.seeding("aaa"):
        assert roots.resolve("t") == settings.memories_path / "aaa"
    assert roots.resolve("t") == settings.memories_path / QUARANTINE_NAME


def test_a_nested_seed_restores_its_callers_window(
    store: sqlite3.Connection, settings: Settings
) -> None:
    """A consolidation run seeded from a turn boundary would otherwise clear
    the project of the turn that triggered it."""
    roots = MemoryRoots(store, settings.memories_path)
    with roots.seeding("outer"):
        with roots.seeding("inner"):
            assert roots.resolve("t") == settings.memories_path / "inner"
        assert roots.resolve("t") == settings.memories_path / "outer"


def test_the_durable_binding_wins_over_a_stale_window(
    store: sqlite3.Connection, settings: Settings, make_project: Callable[..., Any]
) -> None:
    """A resumed task after a restart has no window at all, so the index has to
    be the answer — and where both exist, the index is the one that survived a
    process."""
    project = make_project()
    session = sessions.create_session(store, project.id)
    sessions.add_task_stream(store, session.id, "task-1")
    roots = MemoryRoots(store, settings.memories_path)
    with roots.seeding("some-other-project"):
        assert roots.resolve("task-1") == settings.memories_path / project.id


# ---------------------------------------------------------------------------
# Tiers, through the built host
# ---------------------------------------------------------------------------


def test_a_sandbox_project_without_a_provider_still_runs(
    host: AgentHost, store: sqlite3.Connection, make_project: Callable[..., Any]
) -> None:
    """No Docker configured means no `sandbox_provider`, and the runtime never
    consults the policy without one. A project whose tier says `sandbox` on a
    machine with no container runtime degrades to local rather than refusing
    the turn — which is what keeps `python -m noeta.agent` a usable product
    with no Docker."""
    project = make_project(tier=SANDBOX)
    session = sessions.create_session(store, project.id)
    task_id = drive(host, store, session.id, text="hello")
    bound = [e for e in host.client.events(task_id) if e.type == "TaskHostBound"]
    assert bound[0].payload.exec_env_ref in (None, "")


def test_the_policy_is_consulted_once_at_seed_start(
    settings: Settings,
    store: sqlite3.Connection,
    provider: FakeLLMProvider,
    make_project: Callable[..., Any],
) -> None:
    """The tier is welded into `TaskHostBound` on turn 1 and fold-resolved
    afterwards. That weld is what makes the policy deterministic across a
    resume, and it is why changing a project's tier only affects sessions
    created afterwards."""
    settings.ensure_data_dirs()
    calls: list[tuple[str, str | None]] = []

    class _Provider:
        def allocate(self, root_task_id: str, spec: Any) -> Any:
            raise AssertionError("the policy said no")

        def release(self, root_task_id: str) -> None:
            pass

        def attach(self, exec_env_ref: str) -> Any:
            raise AssertionError("nothing to attach")

    def policy(root_task_id: str, workspace_dir: str | None) -> bool:
        calls.append((root_task_id, workspace_dir))
        return False

    client = build_client(
        settings,
        provider=provider,
        store=store,
        sandbox_provider=_Provider(),
        sandbox_spec=SandboxSpec(image="unused"),
        sandbox_policy=policy,
    )
    built = AgentHost(
        client,
        settings=settings,
        store=store,
        memory_roots=MemoryRoots(store, settings.memories_path),
    )
    built.start()
    try:
        project = make_project()
        session = sessions.create_session(store, project.id)
        drive(built, store, session.id, text="hello")
        assert [workspace for _task, workspace in calls] == [project.directory]
        drive(built, store, session.id, text="again")
        assert len(calls) == 1
    finally:
        built.close()


