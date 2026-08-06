"""Sessions and the verbs that drive them.

A session is the application-layer unit of conversation and owns **one or
more** task streams: it is created with none, the first message seeds the
first, and every `fork` appends a sibling. That is why each verb below takes an
optional `task_id` and why the detail response lists the streams.

The three stop-shaped verbs are not interchangeable, and the difference is
product-visible:

- **`interrupt`** halts the in-flight turn and leaves the conversation alive.
  It is what a Stop button means, and the next ordinary message resumes the
  same stream with its full context.
- **`cancel`** kills the conversation. Terminal, not resumable — a later
  message on that stream is a 409. The old degradation that caught
  `NotResumableError` and quietly started a *fresh* task (resetting the event
  seq to 0, so every connected client's cursor was silently wrong) is
  deliberately not rebuilt: cancel means cancel, and a new conversation is a
  new session.
- **`fork`** writes nothing to the source stream. It appends a sibling to the
  *same* session, which is why it returns a task id and not a session id.

Every turn-driving call runs on the thread pool. `seed_start` blocks on
container allocation for seconds on a cold sandbox, and blocking the event loop
there would stall every other session's SSE.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from noeta.agent.api import wire
from noeta.agent.api.deps import (
    db_of,
    host_of,
    hub_of,
    require_project,
    require_session,
)
from noeta.agent.api.errors import APIError, ContractRoute, to_error_response
from noeta.agent.api.images import decode_images
from noeta.agent.host.hub import EventHub
from noeta.agent.host.status import IDLE, RUNNING, WAITING
from noeta.agent.host.title import fallback_title
from noeta.agent.host.translator import UIEvent
from noeta.agent.store import sessions
from noeta.sdk import ImageBlock

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sessions"], route_class=ContractRoute)


# ---------------------------------------------------------------------------
# The index
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/sessions")
async def list_sessions(request: Request, project_id: str) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    rows = await run_in_threadpool(sessions.list_sessions, conn, project_id)
    return {"sessions": [wire.session_row(s) for s in rows]}


@router.post("/projects/{project_id}/sessions", status_code=201)
async def create_session(
    request: Request, project_id: str, body: wire.CreateSession
) -> Any:
    """A session with **zero** task streams; the first message seeds one.

    Not seeding here is what keeps an abandoned "New session" free: no engine
    task, no container, no workspace assembly until somebody actually says
    something."""
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    session = await run_in_threadpool(
        lambda: sessions.create_session(conn, project_id, title=body.title)
    )
    return wire.session_detail(session, [])


@router.get("/sessions/{session_id}")
async def get_session(request: Request, session_id: str) -> Any:
    conn = db_of(request)
    session = await run_in_threadpool(require_session, conn, session_id)
    streams = await run_in_threadpool(sessions.list_task_streams, conn, session_id)
    return wire.session_detail(session, streams)


@router.patch("/sessions/{session_id}")
async def update_session(
    request: Request, session_id: str, body: wire.UpdateSession
) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_session, conn, session_id)
    patch = body.model_dump(exclude_none=True)
    if "title" in patch:
        # A hand-typed title is final: marking it generated stops the title
        # thread from overwriting it at the next turn boundary.
        patch["title_generated"] = True
    updated = await run_in_threadpool(
        lambda: sessions.update_session(conn, session_id, **patch)
    )
    session = updated or await run_in_threadpool(require_session, conn, session_id)
    streams = await run_in_threadpool(sessions.list_task_streams, conn, session_id)
    return wire.session_detail(session, streams)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(request: Request, session_id: str) -> Response:
    """Delete the row first, then forget the routing, then clean up off-thread.

    Deliberately lightweight, in that order, because the user's perception of
    "deleted" is the row disappearing. What it does **not** do is delete engine
    data: the EventLog and ContentStore are preserved so the trace page can
    still inspect the execution by task id.

    It also does **not** delete the project directory. Under D2 the directory
    belongs to the project, and its sibling sessions are still working in it.

    The preview mount goes last and is best-effort: a token that outlives its
    session is a live URL onto a container nobody can name any more, and the
    64-entry LRU would only reclaim it after 64 more sessions.
    """
    conn = db_of(request)
    await run_in_threadpool(require_session, conn, session_id)
    hub = hub_of(request)
    await run_in_threadpool(sessions.delete_session, conn, session_id)
    hub.forget_session(session_id)
    gateway = getattr(request.app.state, "preview_gateway", None)
    if gateway is not None:
        gateway.unmount_session(session_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Driving turns
# ---------------------------------------------------------------------------


@router.post("/sessions/{session_id}/messages", status_code=202)
async def send_message(
    request: Request, session_id: str, body: wire.SendMessage
) -> Any:
    """202 with the stream the message landed on.

    The refusals, in the order they are checked — the order *is* the contract:

    1. **409** while a question is pending (`waiting`) or the conversation is
       terminal. A **running** turn is *not* refused: the message is injected
       into it (see below). Session status is derived from the envelope stream,
       so this is one read of a value the hub already maintains.
    2. **400** on a bad attachment, with the session unchanged and nothing
       seeded (`api/images.py` holds the rules).
    3. **422** on an empty message with no attachments — there is nothing to
       send — and on a model or effort outside the configured catalog, which
       the host rejects synchronously so it **never reaches the provider**.

    **Two landings, one endpoint.** A message into an `idle` session seeds or
    appends a turn (`host.send_goal`, carrying the per-turn model/effort/skills)
    and gets the optimistic `turn_started`. A message into a `running` session
    *steers* it: `host.inject_goal` delivers the message mid-turn without
    seeding a new turn, so no `turn_started` is pushed — the turn is already
    live — and no per-turn selector rides along (the steer runs on the turn's
    binding; the composer freezes those pickers while steering).

    This is also the **retry path for a failed turn**, and it is deliberately
    not a special one. A provider fault parks the turn at `turn_failed` rather
    than sealing the ledger, which leaves the session `idle` — so nothing here
    refuses it and the message resumes the same stream with its whole context.
    A dedicated "retry" verb would be a second way to do the same thing, and
    the one thing it could add — re-driving the parked turn — is the thing that
    must not happen (the turn is over; the next input is a new turn).
    """
    conn = db_of(request)
    host = host_of(request)
    hub = hub_of(request)
    session = await run_in_threadpool(require_session, conn, session_id)
    _require_injectable(session)
    steering = session.status == RUNNING

    text = body.text

    def _prepare() -> list[ImageBlock]:
        """Validate the whole batch, then store it. Off the loop: the decode
        and the ContentStore write are both bounded by the 5 MB cap, and the
        event loop is what every other session's stream runs on."""
        decoded = decode_images(body.images)
        if not text.strip() and not decoded:
            raise APIError(
                422, "empty_message", "a message needs text or an attachment"
            )
        # Only here, once nothing can still be rejected: a refused request must
        # leave no orphan blob behind.
        return [
            ImageBlock(
                source=host.client.put_content(image.body, media_type=image.media_type)
            )
            for image in decoded
        ]

    images = await run_in_threadpool(_prepare)

    # Only now that nothing can still reject the send: an untitled session gets
    # the first line of the message as its label, immediately.
    await run_in_threadpool(_apply_fallback_title, conn, hub, session, text)

    if steering:
        # A steer joins the live turn; it starts none. `inject_goal` writes a
        # lease-free `InjectionRequested` the running Engine drains at its next
        # turn boundary, surfacing as an ordinary `user_message` — so the
        # optimistic bubble the composer already showed resolves in place, with
        # no `turn_started` to un-paint.
        def _send() -> str:
            with hub.binding(session_id):
                return host.inject_goal(
                    session_id,
                    text=text,
                    images=images,
                    task_id=body.task_id,
                )
    else:
        # Instant feedback while `seed_start` blocks on a cold container.
        # Synthetic and never replayed: the durable `TaskStarted` is what a
        # refresh reads.
        hub.push(session_id, UIEvent(None, "turn_started", {}))

        def _send() -> str:
            with hub.binding(session_id):
                return host.send_goal(
                    session_id,
                    text=text,
                    images=images,
                    model=body.model,
                    effort=body.effort,
                    skills=tuple(body.skills),
                    task_id=body.task_id,
                )

    task_id = await _drive(hub, session_id, _send)
    hub.bind(task_id, session_id)
    return {"task_id": task_id}


@router.post("/sessions/{session_id}/answer", status_code=202)
async def answer(request: Request, session_id: str, body: wire.AnswerBody) -> Any:
    """Answer a pending question and resume the turn.

    No `turn_finished` was emitted while the question was pending — a question
    is a resting place inside a turn, not the end of one — so the first
    `turn_finished` after this call is genuinely the end of that turn.

    `answers` maps each question id to `{choice_id?, text?}`, at least one of
    them present; the engine validates it against the pending question body and
    a mismatch is a **422**, not a server fault. It is passed through
    unmodified: guessing whether a bare string meant a choice or freeform would
    turn a rejected answer into a silently wrong one.
    """
    conn = db_of(request)
    host = host_of(request)
    hub = hub_of(request)
    await run_in_threadpool(require_session, conn, session_id)

    def _answer() -> str:
        with hub.binding(session_id):
            return host.answer(
                session_id,
                question_id=body.question_id,
                answers=body.answers,
                task_id=body.task_id,
            )

    try:
        task_id = await _drive(hub, session_id, _answer, reported=(ValueError,))
    except ValueError as exc:
        # The engine's answer codec rejects by raising `ValueError`, and its
        # concrete type lives outside the public SDK surface — so it is caught
        # here, where a `ValueError` can only have come from this one call,
        # rather than by widening the shared error table.
        raise APIError(422, "invalid_answer", str(exc)) from exc
    return {"task_id": task_id}


@router.post("/sessions/{session_id}/interrupt", status_code=202)
async def interrupt(request: Request, session_id: str, body: wire.InterruptBody) -> Any:
    """Stop the in-flight turn, keep the conversation.

    Called straight through to the engine on this request thread rather than
    queued behind the drive: that is the documented cross-thread design. The
    durable marker is written first and the engine polls it at turn boundaries,
    so it lands *between* steps and **cannot abort a tool call already
    running** — a 202 here means "the stop is recorded", never "the agent has
    stopped", and no copy above this layer may promise otherwise.

    Two refusals, both conflicts rather than bad requests:

    - **409** on a terminal stream (`TaskAlreadyTerminalError`) — `cancel`
      already ended it, and there is no turn left to halt.
    - **409** on a session that has never been messaged: nothing to stop.

    Safe on an idle conversation, and that is a property of the engine worth
    naming because the alternative is silent: the interrupt registry is marked
    **only when a turn is actually in flight**, so a Stop pressed on a resting
    session cannot leave a mark armed that swallows the user's next message."""
    conn = db_of(request)
    host = host_of(request)
    task_id = await run_in_threadpool(
        _resolve_stream, conn, session_id, body.task_id
    )
    await run_in_threadpool(host.interrupt, task_id)
    return {"task_id": task_id}


@router.post("/sessions/{session_id}/cancel", status_code=202)
async def cancel(request: Request, session_id: str, body: wire.InterruptBody) -> Any:
    """Kill the conversation. Terminal.

    The root's `turn_finished{cancelled}` is what closes every still-running
    step and subtask card on the client — the cascade's own frames are
    synthetic and are not replayed, so after a refresh the parent's terminal
    frame is the only thing that can close them."""
    conn = db_of(request)
    host = host_of(request)
    task_id = await run_in_threadpool(
        _resolve_stream, conn, session_id, body.task_id
    )
    await run_in_threadpool(host.cancel, task_id)
    return {"task_id": task_id}


@router.post("/sessions/{session_id}/fork", status_code=201)
async def fork(request: Request, session_id: str, body: wire.ForkBody) -> Any:
    """Branch at a user message, keeping the original. A **new child session**.

    `message_seq` anchors on the **user-goal `MessagesAppended` seq** — exactly
    the `seq` the `user_message` frame already carries, so the client needs no
    second addressing scheme for "the bubble I clicked". Refusals:

    - **409 `not_forkable`** for the opening message (no prior turn to branch
      from), an anchor that is not a message event at all, and a subtask (only
      a root task may be forked);
    - **404 `unknown_task_stream`** for a `task_id` that is not one of *this*
      session's streams — which is what a subtask id actually hits here, since
      a subtask is never bound as a session stream.

    The engine's anchor check is **structural, not role-aware**: it accepts any
    `MessagesAppended` carrying content, so an *assistant* message's seq forks
    silently at the turn boundary before it. Offering the action on anything
    but a user bubble is therefore the client's mistake to avoid; nothing below
    will catch it.

    The fork becomes its **own** session, nested under this one in the sidebar
    (`parent_session_id`), with the forked task as its `root` stream. Its
    inherited history (everything up to the anchor) is spliced from this
    session's source stream at replay time (`hub.replay`), so opening the child
    reads as a whole conversation. Returns `{session_id, task_id}`: the session
    to navigate to and the stream the edited message is sent on.

    Both sessions share the project directory: `fork` deliberately does not
    restore workspace files. (That is `rewind`, exposed separately as the
    `/rewind` endpoint — "undo last turn".) Say so in the UI.

    No seed window and no `branch_created` push: the forked task's genesis
    envelopes commit before the child session exists, but the child is unwatched
    at that instant, so they are recovered by its own SSE replay rather than
    fanned out live. The parent/child link the sidebar reads is durable in the
    session row, not a synthetic frame."""
    conn = db_of(request)
    host = host_of(request)
    hub = hub_of(request)
    await run_in_threadpool(require_session, conn, session_id)

    child_id, task_id = await run_in_threadpool(
        host.fork, session_id, task_id=body.task_id, message_seq=body.message_seq
    )
    hub.bind(task_id, child_id)
    return {"session_id": child_id, "task_id": task_id}


@router.post("/sessions/{session_id}/rewind", status_code=200)
async def rewind(request: Request, session_id: str, body: wire.RewindBody) -> Any:
    """Undo the last turn(s): re-base **this** session's stream to before a
    user message, restoring workspace files. **Not** a fork — no child session,
    no navigation; the same stream re-bases in place and lands live.

    `message_seq` anchors on the same user-goal `MessagesAppended` seq that
    `fork` takes and that the `user_message` frame already carries. The visible
    effect arrives as a durable `rewind` frame on the stream (from the engine's
    `TaskRewound` marker), which truncates the transcript to that point. The
    200 body is just the (unchanged) stream id, for the client to confirm which
    stream re-based. Refusals:

    - **409 `session_busy`** while a turn is in flight or a question is pending
      — undo is a finished-turn action, so unlike `send_message` a running turn
      is *not* injectable here;
    - **409 `not_rewindable`** for an anchor that is not a user message on the
      stream (raised by `host.rewind`);
    - **404 `unknown_task_stream`** for a `task_id` that is not one of this
      session's streams.

    Both `rewind` and every other session of the project share one directory,
    so the file restore reverts files another session may have written after
    this point — the risk the UI states before it calls this."""
    conn = db_of(request)
    host = host_of(request)
    session = await run_in_threadpool(require_session, conn, session_id)
    # A running turn is not injectable here (contrast `send_message`): undo
    # operates on finished turns, and re-basing under a live writer would race
    # the engine's file writes. The UI hides the button while running; this is
    # the backstop for a stale client.
    if session.status != IDLE:
        raise APIError(
            409, "session_busy", "cannot undo while a turn is running or waiting"
        )
    task_id = await run_in_threadpool(
        host.rewind, session_id, task_id=body.task_id, message_seq=body.message_seq
    )
    return {"task_id": task_id}


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _apply_fallback_title(
    conn: Any, hub: EventHub, session: sessions.Session, text: str
) -> None:
    """Label an untitled session from the message that opened it.

    Two titles with two different lives (`host/title.py`): this one is
    synchronous and always available, the generated one arrives later from an
    LLM call and only when a gateway is configured. Without this the offline
    product — the default configuration — never titles anything, and every row
    in the sidebar reads the same.

    **`title_generated` is deliberately left alone.** It is the flag that says
    "a model has spoken", so setting it here would permanently suppress the
    real title; leaving it false is also what lets a failed generation leave
    this label in place and retry in a later process.

    An image-only message yields no title and the session keeps whatever it
    had — writing an empty string would look like a deletion.
    """
    if session.title:
        return
    title = fallback_title(text)
    if not title:
        return
    sessions.update_session(conn, session.id, title=title)
    # Synthetic, exactly like the generated title's frame: a title is not
    # derivable from the event log, so it carries no seq and is never replayed.
    # A reader that missed it reads the persisted row on its next fetch.
    hub.push(session.id, UIEvent(None, "session_meta", {"title": title}))


def _require_injectable(session: sessions.Session) -> None:
    """Refuse a message the task cannot take — but a *running* turn can.

    A running turn is injectable: `inject_goal` delivers the message mid-turn
    (see `host.inject_goal`), so `running` is no longer a refusal. What still
    refuses:

    - **`waiting`** — a pending question parks the turn on a *different* wake
      handle; a plain message cannot resume it, so the composer withholds Send
      here and the backend 409s it.
    - **anything else** — a terminal/cancelled conversation is not resumable at
      all. `session.status` only carries `idle`/`running`/`waiting`; a task the
      status machine has closed reads through as one of those but the driver's
      own `NotResumableError` (surfaced as 409) is the backstop.
    """
    if session.status == WAITING:
        raise APIError(
            409,
            "session_busy",
            "a turn is already running or a question is pending",
        )
    if session.status not in (IDLE, RUNNING):
        raise APIError(409, "session_busy", "a turn is already running")


def _resolve_stream(conn: Any, session_id: str, task_id: Optional[str]) -> str:
    """The stream a stop-shaped verb addresses.

    An explicit `task_id` is checked against this session's streams rather than
    trusted: it arrives from a request body, and interrupting another session's
    task from this one would be a cross-session write.

    Omitting it means the **newest** stream, which matches where an unqualified
    message goes (`AgentHost._resolve_task_id`). After a `fork` that is the
    branch — the one the client just switched its filter to — so Stop on a
    branch works with no task id, and Stop on the *source* while a branch
    exists is the case that must name its stream."""
    require_session(conn, session_id)
    streams = sessions.list_task_streams(conn, session_id)
    if task_id:
        if task_id not in {s.task_id for s in streams}:
            raise APIError(
                404, "unknown_task_stream", f"no such task stream in this session: {task_id}"
            )
        return task_id
    if not streams:
        raise APIError(
            409, "no_task_stream", "this session has not started a turn yet"
        )
    return streams[-1].task_id


async def _drive(
    hub: EventHub,
    session_id: str,
    call: Any,
    *,
    reported: tuple[type[BaseException], ...] = (),
) -> str:
    """Run a seeding verb off the event loop, reporting a thrown drive.

    **Only a failure the caller never sees reaches the stream.** A refusal that
    comes back as a 4xx means the turn was never seeded and nothing about the
    conversation changed — pushing `error` + `turn_finished{failed}` for one
    would paint a failed turn into a transcript that is still, correctly,
    parked on its question, and disable the composer the user needs to answer
    it. `to_error_response` is the same table `ContractRoute` answers with, so
    the two cannot disagree about which exceptions those are; `reported` names
    the ones a handler converts itself.

    For everything else — an exception from the drive thread that surfaces as a
    500 — both frames are pushed, and pushing **both** matters: a client must be
    able to unlock the composer on `error` alone, because a `turn_finished` can
    be lost on a live stream and depending on it wedges the UI on "running"
    forever.
    """
    try:
        return await run_in_threadpool(call)
    except Exception as exc:
        if isinstance(exc, reported) or to_error_response(exc) is not None:
            raise
        message = f"{type(exc).__name__}: {exc}"
        hub.push(session_id, UIEvent(None, "error", {"message": message[:500]}))
        hub.push(session_id, UIEvent(None, "turn_finished", {"status": "failed"}))
        raise
