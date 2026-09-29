"""The per-session SSE stream.

Six steps, and every one of them is a bug fix rather than a style choice:

```
1. q = hub.subscribe(session_id)     # SUBSCRIBE FIRST
2. yield ": connected\\n\\n"           # FIRST BYTE IMMEDIATELY
3. session = store.get(session_id)   # RE-FETCH, not the request-time snapshot
4. for ev in replay(...): yield frame(ev)
5. yield frame(replay_done)          # synthetic, no id
6. live loop
finally: hub.unsubscribe(session_id, q)
```

1. **Subscribe before replaying** or an event landing in the gap between the
   two is lost forever. The resulting overlap is deduped by `seq`.
2. **The comment frame before anything else.** Buffering proxies — the Vite dev
   proxy, any reverse proxy — wait for the first body byte before forwarding
   the response headers, and replay can be slow. Without this the browser sees
   no headers for seconds and the whole app looks dead.
3. **Re-fetch after subscribing.** A client attaching mid-first-turn would
   otherwise replay from a snapshot taken before the session's first task
   stream was bound microseconds ago, and the leading events would be lost.

Replay runs on the thread pool, never on the engine's drive queue. An active
turn can hold a drive worker for minutes (LLM retries, container command
timeouts); replay parked behind it means **every** session's stream — finished
ones included — never reaches `replay_done`, and the whole frontend hangs on a
loading skeleton.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.deps import db_of, hub_of, require_session
from noeta.agent.api.errors import ContractRoute
from noeta.agent.host.hub import EventHub, Subscription, sse_frame
from noeta.agent.host.translator import UIEvent
from noeta.agent.store import sessions

logger = logging.getLogger(__name__)

router = APIRouter(tags=["events"], route_class=ContractRoute)

#: Seconds of silence before a comment frame is written. Long enough to be
#: invisible, short enough that no intermediary decides the connection died.
HEARTBEAT_S = 15.0

#: Headers the stream cannot work without. `X-Accel-Buffering` is not
#: decorative: nginx buffers an event stream into uselessness without it.
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


class Cursor:
    """The dedup cursor, keyed per task stream.

    §4.3 of the contract states one `last_seq`, and a session now has exactly
    one **live** stream — its own root — so for the ordinary frame this is that
    rule exactly. The per-`_task` keying is kept as the backstop it always was:
    a fork's inherited prefix is stamped with the child's own task but carries
    no `seq`, and subtask frames ride another task id; neither should ever move
    the live stream's cursor, and keying by `_task` makes that structural.

    Frames with no `seq` — every synthetic frame, every delta, every subtask
    frame, every inherited-prefix frame — always pass through and never move a
    cursor.
    """

    def __init__(self, since_seq: Optional[int]) -> None:
        self._floor = since_seq if since_seq is not None and since_seq > 0 else -1
        self._seen: dict[str, int] = {}

    def accepts(self, event: UIEvent) -> bool:
        if event.seq is None:
            return True
        key = str(event.data.get("_task") or "")
        last = self._seen.get(key, self._floor)
        if event.seq <= last:
            return False
        self._seen[key] = event.seq
        return True


@router.get("/sessions/{session_id}/events")
async def events(
    request: Request,
    session_id: str,
    since_seq: Optional[int] = None,
) -> StreamingResponse:
    conn = db_of(request)
    hub = hub_of(request)
    # A 404 has to happen before the response starts: once the stream is open
    # the status line is already on the wire and the only way to say "no such
    # session" is to close it, which the client reads as a disconnect.
    await run_in_threadpool(require_session, conn, session_id)
    subscription = hub.subscribe(session_id)
    return StreamingResponse(
        _stream(request, hub, session_id, subscription, since_seq),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


async def _stream(
    request: Request,
    hub: EventHub,
    session_id: str,
    subscription: Subscription,
    since_seq: Optional[int],
) -> AsyncIterator[str]:
    cursor = Cursor(since_seq)
    try:
        yield ": connected\n\n"

        conn = request.app.state.db
        session = await run_in_threadpool(sessions.get_session, conn, session_id)
        if session is None:
            return

        replayed = await run_in_threadpool(
            hub.replay, session_id, since_seq=since_seq
        )
        for event in replayed:
            if cursor.accepts(event):
                yield sse_frame(event)
        yield sse_frame(UIEvent(None, "replay_done", {}))

        while True:
            if await request.is_disconnected():
                return
            if subscription.overflowed:
                # The queue could not hold a durable frame. Closing is the
                # recovery: the client reconnects with `since_seq` and
                # re-derives exactly what it missed, which is why replay is a
                # pure function of the log and not a stored projection.
                logger.warning("closing an overflowed stream for session %s", session_id)
                return
            event = await subscription.next(HEARTBEAT_S)
            if event is None:
                yield ": ping\n\n"
                continue
            if cursor.accepts(event):
                yield sse_frame(event)
    finally:
        hub.unsubscribe(session_id, subscription)
