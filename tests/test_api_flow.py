"""The REST surface end to end, against a real uvicorn and a real engine.

This module also hosts the **API harness** the rest of the HTTP-surface tests
import. It lives here rather than in `conftest.py` because the conftest is the
shared harness owned by the whole suite, and this is one slice's scaffolding:
booting an app whose engine runtime is installed, and the three verbs
(`project` / `session` / `send`) every test in this slice starts with.

What is pinned here is `LEDGER §9.3` — the API-flow regressions — minus the SSE
framing rows, which need the streaming reader and live in `test_sse.py`.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import httpx
import pytest

from noeta.agent.config import VERSION, Settings
from tests.conftest import LiveServer, SSEReader, build_app, serve_app, wait_status

# Bounds a hang rather than a slow machine: the offline mock answers instantly.
TIMEOUT = 30.0


# ---------------------------------------------------------------------------
# The harness
# ---------------------------------------------------------------------------


@contextmanager
def api_server(settings: Settings, *, provider: Any = None) -> Iterator[LiveServer]:
    """A booted backend with a scripted engine runtime installed.

    `install_runtime` wraps the application factory's lifespan, so the store
    still opens first and closes last and the engine host lives strictly
    inside it — the same ordering the shipped process uses, which is the only
    reason a test that skips it would be testing a different application.

    `provider` is injectable because some of these tests are *about* timing:
    a scripted slow model is how "reads never queue behind the drive worker"
    becomes an assertion instead of a hope.
    """
    with serve_app(build_app(settings, provider=provider), settings) as server:
        yield server


@dataclass(frozen=True)
class Api:
    """One booted backend, plus the three verbs every test opens with."""

    http: httpx.Client
    sse: SSEReader
    settings: Settings
    workdir: Path

    def create_project(self, **body: Any) -> dict[str, Any]:
        directory = body.pop("directory", None)
        if directory is None:
            directory = self.workdir / f"project-{len(list(self.workdir.iterdir()))}"
            Path(directory).mkdir(parents=True, exist_ok=True)
        payload = {"name": Path(directory).name, "directory": str(directory)}
        payload.update(body)
        response = self.http.post("/api/v1/projects", json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    def create_session(self, project_id: str, **body: Any) -> dict[str, Any]:
        response = self.http.post(
            f"/api/v1/projects/{project_id}/sessions", json=body or {}
        )
        assert response.status_code == 201, response.text
        return response.json()

    def open_session(self, **project_body: Any) -> tuple[dict, dict]:
        project = self.create_project(**project_body)
        return project, self.create_session(project["id"])

    def send(self, session_id: str, text: str = "hello", **body: Any) -> httpx.Response:
        return self.http.post(
            f"/api/v1/sessions/{session_id}/messages", json={"text": text, **body}
        )

    def detail(self, session_id: str) -> dict[str, Any]:
        response = self.http.get(f"/api/v1/sessions/{session_id}")
        assert response.status_code == 200, response.text
        return response.json()

    def wait(self, session_id: str, expected: Any, **kwargs: Any) -> str:
        return wait_status(self.http, session_id, expected, **kwargs)

    def frames(self, session_id: str, **kwargs: Any) -> list[Any]:
        return self.sse.read(f"/api/v1/sessions/{session_id}/events", **kwargs)

    def wait_turn(self, session_id: str, *, timeout: float = 20.0) -> list[Any]:
        """Read the stream until the turn comes to rest, and return the frames.

        Polling the status cannot express this: a session is `idle` both
        *before* its turn is picked up off the lease and *after* it finishes,
        so a poll that starts too early passes without the turn ever having
        run. The stream says it exactly once, and replay means this is not a
        race even when the turn is already over.
        """
        return self.frames(
            session_id,
            params={"since_seq": 0},
            until=lambda frame: frame.event in {"turn_finished", "question", "error"},
            timeout=timeout,
        )

    def error(self, response: httpx.Response) -> dict[str, Any]:
        """The `{code, message}` half of the contract's error envelope."""
        body = response.json()
        assert "error" in body, body
        return body["error"]


@contextmanager
def api_for(settings: Settings, *, provider: Any = None) -> Iterator[Api]:
    workdir = Path(settings.data_dir).parent / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    with api_server(settings, provider=provider) as server:
        with httpx.Client(base_url=server.base_url, timeout=TIMEOUT) as client:
            yield Api(
                http=client,
                sse=SSEReader(server.base_url),
                settings=settings,
                workdir=workdir,
            )


@pytest.fixture
def api(settings: Settings) -> Iterator[Api]:
    with api_for(settings) as ready:
        yield ready


@pytest.fixture
def make_api(make_settings: Callable[..., Settings]) -> Iterator[Callable[..., Api]]:
    """An `Api` from arbitrary settings or an injected provider.

    Use it when the test is *about* a configuration or a model's behaviour;
    `api` is the baseline."""
    from contextlib import ExitStack

    with ExitStack() as stack:

        def _make(*, provider: Any = None, **overrides: Any) -> Api:
            settings = make_settings(**overrides)
            return stack.enter_context(api_for(settings, provider=provider))

        yield _make


def pacing_provider(*, delay: float = 0.3, rounds: int = 15) -> Any:
    """A model that keeps one turn alive for a while.

    `rounds` tool calls spaced by `delay`, then an ordinary finish. Two tests
    need a turn that is still running when the next request arrives — `Stop`
    and "reads never queue behind the drive worker" — and neither can be
    written against a model that answers instantly. Bounded rather than
    endless on purpose: if the thing under test fails, the test fails on its
    assertion instead of hanging until the suite timeout.
    """
    from noeta.sdk import LLMResponse, TextBlock, ToolUseBlock, Usage
    from noeta.sdk.testing import FakeLLMProvider

    state = {"round": 0}

    def responder(request: Any) -> LLMResponse:
        state["round"] += 1
        time.sleep(delay)
        if state["round"] > rounds:
            return LLMResponse(
                stop_reason="end_turn", content=(TextBlock(text="done"),), usage=Usage()
            )
        return LLMResponse(
            stop_reason="tool_use",
            content=(
                ToolUseBlock(
                    call_id=f"call-{state['round']}",
                    tool_name="Bash",
                    arguments={"command": "echo hi"},
                ),
            ),
            usage=Usage(),
        )

    return FakeLLMProvider(responder=responder)


def text_provider(record: Optional[list] = None) -> Any:
    """A model that answers every request with one line and never calls a tool."""
    from noeta.sdk import LLMResponse, TextBlock, Usage
    from noeta.sdk.testing import FakeLLMProvider

    def responder(request: Any) -> LLMResponse:
        if record is not None:
            record.append(request)
        return LLMResponse(
            stop_reason="end_turn", content=(TextBlock(text="done"),), usage=Usage()
        )

    return FakeLLMProvider(responder=responder)


#: The child's goal, and how the delegating model recognises its own child:
#: a subagent runs through the same responder, so the two are told apart by the
#: conversation they are given rather than by a call counter.
SUBTASK_GOAL = "scout the workspace"

#: The agent the fan-out names. It must be one of the preset's spawnable
#: agents — a name outside that roster is answered with `SubtaskDenied` and no
#: child is ever created, which looks exactly like a subagent that finished
#: instantly.
SUBTASK_AGENT = "explore"


def delegating_provider(*, background: bool = True, child_delay: float = 0.0) -> Any:
    """A model that fans out to a subagent, then summarises.

    `background=True` gives the parent a `BackgroundSubagentStarted` and lets
    it keep going; `background=False` parks it on a subtask barrier, which is
    the state the status machine must read as `running` rather than idle.
    """
    from noeta.sdk import LLMResponse, TextBlock, ToolUseBlock, Usage
    from noeta.sdk.testing import FakeLLMProvider

    def responder(request: Any) -> LLMResponse:
        texts = [
            block.text
            for message in getattr(request, "messages", ())
            if getattr(message, "role", "") == "user"
            for block in (getattr(message, "content", ()) or [])
            if getattr(block, "text", None)
        ]
        blocks = [
            block
            for message in getattr(request, "messages", ())
            for block in (getattr(message, "content", ()) or [])
        ]
        is_child = any(SUBTASK_GOAL in text for text in texts)
        if is_child:
            if child_delay:
                time.sleep(child_delay)
            if any(getattr(b, "call_id", None) for b in blocks):
                return LLMResponse(
                    stop_reason="end_turn",
                    content=(TextBlock(text="scouted"),),
                    usage=Usage(),
                )
            return LLMResponse(
                stop_reason="tool_use",
                content=(
                    ToolUseBlock(
                        call_id="child-1",
                        tool_name="Bash",
                        arguments={"command": "echo scouting"},
                    ),
                ),
                usage=Usage(),
            )
        if any(getattr(b, "tool_name", "") == "Task" for b in blocks):
            return LLMResponse(
                stop_reason="end_turn",
                content=(TextBlock(text="the scout reported back"),),
                usage=Usage(),
            )
        return LLMResponse(
            stop_reason="tool_use",
            content=(
                ToolUseBlock(
                    call_id="spawn-1",
                    tool_name="Task",
                    arguments={
                        "description": "scout the workspace",
                        "subagent_type": SUBTASK_AGENT,
                        "prompt": SUBTASK_GOAL,
                        "background": background,
                    },
                ),
            ),
            usage=Usage(),
        )

    return FakeLLMProvider(responder=responder)


def question_id(frames: list[Any]) -> Optional[str]:
    for frame in frames:
        if frame.event == "question":
            return frame.data["question_id"]
    return None


def types_of(frames: list[Any]) -> list[str]:
    return [frame.event for frame in frames]


# ---------------------------------------------------------------------------
# Meta
# ---------------------------------------------------------------------------


def test_health_serves_the_contract_shape(api: Api):
    """`{status, version, provider, sandbox_available, data_dir}` — every field,
    every time.

    Compared as a whole object: the SPA types this response with required
    fields, so a dropped key is a client-side type that lies and an added one
    is wire surface nobody agreed to."""
    payload = api.http.get("/api/v1/health").json()

    assert payload == {
        "status": "ok",
        "version": VERSION,
        "provider": "mock",
        "sandbox_available": payload["sandbox_available"],
        "data_dir": str(api.settings.data_path),
    }
    # A real probe, so its value depends on the machine — but never on nothing.
    assert isinstance(payload["sandbox_available"], bool)


def test_health_answers_promptly_without_docker(api: Api, monkeypatch):
    """A machine with no Docker is a supported configuration.

    The sandbox tier cannot run there, and that is all it means: liveness must
    not hang on the probe, and must not fail on it either."""
    from noeta.agent.api import health as health_module

    health_module.reset_probe_cache()
    monkeypatch.setenv("PATH", "")
    try:
        response = api.http.get("/api/v1/health", timeout=5.0)
    finally:
        health_module.reset_probe_cache()

    assert response.status_code == 200
    assert response.json()["sandbox_available"] is False


def test_the_model_fallback_still_lets_a_session_be_created(make_api, tmp_path):
    """`models.json` missing degrades to one model — and the product still works.

    Row 24. A first run has no config of any kind, and "the model list is
    empty so nothing can be sent" would make that first run a dead end."""
    ready = make_api(models_config=str(tmp_path / "nope.json"))

    models = ready.http.get("/api/v1/models").json()["models"]
    assert len(models) == 1

    project, session = ready.open_session()
    assert ready.send(session["id"], "hello").status_code == 202


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


def test_project_crud(api: Api, tmp_path: Path):
    directory = tmp_path / "a-project"
    directory.mkdir()

    created = api.create_project(directory=directory, name="A Project")
    assert created["directory"] == str(directory.resolve())
    assert created["tier"] == "local"

    listed = api.http.get("/api/v1/projects").json()["projects"]
    assert [p["id"] for p in listed] == [created["id"]]

    patched = api.http.patch(
        f"/api/v1/projects/{created['id']}",
        json={"name": "Renamed", "tier": "sandbox", "default_effort": "high"},
    ).json()
    assert (patched["name"], patched["tier"]) == ("Renamed", "sandbox")
    assert patched["version"] > created["version"]

    assert api.http.delete(f"/api/v1/projects/{created['id']}").status_code == 204
    assert api.http.get(f"/api/v1/projects/{created['id']}").status_code == 404


def test_a_relative_directory_is_422_and_a_duplicate_is_409(api: Api, tmp_path: Path):
    """The two refusals the create form has to render, with their codes."""
    relative = api.http.post(
        "/api/v1/projects", json={"name": "x", "directory": "relative/path"}
    )
    assert relative.status_code == 422
    assert api.error(relative)["code"] == "invalid_directory"

    directory = tmp_path / "taken"
    directory.mkdir()
    api.create_project(directory=directory)
    duplicate = api.http.post(
        "/api/v1/projects", json={"name": "again", "directory": str(directory)}
    )
    assert duplicate.status_code == 409
    assert api.error(duplicate)["code"] == "duplicate_directory"


def test_create_directory_is_opt_in(api: Api, tmp_path: Path):
    """Off by default: a typo that 422s is fixed in the form, while a typo that
    silently creates `~/Documnets/app` is a directory nobody finds again."""
    missing = tmp_path / "not-there"
    refused = api.http.post(
        "/api/v1/projects", json={"name": "x", "directory": str(missing)}
    )
    assert refused.status_code == 422
    assert not missing.exists()

    created = api.create_project(directory=missing, create_directory=True)
    assert missing.is_dir()
    assert created["directory"] == str(missing.resolve())


def test_agent_config_round_trips(api: Api):
    project = api.create_project()
    path = f"/api/v1/projects/{project['id']}/agent-config"

    assert api.http.get(path).json() == {
        "persona": "",
        "default_model": "",
        "default_effort": "",
        "memory_enabled": False,
    }

    written = api.http.put(
        path,
        json={"persona": "terse", "default_effort": "low", "memory_enabled": True},
    ).json()
    assert written["persona"] == "terse"
    assert written["memory_enabled"] is True
    assert api.http.get(path).json() == written


def test_connector_reads_never_carry_a_credential(api: Api):
    """Every read path scrubs values to sorted name lists.

    Not by discipline: the store hands back a type with no field able to carry
    a value, so this asserts the property end to end — create, list, patch —
    rather than asserting one handler remembered."""
    project = api.create_project()
    base = f"/api/v1/projects/{project['id']}/connectors"
    secret = "sk-do-not-leak"

    created = api.http.post(
        base,
        json={
            "alias": "docs",
            "transport": "http",
            "url": "https://mcp.example/sse",
            "headers": {"Authorization": secret, "X-Trace": "on"},
            "env": {"TOKEN": secret},
        },
    )
    assert created.status_code == 201
    assert created.json()["header_names"] == ["Authorization", "X-Trace"]
    assert created.json()["env_names"] == ["TOKEN"]
    assert secret not in created.text

    listed = api.http.get(base)
    assert secret not in listed.text
    assert [c["alias"] for c in listed.json()["connectors"]] == ["docs"]

    patched = api.http.patch(f"{base}/docs", json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False
    assert secret not in patched.text

    assert api.http.delete(f"{base}/docs").status_code == 204
    assert api.http.get(base).json()["connectors"] == []
    assert api.http.patch(f"{base}/docs", json={"enabled": True}).status_code == 404


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def test_a_new_session_owns_zero_task_streams(api: Api):
    """The first message seeds the first stream, not the create call.

    That is what keeps an abandoned "New session" free: no engine task, no
    container, no workspace assembly until somebody says something."""
    project = api.create_project()
    session = api.create_session(project["id"])

    assert session["task_streams"] == []
    assert session["status"] == "idle"

    api.send(session["id"], "hello")
    api.wait(session["id"], ("idle", "waiting"))
    assert len(api.detail(session["id"])["task_streams"]) == 1


def test_the_first_message_titles_the_session(api: Api):
    """`LEDGER §9.6` 38/40, the synchronous half.

    The fallback is the *only* title the offline product ever gets — the
    generated one needs a gateway — so an unwired fallback means every sidebar
    row reads "Untitled session" forever. Pinned here rather than in
    `test_title_generation.py` because the trigger is the send endpoint.
    """
    project = api.create_project()
    session = api.create_session(project["id"])
    assert session["title"] == ""

    api.send(session["id"], "  Draft the launch plan\nand a timeline  ")
    api.wait(session["id"], ("idle", "waiting"))

    detail = api.detail(session["id"])
    # The first line, trimmed — not the whole message.
    assert detail["title"] == "Draft the launch plan"
    # False is what lets a real gateway still replace it, and what lets a
    # failed generation retry in a later process instead of being sealed.
    assert detail["title_generated"] is False


def test_a_later_message_does_not_retitle_the_session(api: Api):
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "first thing")
    api.wait(session["id"], ("idle", "waiting"))

    api.send(session["id"], "a completely different second thing")
    api.wait(session["id"], ("idle", "waiting"))

    assert api.detail(session["id"])["title"] == "first thing"


def test_a_hand_typed_title_survives_the_first_message(api: Api):
    """The user's words outrank the message's first line."""
    project = api.create_project()
    session = api.create_session(project["id"], title="mine")

    api.send(session["id"], "something else entirely")
    api.wait(session["id"], ("idle", "waiting"))

    assert api.detail(session["id"])["title"] == "mine"


def test_the_fallback_title_is_announced_on_the_stream(api: Api):
    """A sidebar that is already listening learns the title without polling.

    Read live, after `replay_done`, because the frame is **synthetic**: it
    carries no seq and is never replayed, so a reader that subscribes after the
    send legitimately misses it and re-reads the row instead.
    """
    project = api.create_project()
    session = api.create_session(project["id"])

    timeouts = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    with httpx.Client(base_url=api.sse.base_url, timeout=timeouts) as client:
        with client.stream(
            "GET", f"/api/v1/sessions/{session['id']}/events", params={"since_seq": 0}
        ) as response:
            lines = response.iter_lines()
            for line in lines:
                if line == "event: replay_done":
                    break
            api.send(session["id"], "name this session")
            seen: list[str] = []
            for line in lines:
                seen.append(line)
                if line == "" and "event: session_meta" in seen:
                    break

    frame = seen[seen.index("event: session_meta") :]
    frame = frame[: frame.index("")]
    assert frame == [
        "event: session_meta",
        'data: {"title": "name this session"}',
    ], frame
    # The whole block carries no `id:` line: a title is not derivable from the
    # event log, so the frame is synthetic and must never move a resume cursor.
    assert not [line for line in seen if line.startswith("id: ")]


def test_session_listing_patch_and_delete(api: Api):
    project = api.create_project()
    first = api.create_session(project["id"], title="one")
    api.create_session(project["id"], title="two")

    listed = api.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    assert {s["title"] for s in listed["sessions"]} == {"one", "two"}

    patched = api.http.patch(
        f"/api/v1/sessions/{first['id']}", json={"title": "renamed", "pinned": True}
    ).json()
    assert (patched["title"], patched["pinned"]) == ("renamed", True)
    # A hand-typed title is final: the generator must not overwrite it later.
    assert patched["title_generated"] is True

    assert api.http.delete(f"/api/v1/sessions/{first['id']}").status_code == 204
    assert api.http.get(f"/api/v1/sessions/{first['id']}").status_code == 404


def test_deleting_a_session_keeps_the_project_directory_and_the_trace(api: Api):
    """Deletion is deliberately lightweight, and deliberately incomplete.

    The project directory is **shared by every session of the project**, so
    removing it here would delete another session's work — the old per-session
    workspace made that safe and D2 does not. Engine data is preserved too: the
    trace page still resolves the execution by task id after the session row is
    gone."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], ("idle", "waiting"))
    task_id = api.detail(session["id"])["task_streams"][0]["task_id"]
    (Path(project["directory"]) / "kept.txt").write_text("still here")

    assert api.http.delete(f"/api/v1/sessions/{session['id']}").status_code == 204

    assert (Path(project["directory"]) / "kept.txt").read_text() == "still here"
    # The events are still in the engine's log; only the session index is gone.
    assert api.http.get(f"/api/v1/trace/sessions/{session['id']}/raw-events").status_code == 404
    other = api.create_session(project["id"])
    assert task_id not in json.dumps(api.detail(other["id"]))


# ---------------------------------------------------------------------------
# Turns
# ---------------------------------------------------------------------------


def test_409_on_a_concurrent_send_while_a_question_is_pending(api: Api):
    """Row 16. The status is `waiting`, and a second message is a conflict.

    Both halves matter: refusing keeps two turns from interleaving on one
    stream, and refusing with a *code* is what lets the composer say why."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")

    refused = api.send(session["id"], "again")

    assert refused.status_code == 409
    assert api.error(refused)["code"] == "session_busy"


def test_a_pending_question_produces_no_turn_finished(api: Api):
    """Row 17. A question is a resting place inside a turn, not the end of one.

    If it emitted `turn_finished`, the client would unlock the composer and
    show a finished turn while the agent waits — and the first `turn_finished`
    after an answer would no longer mean what it says."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")

    frames = api.frames(session["id"], params={"since_seq": 0}, timeout=2.0)

    assert "question" in types_of(frames)
    assert "turn_finished" not in types_of(frames)


def test_answering_finishes_the_turn(api: Api):
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")
    pending = question_id(api.frames(session["id"], params={"since_seq": 0}, timeout=2.0))

    accepted = api.http.post(
        f"/api/v1/sessions/{session['id']}/answer",
        json={
            "question_id": pending,
            "answers": {"0": {"selected": ["Engineer"], "other": None}},
        },
    )

    assert accepted.status_code == 202
    assert api.wait(session["id"], "idle") == "idle"
    frames = api.frames(session["id"], params={"since_seq": 0}, timeout=2.0)
    assert types_of(frames).count("turn_finished") == 1


def test_an_answer_the_engine_rejects_is_422(api: Api):
    """Not a 500: the body is the client's to fix, and the code says which."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")
    pending = question_id(api.frames(session["id"], params={"since_seq": 0}, timeout=2.0))

    refused = api.http.post(
        f"/api/v1/sessions/{session['id']}/answer",
        json={"question_id": pending, "answers": {"audience": "eng"}},
    )

    assert refused.status_code == 422
    assert api.error(refused)["code"] == "invalid_answer"


def test_a_rejected_answer_paints_nothing_into_the_conversation(api: Api):
    """A refusal the caller *saw* must not also be reported on the stream.

    The turn was never resumed and the session is still parked on its question,
    so an `error` + `turn_finished{failed}` here would paint a failed turn into
    a transcript that is correctly waiting — and disable the composer the user
    needs in order to answer. Only a failure the caller never sees (a drive
    thread throwing where a 500 is the answer) belongs on the stream.

    Read off a **live** connection, deliberately. Those two frames are synthetic
    and are never replayed, so a reader that attaches afterwards sees a clean
    transcript whether or not the bug is present — which is exactly how this
    went unnoticed."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")
    pending = question_id(api.frames(session["id"], params={"since_seq": 0}, timeout=2.0))

    rejected: list[Any] = []

    def refuse_once(frame: Any) -> bool:
        if not rejected:
            rejected.append(
                api.http.post(
                    f"/api/v1/sessions/{session['id']}/answer",
                    json={"question_id": pending, "answers": {"audience": "eng"}},
                )
            )
        return False

    # `until` runs per frame; `replay_done` is the one frame guaranteed to
    # arrive, so the bad answer is posted from inside the live connection and
    # anything it pushes lands on this reader.
    frames = api.frames(
        session["id"], params={"since_seq": 0}, until=refuse_once, timeout=2.0
    )

    assert rejected[0].status_code == 422
    assert "error" not in types_of(frames)
    assert "turn_finished" not in types_of(frames)
    # Still answerable, with the same question id.
    assert api.detail(session["id"])["status"] == "waiting"
    accepted = api.http.post(
        f"/api/v1/sessions/{session['id']}/answer",
        json={
            "question_id": pending,
            "answers": {"0": {"selected": ["Engineer"], "other": None}},
        },
    )
    assert accepted.status_code == 202


def test_interrupt_then_continue(make_api):
    """Row 20, reshaped for 0.5.x: **stop** is `interrupt`, and it continues.

    The old product only had `cancel`, which kills the conversation, so
    "stop and keep going" was faked by catching `NotResumableError` and
    starting a fresh task — which silently reset the event seq to 0 and left
    every connected cursor pointing at the wrong stream. 0.5.x makes the real
    verb available, and the same task resumes with its full context.

    The interrupt lands at a turn boundary, so it needs a turn that is
    actually mid-flight — hence the pacing model rather than the mock."""
    ready = make_api(provider=pacing_provider())
    project, session = ready.open_session()
    first = ready.send(session["id"], "hello").json()["task_id"]
    ready.wait(session["id"], "running")

    stopped = ready.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})
    assert stopped.status_code == 202
    ready.wait(session["id"], "idle")

    resumed = ready.send(session["id"], "carry on")
    assert resumed.status_code == 202
    # The SAME stream: interrupting does not fork, and does not restart.
    assert resumed.json()["task_id"] == first
    assert len(ready.detail(session["id"])["task_streams"]) == 1


def test_a_message_into_a_running_turn_steers_it(make_api):
    """A send while the turn runs is a **steer**, not a 409.

    Before 0.5.4 the only message verb required the task suspended on the
    next-goal handle, so `_require_idle` refused a running send outright and the
    composer's "Send to steer it" was a promise the API broke. `inject_goal`
    delivers the message into the live turn (a lease-free `InjectionRequested`
    the Engine drains at its next turn boundary), so:

    - the send is accepted (202), on the **same** stream — no fork, no restart;
    - the steer surfaces as an ordinary `user_message` frame, so the optimistic
      bubble the composer showed resolves in place;
    - no second task stream is created.

    The pacing model keeps the turn mid-flight long enough for the second
    request to arrive while the session is still `running` — the whole point."""
    ready = make_api(provider=pacing_provider())
    project, session = ready.open_session()
    first = ready.send(session["id"], "hello").json()["task_id"]
    ready.wait(session["id"], "running")

    steer = ready.send(session["id"], "also check the tests")

    assert steer.status_code == 202
    # The same stream: a steer joins the turn, it does not start a new one.
    assert steer.json()["task_id"] == first
    assert len(ready.detail(session["id"])["task_streams"]) == 1

    # The injected goal lands as a user_message the client can render. Read to
    # the turn's rest so the boundary drain has delivered it.
    frames = ready.wait_turn(session["id"])
    steers = [
        f
        for f in frames
        if f.event == "user_message" and "also check the tests" in f.data.get("content", "")
    ]
    assert steers, [f.event for f in frames]


def test_a_steer_pushes_no_second_turn_started(make_api):
    """A steer joins the live turn, so it must not emit `turn_started`.

    The optimistic `turn_started` covers `seed_start`'s container gap on an
    *idle* send; a running injection starts no turn, and a second `turn_started`
    would tell the client a new turn began — nesting the transcript or
    re-locking a composer that never unlocked. Exactly one `turn_started` for
    the opening send, none for the steer."""
    ready = make_api(provider=pacing_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait(session["id"], "running")

    ready.send(session["id"], "and this too")

    frames = ready.wait_turn(session["id"])
    assert [f.event for f in frames].count("turn_started") == 1


def test_interrupt_withdraws_a_task_parked_on_a_question(api: Api):
    """Stop on a pending question withdraws it and leaves the session resumable.

    The 0.6.2 "Esc" landing. Before it, `interrupt` was polled at turn
    boundaries and a pending question had no turn in flight, so Stop could not
    release it — the composer stayed locked on `waiting` with no way out but
    answering or a terminal `cancel`. Now `interrupt` withdraws the question:
    the session parks `idle` (no model turn), a `question_withdrawn` frame marks
    the card cancelled in the transcript, and the next ordinary message resumes
    the same conversation. Recorded as a test because a UI gets this wrong
    silently — a Stop that does nothing reads identical to a slow one."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait(session["id"], "waiting")

    assert api.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={}).status_code == 202

    # The question is withdrawn: the session rests idle, not waiting, and the
    # withdrawal is on the stream so the transcript can mark the card cancelled.
    api.wait(session["id"], "idle")
    frames = api.frames(
        session["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "question_withdrawn",
        timeout=10.0,
    )
    assert any(f.event == "question_withdrawn" for f in frames)

    # And the conversation is still live: a following message resumes it rather
    # than 409-ing, which a terminal `cancel` would not allow.
    assert api.send(session["id"], "never mind, carry on").status_code == 202


def test_fork_creates_a_child_session(make_api):
    """A fork mints a NEW session, nested under its source (D5 as of the
    fork-as-independent-session change).

    The endpoint returns `{session_id, task_id}`: the child to navigate to and
    its root stream. The parent is untouched. The exhaustive behavior — inherited
    history, reconnect, de-nest — lives in `test_fork.py`; this is the API-flow
    smoke that the contract shape is right."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "first")
    ready.wait_turn(session["id"])
    ready.send(session["id"], "second")
    ready.wait_turn(session["id"])
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=3.0)
    messages = [f for f in frames if f.event == "user_message"]
    assert [f.data["content"] for f in messages] == ["first", "second"]
    source = messages[1].data["_task"]

    forked = ready.http.post(
        f"/api/v1/sessions/{session['id']}/fork",
        json={"task_id": source, "message_seq": messages[1].seq},
    )

    assert forked.status_code == 201
    body = forked.json()
    assert body["session_id"] != session["id"]
    assert body["task_id"] != source
    # A second session in the project, nested under the source.
    index = ready.http.get(f"/api/v1/projects/{project['id']}/sessions").json()
    assert len(index["sessions"]) == 2
    child = next(s for s in index["sessions"] if s["id"] == body["session_id"])
    assert child["parent_session_id"] == session["id"]
    assert child["branched_at_seq"] == messages[1].seq
    # The parent keeps its lone stream — a fork writes nothing to it.
    assert [s["kind"] for s in ready.detail(session["id"])["task_streams"]] == ["root"]


def test_forking_the_opening_message_is_409(make_api):
    """There is no prior turn to branch from, and the refusal is coded.

    The client renders "start a new session instead" from the code; a 500
    would render as "something went wrong"."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "only message")
    ready.wait_turn(session["id"])
    opening = next(
        f
        for f in ready.frames(session["id"], params={"since_seq": 0}, timeout=3.0)
        if f.event == "user_message"
    )

    refused = ready.http.post(
        f"/api/v1/sessions/{session['id']}/fork",
        json={"task_id": opening.data["_task"], "message_seq": opening.seq},
    )

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "not_forkable"


def test_cancel_is_terminal_and_says_so(api: Api):
    """Cancel kills the conversation, and the next message is a **409**.

    Deliberately not the old degradation. Silently starting a fresh task on
    the same session looked friendlier and reset the event seq to 0 under
    every connected client; a conflict with a code is honest, and a new
    conversation is a new session."""
    project = api.create_project()
    session = api.create_session(project["id"])
    api.send(session["id"], "hello")
    api.wait(session["id"], ("waiting", "idle"))

    cancelled = api.http.post(f"/api/v1/sessions/{session['id']}/cancel", json={})
    assert cancelled.status_code == 202
    api.wait(session["id"], "idle")

    refused = api.send(session["id"], "please continue")
    assert refused.status_code == 409
    assert api.error(refused)["code"] in {"not_resumable", "task_terminal"}


def test_an_unsupported_effort_is_422_and_never_reaches_the_provider(make_api):
    """Row 25. Validation happens on the request thread, before the seed.

    The provider records every request it is given, so "never reached" is an
    assertion about a list rather than about a log line."""
    from noeta.sdk import LLMResponse, TextBlock, Usage
    from noeta.sdk.testing import FakeLLMProvider

    seen: list[Any] = []

    def responder(request: Any) -> LLMResponse:
        seen.append(request)
        return LLMResponse(
            stop_reason="end_turn", content=(TextBlock(text="ok"),), usage=Usage()
        )

    ready = make_api(provider=FakeLLMProvider(responder=responder))
    project, session = ready.open_session()

    refused = ready.send(session["id"], "hello", effort="ludicrous")

    assert refused.status_code == 422
    assert ready.error(refused)["code"] == "invalid_model"
    assert seen == []
    assert ready.detail(session["id"])["status"] == "idle"


def test_an_unknown_model_is_422(api: Api):
    project, session = api.open_session()

    refused = api.send(session["id"], "hello", model="gpt-does-not-exist")

    assert refused.status_code == 422
    assert api.error(refused)["code"] == "invalid_model"


def test_effort_reaches_the_provider(make_api):
    """The other half of row 25: a supported effort is not silently dropped."""
    seen: list[Any] = []
    ready = make_api(provider=text_provider(seen))
    project, session = ready.open_session()

    assert ready.send(session["id"], "hello", effort="low").status_code == 202
    ready.wait_turn(session["id"])

    assert [getattr(r, "effort", None) for r in seen] == ["low"]


def test_a_task_id_from_another_session_is_refused(api: Api):
    """A `task_id` arrives from a request body and is checked, never trusted:
    accepting one would splice two conversations onto one stream."""
    project = api.create_project()
    mine = api.create_session(project["id"])
    theirs = api.create_session(project["id"])
    api.send(theirs["id"], "hello")
    api.wait(theirs["id"], ("waiting", "idle"))
    stolen = api.detail(theirs["id"])["task_streams"][0]["task_id"]

    refused = api.send(mine["id"], "hello", task_id=stolen)

    assert refused.status_code == 404
    assert api.error(refused)["code"] == "unknown_task_stream"


def test_an_empty_message_with_no_attachment_is_422(api: Api):
    project, session = api.open_session()

    refused = api.send(session["id"], "   ")

    assert refused.status_code == 422
    assert api.error(refused)["code"] == "empty_message"
    assert api.detail(session["id"])["status"] == "idle"


def test_unknown_ids_are_404_with_the_error_envelope(api: Api):
    for path in (
        "/api/v1/projects/nope",
        "/api/v1/sessions/nope",
        "/api/v1/projects/nope/sessions",
        "/api/v1/sessions/nope/files",
    ):
        response = api.http.get(path)
        assert response.status_code == 404, path
        assert set(api.error(response)) == {"code", "message"}, path
