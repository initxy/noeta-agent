"""Stopping a turn without ending the conversation.

Three verbs look alike from the outside and mean three different things, and
the product is wrong in a different way for each confusion:

- **`interrupt`** halts the turn and keeps the conversation. Confused with
  `cancel`, Stop deletes the user's context.
- **`cancel`** kills it. Confused with `interrupt`, "end this session" leaves a
  live task nobody can see.
- **a failed turn** does neither. 0.5.x parks a provider fault at a
  `TaskSuspended(turn_failed: …)` instead of sealing the ledger; read as fatal,
  one transient 5xx throws away everything the user built up.

The unit half runs against `StatusMachine` with `SimpleNamespace` envelopes,
because the interleaving it defends against (a request thread and a worker
thread emitting into one task) is a lottery no test can reproduce on purpose —
the machine is nearly pure, so the ordering is simply *stated*. The end-to-end
half runs against a real engine, because "the same session takes the next
message" is a claim about the whole stack and nothing smaller can make it.
"""
from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any, Optional

from noeta.agent.host.status import (
    IDLE,
    INTERRUPT_TYPE,
    RUNNING,
    TERMINAL_TYPES,
    StatusMachine,
)
from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    make_api,
    pacing_provider,
    text_provider,
    types_of,
)

NEXT_GOAL_HANDLE = "noeta-code-next-goal"


# ---------------------------------------------------------------------------
# Scripted models
# ---------------------------------------------------------------------------


def failing_provider(record: Optional[list] = None, *, failures: int = 1) -> Any:
    """A model whose first `failures` calls come back as errors.

    `stop_reason="error"` is the shape a gateway 5xx arrives in: the ReAct
    policy maps it to a non-retryable `FailDecision(llm_error)`, which the
    multi-turn wrapper rewrites into the parked suspend this file is about.
    Recording every request is how "the context survived" and "nothing
    auto-retried" become assertions rather than inspection.
    """
    from noeta.sdk import LLMResponse, TextBlock, Usage
    from noeta.sdk.testing import FakeLLMProvider

    state = {"calls": 0}

    def responder(request: Any) -> LLMResponse:
        state["calls"] += 1
        if record is not None:
            record.append(request)
        if state["calls"] <= failures:
            return LLMResponse(stop_reason="error", content=(), usage=Usage())
        return LLMResponse(
            stop_reason="end_turn",
            content=(TextBlock(text="recovered"),),
            usage=Usage(),
        )

    return FakeLLMProvider(responder=responder)


def user_texts(request: Any) -> list[str]:
    """Every user-authored line the model was shown, in order."""
    return [
        block.text
        for message in getattr(request, "messages", ())
        if getattr(message, "role", "") == "user"
        for block in (getattr(message, "content", ()) or [])
        if getattr(block, "text", None)
    ]


# ---------------------------------------------------------------------------
# Envelope builders
# ---------------------------------------------------------------------------


def envelope(event_type: str, *, task: str = "task-1", **payload: Any):
    return SimpleNamespace(
        type=event_type, task_id=task, seq=1, payload=SimpleNamespace(**payload)
    )


def suspended(reason: str, *, task: str = "task-1", handle: str = NEXT_GOAL_HANDLE):
    return envelope(
        "TaskSuspended",
        task=task,
        reason=reason,
        wake_on=SimpleNamespace(
            __canonical_tag__="human_response_received", handle=handle
        ),
    )


# ---------------------------------------------------------------------------
# The status machine: which stop closes a task
# ---------------------------------------------------------------------------


def test_the_interrupt_marker_ends_a_turn_without_ending_its_task():
    """The symmetry mistake, stated so it cannot be made quietly.

    `cancel` writes a terminal envelope, so it is tempting to give `interrupt`
    the same treatment. Doing it would close the task in the absorbing set and
    swallow every envelope of the conversation the user then resumes: the
    session would read `idle` while turns ran, and its `waiting` would never
    arrive — a permanently wedged conversation with no error anywhere."""
    assert INTERRUPT_TYPE not in TERMINAL_TYPES
    machine = StatusMachine()
    assert machine.observe(envelope("TaskStarted")) == RUNNING

    # Nothing moves: the engine polls the mark at a turn boundary, so the
    # agent is still working. Unlocking the composer here would be a lie.
    assert machine.observe(envelope(INTERRUPT_TYPE)) is None

    assert not machine.is_closed("task-1")
    assert machine.observe(suspended("interrupted")) == IDLE
    assert machine.observe(envelope("TaskWoken")) == RUNNING


def test_a_parked_failure_leaves_the_task_open():
    """`turn_failed` is resumable and `failed` is not.

    The failure arrives as a *suspend*, so it must not absorb — the next
    ordinary message wakes the same task, and a machine that had closed it
    would report nothing for the whole resumed turn."""
    machine = StatusMachine()
    machine.observe(envelope("TaskStarted"))

    assert machine.observe(suspended("turn_failed: gateway 503")) == IDLE

    assert not machine.is_closed("task-1")
    assert machine.observe(envelope("TaskWoken")) == RUNNING


def test_a_cancel_still_absorbs_the_trailing_frames_of_an_interrupted_turn():
    """Stop, then End. The worker's trailing envelopes arrive after the
    request thread's `TaskCancelled` and must not reopen the task — this is
    the absorbing rule, and `interrupt` does not get an exemption from it."""
    machine = StatusMachine()
    machine.observe(envelope("TaskStarted"))
    machine.observe(envelope(INTERRUPT_TYPE))
    assert machine.observe(envelope("TaskCancelled")) == IDLE

    assert machine.observe(envelope(INTERRUPT_TYPE)) is None
    assert machine.observe(suspended("interrupted")) is None


def test_an_interrupt_on_one_task_does_not_touch_a_sibling():
    """Branches live in one session, so the per-task keying is not theoretical
    once `fork` ships: stopping one branch must leave the other running."""
    machine = StatusMachine()
    machine.observe(envelope("TaskCancelled", task="branch"))

    assert machine.observe(envelope(INTERRUPT_TYPE, task="root")) is None
    assert machine.observe(suspended("interrupted", task="root")) == IDLE
    assert machine.observe(envelope("TaskWoken", task="root")) == RUNNING


# ---------------------------------------------------------------------------
# interrupt, end to end
# ---------------------------------------------------------------------------


def test_stop_halts_the_turn_and_the_same_session_takes_the_next_message(make_api):
    """The whole point of the verb, in one flow.

    The old product only had `cancel`, so "stop and keep going" was faked by
    catching `NotResumableError` and starting a *fresh* task — which reset the
    event seq to 0 under every connected client's cursor. Here the stream, the
    task and the context all survive."""
    ready = make_api(provider=pacing_provider())
    project, session = ready.open_session()
    first = ready.send(session["id"], "hello").json()["task_id"]
    ready.wait(session["id"], "running")

    stopped = ready.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})

    assert stopped.status_code == 202
    assert stopped.json()["task_id"] == first
    assert ready.wait(session["id"], "idle") == "idle"
    resumed = ready.send(session["id"], "carry on")
    assert resumed.status_code == 202
    assert resumed.json()["task_id"] == first
    assert len(ready.detail(session["id"])["task_streams"]) == 1


def test_the_stop_is_durable_and_reads_as_interrupted_after_a_refresh(make_api):
    """`turn_finished{interrupted}` carries a `seq`, so it is re-derived from
    the log rather than remembered by a connected client.

    A synthetic frame here would leave a refreshed tab showing a turn that
    never ended — the composer locked with nothing running."""
    ready = make_api(provider=pacing_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait(session["id"], "running")
    ready.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})
    ready.wait(session["id"], "idle")

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=3.0)

    endings = [f for f in frames if f.event == "turn_finished"]
    assert [f.data["status"] for f in endings] == ["interrupted"]
    assert endings[0].seq is not None
    # No `error` frame: a stop is not a fault, and rendering one would put a
    # red banner on something the user did on purpose.
    assert "error" not in types_of(frames)


def test_interrupt_on_a_terminal_stream_is_409(make_api):
    """`cancel` already ended it; there is no turn left to halt.

    A coded conflict rather than a silent 202: a Stop button that reports
    success on a dead conversation teaches the user that Stop does nothing.

    The turn is driven to rest first, and that is load-bearing rather than
    tidy. The engine decides "terminal" by folding, and a `TaskSuspended` the
    settling worker writes *after* the request thread's `TaskCancelled` folds
    the task back to `suspended` — so cancelling a turn mid-settle leaves the
    refusal genuinely racy. Our own status machine absorbs that trailing
    envelope (the session stays `idle` either way); the engine's fold does
    not, and this test states the settled case rather than a coin flip."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])
    assert (
        ready.http.post(f"/api/v1/sessions/{session['id']}/cancel", json={}).status_code
        == 202
    )
    ready.wait(session["id"], "idle")

    refused = ready.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})

    assert refused.status_code == 409
    assert ready.error(refused)["code"] == "task_terminal"


def test_interrupt_on_an_idle_conversation_does_not_swallow_the_next_message(make_api):
    """The engine arms the interrupt registry **only when a turn is in
    flight**, and this is the test that keeps the product honest about it.

    A Stop pressed after the answer already arrived — a double press, a stale
    button, an Esc on a resting session — would otherwise leave a mark sitting
    armed, and the user's next message would be halted the instant it started
    with no explanation on screen."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])

    stopped = ready.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})
    assert stopped.status_code == 202
    assert ready.detail(session["id"])["status"] == "idle"

    ready.send(session["id"], "second message")
    endings: list[Any] = []

    def both_turns_ended(frame: Any) -> bool:
        if frame.event == "turn_finished":
            endings.append(frame)
        return len(endings) >= 2

    frames = ready.frames(
        session["id"], params={"since_seq": 0}, until=both_turns_ended, timeout=20.0
    )

    # The second turn ran to a real ending, and the message it ran was the
    # user's — not swallowed by a stop issued before it was ever sent.
    assert [f.data["status"] for f in endings] == ["awaiting_input", "awaiting_input"]
    assert [f.data["content"] for f in frames if f.event == "user_message"] == [
        "hello",
        "second message",
    ]


def test_interrupt_before_the_first_message_is_409(api: Api):
    """A session is created with zero task streams (the first message seeds
    one), so there is nothing to stop yet."""
    project, session = api.open_session()

    refused = api.http.post(f"/api/v1/sessions/{session['id']}/interrupt", json={})

    assert refused.status_code == 409
    assert api.error(refused)["code"] == "no_task_stream"


def test_interrupt_cannot_reach_another_session_s_stream(api: Api):
    """`task_id` arrives in a request body, so it is checked against *this*
    session's streams rather than trusted. Stopping a stranger's turn from a
    session that does not own it is a cross-session write."""
    project = api.create_project()
    mine = api.create_session(project["id"])
    theirs = api.create_session(project["id"])
    api.send(theirs["id"], "hello")
    api.wait_turn(theirs["id"])
    other_task = api.detail(theirs["id"])["task_streams"][0]["task_id"]

    refused = api.http.post(
        f"/api/v1/sessions/{mine['id']}/interrupt", json={"task_id": other_task}
    )

    assert refused.status_code == 404
    assert api.error(refused)["code"] == "unknown_task_stream"


# ---------------------------------------------------------------------------
# A failed turn: parked, not sealed
# ---------------------------------------------------------------------------


def test_a_provider_failure_parks_the_turn_instead_of_sealing_the_session(make_api):
    """The 0.5.0 fix, observed through the wire.

    Before it, a `FailDecision` produced `TaskFailed` — terminal — and one
    transient 5xx threw away every bit of context the user had built. Now the
    turn rests where an ordinary turn rests, tagged with why, and the session
    goes `idle` so the composer unlocks."""
    ready = make_api(provider=failing_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")

    frames = ready.wait_turn(session["id"])

    ending = frames[-1]
    assert ending.event == "turn_finished"
    assert ending.data["status"] == "turn_failed"
    assert ending.data["reason"] == "llm_error"
    # No `error` frame. That one is paired with `turn_finished{failed}`, the
    # status that is *not* resumable — emitting it here would render the
    # conversation as broken when it is merely parked.
    assert "error" not in types_of(frames)
    assert ready.wait(session["id"], "idle") == "idle"


def test_the_next_message_resumes_a_failed_turn_with_its_context_intact(make_api):
    """Same task, same history — that uniformity is what makes the parked
    failure worth having. A new session would answer the retry with no idea
    what the conversation was about."""
    seen: list[Any] = []
    ready = make_api(provider=failing_provider(seen))
    project, session = ready.open_session()
    first = ready.send(session["id"], "summarise the readme").json()["task_id"]
    ready.wait_turn(session["id"])

    resumed = ready.send(session["id"], "try that again")

    assert resumed.status_code == 202
    assert resumed.json()["task_id"] == first
    frames = ready.frames(
        session["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "assistant_text",
        timeout=20.0,
    )
    assert frames[-1].data["text"] == "recovered"
    # The retry's request carries the message that failed, not just the new
    # one: the conversation was resumed, not restarted.
    assert "summarise the readme" in user_texts(seen[-1])
    assert len(ready.detail(session["id"])["task_streams"]) == 1


def test_a_parked_failure_is_never_auto_retried(make_api):
    """The parked turn is over; the next input is a *new* turn.

    Re-driving it from the host would replay a request the user never sent
    again — burning tokens, re-running whatever tools the turn had reached,
    and on a persistent gateway fault looping forever. Retry is a message."""
    seen: list[Any] = []
    ready = make_api(provider=failing_provider(seen, failures=99))
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])
    ready.wait(session["id"], "idle")

    calls_after_the_failure = len(seen)
    time.sleep(1.0)

    assert len(seen) == calls_after_the_failure
    assert ready.detail(session["id"])["status"] == "idle"
