"""The absorbing terminal state, per task id.

`LEDGER §9.4` rows 26-28. Unit-tested directly against `StatusMachine` because
the interleaving these guard is a lottery: `cancel` writes `TaskCancelled` on
the request thread while the same turn's `TaskSuspended` is written by a worker
at its own pace, and a test that tried to *reproduce* that ordering would be
the flakiest thing in the suite. The machine is nearly pure, so the ordering
can simply be *stated*.

The defect chain the first test replays, worth reading twice:

> worker emits `UserQuestionRequested` → `waiting`; the client sees waiting and
> posts `/cancel`; the **request thread** emits `TaskCancelled` → `idle`; the
> client sees idle and posts a new message; the **worker thread's** late
> `TaskSuspended(handle="question-…")` arrives and flips back to `waiting`; the
> new message is judged busy → **409**.

The symptom was a flaking `409 != 202`, and a session then stuck in `waiting`
forever with no real question anyone could answer.

Envelopes here are `SimpleNamespace`: the machine imports no engine type, so
the whole vocabulary can be written out in the test rather than provoked out of
a running engine.
"""
from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any, Optional

from noeta.agent.host import status as status_module
from noeta.agent.host.status import IDLE, RUNNING, WAITING, StatusMachine, status_for
from noeta.agent.host.translator import is_question_wake, is_subtask_barrier
from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    delegating_provider,
    make_api,
    types_of,
)

NEXT_GOAL_HANDLE = "noeta-code-next-goal"


def envelope(event_type: str, *, task: str = "task-1", **payload: Any) -> SimpleNamespace:
    return SimpleNamespace(
        type=event_type, task_id=task, seq=1, payload=SimpleNamespace(**payload)
    )


def wake(handle: Optional[str] = None, tag: str = "") -> SimpleNamespace:
    """A wake condition. A barrier has a canonical tag and **no handle** —
    that absence is what distinguishes it from a human-response wake."""
    condition = SimpleNamespace(__canonical_tag__=tag)
    if handle is not None:
        condition.handle = handle
    return condition


def suspended(*, handle: Optional[str] = None, tag: str = "", task: str = "task-1"):
    return envelope("TaskSuspended", task=task, reason="waiting_human", wake_on=wake(handle, tag))


# ---------------------------------------------------------------------------
# Row 26-28 — the absorbing state
# ---------------------------------------------------------------------------


def test_a_late_suspend_after_a_cancel_does_not_resurrect_waiting():
    """Row 26. The exact chain from the docstring, in order."""
    machine = StatusMachine()

    assert machine.observe(envelope("UserQuestionRequested")) == WAITING
    assert machine.observe(envelope("TaskCancelled")) == IDLE
    # The worker's trailing envelope, arriving after the request thread's.
    assert machine.observe(suspended(handle="question-c1")) is None


def test_a_late_start_after_a_terminal_does_not_resurrect_running():
    """Row 27. The same rule for the other direction — a task that terminated
    cannot report progress, whatever arrives afterwards."""
    machine = StatusMachine()
    machine.observe(envelope("TaskCompleted"))

    assert machine.observe(envelope("TaskStarted")) is None
    assert machine.observe(envelope("TaskWoken")) is None
    assert machine.observe(envelope("UserQuestionRequested")) is None


def test_the_absorbing_state_is_keyed_per_task_not_per_session():
    """Row 28, and the second half of cancel-then-continue.

    Keying it per session would mean that cancelling any task freezes the
    session forever: the next task's `TaskStarted` would be swallowed and the
    conversation would look permanently idle while it ran."""
    machine = StatusMachine()
    machine.observe(envelope("TaskCancelled", task="old"))

    assert machine.observe(envelope("TaskStarted", task="new")) == RUNNING
    assert machine.observe(envelope("TaskStarted", task="old")) is None


def test_every_terminal_type_absorbs():
    for terminal in ("TaskCancelled", "TaskFailed", "TaskCompleted"):
        machine = StatusMachine()
        assert machine.observe(envelope(terminal)) == IDLE
        assert machine.observe(envelope("TaskWoken")) is None, terminal


def test_a_suspend_is_not_terminal():
    """0.5.x parks a *failed* turn at a suspend precisely so the next message
    can resume it. Treating a suspend as absorbing would make every parked
    conversation unresumable."""
    machine = StatusMachine()

    assert machine.observe(suspended(handle=NEXT_GOAL_HANDLE)) == IDLE
    assert machine.observe(envelope("TaskWoken")) == RUNNING


def test_forgetting_a_task_is_only_for_a_deleted_session():
    machine = StatusMachine()
    machine.observe(envelope("TaskCancelled"))
    assert machine.is_closed("task-1")

    machine.forget("task-1")

    assert not machine.is_closed("task-1")


def test_the_terminal_memory_is_bounded():
    """The rule only has to outlive a race measured in milliseconds, so the
    memory is bounded and oldest-out — an unbounded one would grow for the life
    of a long-running local install."""
    machine = StatusMachine(memory=2)
    for index in range(3):
        machine.observe(envelope("TaskCancelled", task=f"task-{index}"))

    assert not machine.is_closed("task-0")
    assert machine.is_closed("task-2")


# ---------------------------------------------------------------------------
# Rows 29-30 — the handle/tag vocabulary, in full
# ---------------------------------------------------------------------------


def test_the_handle_and_tag_vocabulary():
    """The whole table the old suite pinned, in one place.

    `question-*` → waiting · `noeta-code-next-goal` → idle ·
    tag `subtask_group_completed` / `subtask_completed` → running."""
    assert status_for(suspended(handle="question-c1")) == WAITING
    assert status_for(suspended(handle="question-anything")) == WAITING
    assert status_for(suspended(handle=NEXT_GOAL_HANDLE)) == IDLE
    assert status_for(suspended(tag="subtask_group_completed")) == RUNNING
    assert status_for(suspended(tag="subtask_completed")) == RUNNING
    # An unknown suspend parks rather than failing: the tag is a legibility
    # field a new producer may extend without a protocol bump.
    assert status_for(suspended(handle="something-new")) == IDLE


def test_the_status_machine_and_the_translator_share_one_predicate():
    """Not two copies that agree today.

    They disagreed once: the code looked for a `handle` field, which a
    subtask barrier does not have, so the status fell through to idle *and*
    the translator emitted `turn_finished` — a fake completion while the
    subagent was still executing, with the composer unlocked."""
    assert status_module.is_subtask_barrier is is_subtask_barrier
    assert status_module.is_question_wake is is_question_wake


def test_an_envelope_that_says_nothing_moves_nothing():
    """Most envelopes are not status transitions, and treating them as one
    would rewrite the session's status on every tool call."""
    for quiet in ("MessagesAppended", "ToolCallStarted", "Compacted", "TaskSnapshot"):
        assert status_for(envelope(quiet)) is None, quiet


# ---------------------------------------------------------------------------
# Row 21 — the cancel cascade, on a live stream
# ---------------------------------------------------------------------------


def test_cancel_cascades_root_first_then_the_subtask(make_api):
    """Row 21. The root's `turn_finished{cancelled}` arrives first, then the
    subtask's `subtask_finished{cancelled}`.

    Order matters to the client: the parent's terminal frame is what
    force-closes every still-running step and subtask card, and it is the only
    one that survives a refresh — the cascade's own frames are synthetic and
    are not replayed."""
    ready = make_api(provider=delegating_provider(child_delay=1.5))
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    # The parent spawns in the background and parks; the child is still
    # working. Cancelling before the parent parks would cancel a turn with
    # nothing to cascade to yet.
    ready.wait_turn(session["id"], timeout=10.0)

    ready.http.post(f"/api/v1/sessions/{session['id']}/cancel", json={})
    frames = ready.frames(
        session["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "subtask_finished"
        and frame.data.get("status") == "cancelled",
        timeout=10.0,
    )

    kinds = [
        (f.event, (f.data or {}).get("status"))
        for f in frames
        if f.event in {"turn_finished", "subtask_finished"}
    ]
    assert ("turn_finished", "cancelled") in kinds
    assert kinds.index(("turn_finished", "cancelled")) < kinds.index(
        ("subtask_finished", "cancelled")
    )


def test_a_cancelled_subtask_is_wrapped_up_on_its_own_stream(make_api):
    """On a cascade the subtask writes only `TaskCancelled` to its own stream —
    no delivery event ever reaches the parent — so without the translator's
    wrap-up branch the subtask card stays "running" forever."""
    ready = make_api(provider=delegating_provider(child_delay=1.5))
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.wait_turn(session["id"], timeout=10.0)
    ready.http.post(f"/api/v1/sessions/{session['id']}/cancel", json={})
    ready.wait(session["id"], "idle")
    # The child's own terminal event is written by its driver, after ours.
    time.sleep(1.0)

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)

    closed = [
        f
        for f in frames
        if f.event == "subtask_finished" and f.data.get("status") == "cancelled"
    ]
    assert closed, "the subtask card was never closed"
    assert all(f.seq is None for f in closed)
