"""The trace surface: untranslated engine envelopes, for debugging.

The conversation the product renders is a *translation*; this is the record
behind it. They are separate pages on purpose — anything the product shows
comes from the UI vocabulary, and anything visible only here is by definition
not part of the contract.

**The cursor is a `{task_id: last_seq}` map, not a scalar.** Every task stream
counts `seq` from 0 independently, so one number cannot address them. Passing
the previous response's cursor back yields a strict increment across every
stream at once, and the streams it covers are: the session's own task streams,
plus every subtask already in the cursor, plus every subtask announced by a
spawn marker in *this* round's increment. That last clause is a regression
guard with a name — a cursor that read only the root stream meant clicking a
subagent on the trace page showed nothing at all.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Query, Request
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.deps import db_of, hub_of, require_session
from noeta.agent.api.errors import APIError, ContractRoute
from noeta.agent.host.hub import SPAWN_TYPES, EventHub
from noeta.agent.store import sessions
from noeta.sdk import envelope_to_dict

logger = logging.getLogger(__name__)

router = APIRouter(tags=["trace"], route_class=ContractRoute)


def _parse_cursor(raw: Optional[str]) -> dict[str, int]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise APIError(400, "invalid_cursor", f"cursor must be JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise APIError(400, "invalid_cursor", "cursor must be a {task_id: seq} object")
    out: dict[str, int] = {}
    for task_id, seq in parsed.items():
        if isinstance(seq, bool) or not isinstance(seq, int):
            raise APIError(400, "invalid_cursor", f"cursor[{task_id}] must be an int")
        out[str(task_id)] = seq
    return out


def _collect(
    hub: EventHub, task_ids: list[str], cursor: dict[str, int]
) -> tuple[list[Any], dict[str, int]]:
    """Read every named stream past its own cursor, discovering subtasks.

    One pass, not two: a spawn marker found in this round is followed
    immediately, so a subagent's events appear in the same response as the
    marker that announced it rather than a poll later."""
    pending = list(task_ids)
    seen: set[str] = set()
    envelopes: list[Any] = []
    advanced = dict(cursor)
    while pending:
        task_id = pending.pop(0)
        if task_id in seen:
            continue
        seen.add(task_id)
        after = cursor.get(task_id)
        for env in hub.raw_events(task_id, after):
            envelopes.append(env)
            seq = getattr(env, "seq", None)
            if isinstance(seq, int):
                advanced[task_id] = max(advanced.get(task_id, -1), seq)
            if getattr(env, "type", "") in SPAWN_TYPES:
                subtask_id = getattr(env.payload, "subtask_id", None)
                if subtask_id and subtask_id not in seen:
                    pending.append(str(subtask_id))
        advanced.setdefault(task_id, cursor.get(task_id, -1))
    return envelopes, advanced


@router.get("/trace/sessions/{session_id}/raw-events")
async def raw_events(
    request: Request, session_id: str, cursor: Optional[str] = Query(None)
) -> Any:
    conn = db_of(request)
    hub = hub_of(request)
    await run_in_threadpool(require_session, conn, session_id)
    parsed = _parse_cursor(cursor)
    streams = await run_in_threadpool(sessions.list_task_streams, conn, session_id)

    # Session streams first, then every subtask the caller already knows about;
    # the rest are discovered while reading.
    task_ids = [s.task_id for s in streams]
    task_ids += [t for t in parsed if t not in set(task_ids)]

    envelopes, advanced = await run_in_threadpool(_collect, hub, task_ids, parsed)
    # Time-ordered rather than grouped by stream: a trace is read to answer
    # "what happened next", and a subagent's work belongs where it ran.
    envelopes.sort(key=lambda e: (getattr(e, "occurred_at", 0.0), e.task_id, e.seq))
    return {
        "events": [envelope_to_dict(env) for env in envelopes],
        "cursor": advanced,
    }
