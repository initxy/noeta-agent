"""The session status machine: `idle` / `running` / `waiting`, derived from
the envelope stream.

Split out of the hub and kept nearly pure because the interleaving it defends
against is a lottery — a worker thread and a request thread emit into the same
task with no ordering guarantee — and the regressions it prevents were the most
expensive ones in the suite this rewrite replaces.

Three rules carry all the weight:

**A terminal state is absorbing, per `task_id`.** `cancel` writes
`TaskCancelled` on the request thread while the same turn's `TaskSuspended` is
written by a worker at its own pace. A late `TaskSuspended(question-*)` would
otherwise flip an already-terminated turn back to `waiting` and **wedge the
session permanently**: every new message gets a 409, yet there is no real
question anybody can answer. Keyed per task rather than per session, so
cancelling an old task cannot freeze the session's next one.

**A subtask barrier is `running`, not idle.** The predicate reads the wake
condition's canonical tag, never a `handle` field — `SubtaskGroupCompleted`
has no handle, and that absence is exactly what distinguishes a barrier from a
human-response wake. Reading for a handle and falling through to idle is the
defect that unlocked the composer while a subagent was still executing. The
translator and this module import the **same** predicate
(`translator.is_subtask_barrier`) so the two can never disagree.

**Stopping a turn is not ending a task.** The three stop-shaped engine verbs
write three different envelopes and only one of them is terminal:

| verb | writes | this machine |
| --- | --- | --- |
| `interrupt` (mid-turn) | `TurnInterrupted`, then the turn's own `TaskSuspended(interrupted)` | not terminal — the suspend moves the session to `idle` and the task stays open |
| `interrupt` (on a question) | `TaskWoken`, `UserQuestionWithdrawn`, then `TaskSuspended(next-goal)` | not terminal — the trailing suspend moves the session to `idle`; the withdrawal itself moves nothing (0.6.2) |
| `cancel` | `TaskCancelled` | terminal and absorbing |
| `close` | `ConversationClosed` | never seen — this product does not expose archiving |

Reading the first row as terminal is the symmetry mistake this module names
explicitly rather than leaves to a fall-through: it would close the task in the
absorbing set, and every envelope of the conversation the user then resumes
would be swallowed — the session would read `idle` while turns ran, and its
`waiting` would never arrive.

The module imports no engine type: envelopes are read structurally, exactly as
in `translator.py`, so the whole machine is unit-testable with
`types.SimpleNamespace`.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Optional

from noeta.agent.host.translator import is_question_wake, is_subtask_barrier

IDLE = "idle"
RUNNING = "running"
WAITING = "waiting"

#: The whole vocabulary, in the order the store's CHECK constraint names it.
STATUSES = (IDLE, RUNNING, WAITING)

#: Envelope types after which nothing this task emits may move the session
#: again. `TaskSuspended` is deliberately absent: a suspend is a resting place,
#: not an end, and 0.5.x parks a *failed* turn there precisely so the next
#: message can resume it.
TERMINAL_TYPES = frozenset({"TaskCancelled", "TaskFailed", "TaskCompleted"})

#: What `interrupt` writes on the request thread. Named here — rather than left
#: to fall through the bottom of `status_for` — because it is the one envelope
#: that ends a *turn* without ending its *task*, and the whole point of having
#: `interrupt` as a separate verb from `cancel` is lost the moment it joins the
#: set above. See the module docstring's third rule.
INTERRUPT_TYPE = "TurnInterrupted"

#: How many terminated task ids the machine remembers. The absorbing rule only
#: has to outlive the race it guards — the milliseconds between a cancel on the
#: request thread and the worker's trailing envelopes — so a bounded, oldest-out
#: memory is enough, and an unbounded one would grow for the life of the
#: process on a long-lived local install.
TERMINAL_MEMORY = 4096


def status_for(env: Any) -> Optional[str]:
    """The session status this envelope implies, or `None` for "unchanged".

    Pure and total: no clock, no state, no I/O. Everything that decides a
    status is on the envelope, which is what lets the interleaving cases be
    written as a flat list of assertions rather than a threading test.
    """
    etype = getattr(env, "type", "")

    if etype == "UserQuestionRequested":
        # Ahead of the `question` frame on purpose (the hub applies this
        # before it fans out): a client that answers the instant it sees the
        # question must not lose a race against the not-yet-written
        # `TaskSuspended`.
        return WAITING

    if etype == "UserQuestionWithdrawn":
        # 0.6.2: a Stop on a pending question withdraws it. The driver reuses
        # the wake+settle seam, so this rides between a `TaskWoken` (RUNNING)
        # and the trailing `TaskSuspended(next-goal)` (IDLE) that actually
        # rests the session. Like `INTERRUPT_TYPE`, this envelope itself moves
        # nothing — the suspend is what lands the session idle. Answering
        # `idle` here would unlock the composer a beat before the suspend is
        # durable; leave it to the suspend, exactly as interrupt does.
        return None

    if etype in ("TaskStarted", "TaskWoken"):
        return RUNNING

    if etype == INTERRUPT_TYPE:
        # The stop landed, and nothing has stopped yet. The engine polls the
        # mark at a turn boundary and cannot abort a tool call already
        # executing, so the agent is still working here; the turn's own
        # `TaskSuspended(interrupted)` is what moves the session. Answering
        # `idle` would unlock the composer mid-tool-call, and answering
        # `terminal` would close a task the user is about to keep talking to.
        return None

    if etype == "TaskSuspended":
        wake_on = getattr(getattr(env, "payload", None), "wake_on", None)
        if is_subtask_barrier(wake_on):
            # Subagents are still executing. The parent is parked on the
            # barrier, not resting — so the session is `running`, not `idle`,
            # and the composer stays locked-as-busy. A message sent here is a
            # steer: `inject_goal` appends it to this same turn, drained at the
            # parent's next top-of-loop after the children return, so it never
            # seeds a second turn racing the fan-out.
            return RUNNING
        if is_question_wake(wake_on):
            return WAITING
        return IDLE

    if etype in TERMINAL_TYPES:
        return IDLE

    return None


def is_terminal(env: Any) -> bool:
    """Whether this envelope ends its task for good.

    `TurnInterrupted` does not, and neither does `TaskSuspended` — both park a
    conversation the next message resumes."""
    return getattr(env, "type", "") in TERMINAL_TYPES


class StatusMachine:
    """Per-task absorbing state over `status_for`.

    Thread-safe: envelopes arrive on whatever thread committed them, and
    `cancel` commits on the request thread while a worker commits the same
    turn's suspend.
    """

    def __init__(self, *, memory: int = TERMINAL_MEMORY) -> None:
        self._lock = threading.Lock()
        self._memory = memory
        # An ordered set of task ids: value is unused, insertion order is the
        # eviction order.
        self._closed: OrderedDict[str, bool] = OrderedDict()

    def observe(self, env: Any) -> Optional[str]:
        """The status this envelope moves its **session** to, or `None`.

        `None` means "nothing changes", and it is also the answer for every
        envelope of a task that already terminated — that is the absorbing
        rule, and it is the whole reason this method exists rather than
        callers using `status_for` directly.
        """
        task_id = getattr(env, "task_id", "") or ""
        with self._lock:
            if task_id in self._closed:
                return None
            if is_terminal(env):
                self._closed[task_id] = True
                self._closed.move_to_end(task_id)
                while len(self._closed) > self._memory:
                    self._closed.popitem(last=False)
        return status_for(env)

    def is_closed(self, task_id: str) -> bool:
        with self._lock:
            return task_id in self._closed

    def forget(self, task_id: str) -> None:
        """Drop one task's terminal mark.

        Only for a task whose whole session is gone: forgetting a live one
        re-opens the window this class exists to close."""
        with self._lock:
            self._closed.pop(task_id, None)
