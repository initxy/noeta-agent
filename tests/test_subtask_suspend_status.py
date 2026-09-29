"""A subtask barrier is `running`, and the translator says nothing about it.

`LEDGER §9.4` rows 29-30 — the pair that has to hold *together*, because the
defect was one predicate written twice:

> the code looked for a `handle` field, which a subtask barrier does not have,
> so the status fell through to `idle` **and** the translator emitted
> `turn_finished` — a fake completion while the subagent was still executing,
> with the composer unlocked.

`SubtaskGroupCompleted` carries a canonical tag and **no** handle, and that
absence is exactly what distinguishes it from a human-response wake. Both
readers therefore key on the tag, and both import the same function.

Row 30 is the guard on the over-broad fix: `noeta-code-next-goal` must still be
`idle`, and `question-*` must still be `waiting`. A "any suspend while a
subtask exists is running" patch passes row 29 and breaks the product.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Optional

from noeta.agent.host.status import IDLE, RUNNING, WAITING, status_for
from noeta.agent.host.translator import is_subtask_barrier, translate
from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    delegating_provider,
    make_api,
    types_of,
)

BARRIER_TAGS = ("subtask_group_completed", "subtask_completed")
NEXT_GOAL_HANDLE = "noeta-code-next-goal"


def barrier(tag: str) -> SimpleNamespace:
    """A wake condition with a tag and **no handle** — the shape the defect
    could not see."""
    return SimpleNamespace(__canonical_tag__=tag)


def human_wake(handle: str) -> SimpleNamespace:
    return SimpleNamespace(__canonical_tag__="human_response_received", handle=handle)


def suspend(wake_on: Any, *, reason: str = "waiting_subtask_group") -> SimpleNamespace:
    return SimpleNamespace(
        type="TaskSuspended",
        task_id="task-1",
        seq=7,
        payload=SimpleNamespace(reason=reason, wake_on=wake_on),
    )


def no_deref(_: Any) -> Optional[bytes]:
    return None


# ---------------------------------------------------------------------------
# The predicate
# ---------------------------------------------------------------------------


def test_a_barrier_is_recognised_by_its_tag_not_by_a_handle():
    for tag in BARRIER_TAGS:
        assert is_subtask_barrier(barrier(tag)), tag
    assert not is_subtask_barrier(human_wake(NEXT_GOAL_HANDLE))
    assert not is_subtask_barrier(human_wake("question-c1"))
    assert not is_subtask_barrier(None)


def test_a_barrier_survives_the_round_trip_through_canonical_json():
    """A wake condition read back out of the ContentStore is a plain dict, not
    an object. Reading the tag structurally is what makes both spellings work
    — and what keeps this module free of engine imports."""
    for tag in BARRIER_TAGS:
        assert is_subtask_barrier({"__canonical_tag__": tag}), tag


# ---------------------------------------------------------------------------
# Row 29 / 30 — the two readers, together
# ---------------------------------------------------------------------------


def test_a_barrier_keeps_the_session_running_and_emits_nothing():
    """Both halves in one assertion block, because they failed as one.

    If either drifted, the session would look finished — composer unlocked,
    turn shown as complete — while a subagent was still executing."""
    for tag in BARRIER_TAGS:
        envelope = suspend(barrier(tag))

        assert status_for(envelope) == RUNNING, tag
        assert translate(envelope, no_deref) == [], tag


def test_a_question_wake_is_waiting_and_emits_nothing():
    """The `question` frame already expresses this state; a second frame
    saying "awaiting input" would race it into a wrong resting status."""
    envelope = suspend(human_wake("question-c1"), reason="waiting_human")

    assert status_for(envelope) == WAITING
    assert translate(envelope, no_deref) == []


def test_a_next_goal_wake_is_idle_and_finishes_the_turn():
    """Row 30's other half. This is an ordinary turn ending, and it must not
    be swept up by a fix aimed at barriers."""
    envelope = suspend(human_wake(NEXT_GOAL_HANDLE), reason="waiting_human")

    assert status_for(envelope) == IDLE
    frames = translate(envelope, no_deref)
    assert [(f.type, f.data["status"]) for f in frames] == [
        ("turn_finished", "awaiting_input")
    ]


def test_an_interrupted_suspend_is_idle_and_says_interrupted():
    envelope = suspend(human_wake(NEXT_GOAL_HANDLE), reason="interrupted")

    assert status_for(envelope) == IDLE
    assert translate(envelope, no_deref)[0].data["status"] == "interrupted"


def test_a_failed_turn_parks_rather_than_ending_the_conversation():
    """`turn_failed` is resumable and `failed` is not — the whole point of the
    0.5.0 fix. The session goes idle so the composer unlocks, and the next
    ordinary message resumes the same task."""
    envelope = suspend(human_wake(NEXT_GOAL_HANDLE), reason="turn_failed: gateway 503")

    assert status_for(envelope) == IDLE
    frame = translate(envelope, no_deref)[0]
    assert frame.data == {
        "status": "turn_failed",
        "reason": "gateway 503",
        "_task": "task-1",
    }


# ---------------------------------------------------------------------------
# End to end: a fan-out really does hold the session
# ---------------------------------------------------------------------------


def test_a_foreground_fan_out_holds_the_session_running(make_api):
    """While the subagent runs, the session is `running` — and a message sent
    into it is a **steer**, not a refusal.

    The status is what matters here: a foreground fan-out parks the parent on a
    subtask barrier, which reads as `running` (not `idle`), so the composer
    stays locked-as-busy rather than looking ready for a fresh turn. A message
    into that running parent is injected (`inject_goal`) — appended to the
    *current* turn and drained at the parent's next top-of-loop, after the
    children return — so it cannot seed a second turn that races the fan-out.
    The hazard the old 409 guarded (a new turn landing mid-fan-out, out of
    order) is structurally absent once the message is an in-turn injection."""
    ready = make_api(provider=delegating_provider(background=False, child_delay=1.5))
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.frames(
        session["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "subtask_started",
        timeout=10.0,
    )

    assert ready.detail(session["id"])["status"] == "running"
    steer = ready.send(session["id"], "meanwhile")
    assert steer.status_code == 202

    ready.wait_turn(session["id"], timeout=30.0)
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    kinds = types_of(frames)
    # Exactly one turn ending, at the end — not one per barrier. The steer rode
    # the same turn, so it adds no second `turn_finished`.
    assert kinds.count("turn_finished") == 1
    assert kinds.index("subtask_finished") < kinds.index("turn_finished")


def test_a_background_spawn_does_not_hold_the_session(make_api):
    """The contrast that makes the barrier rule meaningful.

    A background subagent does not park the parent — the parent finishes its
    turn and the child's result arrives later as a turn-boundary notice — so
    the composer must be *unlocked* while it runs."""
    ready = make_api(provider=delegating_provider(background=True, child_delay=1.0))
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.wait_turn(session["id"], timeout=10.0)

    assert ready.detail(session["id"])["status"] == "idle"
