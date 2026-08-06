"""The trace surface: raw envelopes and the `{task_id: last_seq}` cursor.

`LEDGER §9.3` row 22, which carries a named defect: the cursor was once a
single number that only ever read the **root** stream, so clicking a subagent
on the trace page showed nothing at all. Every task stream counts `seq` from 0
independently, so one number cannot address them — the cursor is a map, and the
streams it covers include the subtasks announced by spawn markers in this
round's increment.

`/content/{hash}` lives here too: it is the other diagnostics-adjacent read,
and it is the one endpoint whose whole contract is "64 hex characters or 404".
"""
from __future__ import annotations

import json
from typing import Any

from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    delegating_provider,
    make_api,
    text_provider,
)
from tests.test_sse import PNG_BYTES


def raw_events(ready: Api, session_id: str, cursor: Any = None) -> dict[str, Any]:
    params = {"cursor": json.dumps(cursor)} if cursor else None
    response = ready.http.get(
        f"/api/v1/trace/sessions/{session_id}/raw-events", params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


def wait_fanout(ready: Api, session_id: str, *, timeout: float = 30.0) -> None:
    """Wait for a *background* fan-out to be completely over.

    `wait_turn` is not enough here and the difference is the whole point of
    `background=True`: the parent's `Task` spawn returns immediately and
    the parent ends its turn, so the first `turn_finished` arrives while the
    child stream is still running. The child then wakes the parent for a
    second turn, and only its `turn_finished` means the log has stopped
    growing. Waiting on the first one makes every later read a race with the
    child — which is exactly the flake this replaced.
    """
    seen = 0

    def done(frame: Any) -> bool:
        nonlocal seen
        if frame.event == "turn_finished":
            seen += 1
        return seen >= 2

    ready.frames(
        session_id, params={"since_seq": 0}, until=done, timeout=timeout
    )
    assert seen >= 2, (
        f"the fan-out never came to rest: saw {seen} turn_finished frames "
        "(the woken parent turn is missing)"
    )


# ---------------------------------------------------------------------------
# Row 22 — the cursor
# ---------------------------------------------------------------------------


def test_the_cursor_is_a_task_to_seq_map(make_api):
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])

    page = raw_events(ready, session["id"])

    task_id = ready.detail(session["id"])["task_streams"][0]["task_id"]
    assert set(page["cursor"]) == {task_id}
    assert page["cursor"][task_id] == max(e["seq"] for e in page["events"])


def test_passing_the_cursor_back_yields_a_strict_increment(make_api):
    """The property the trace page polls on: nothing repeats, nothing is
    skipped, and an idle session returns an empty page rather than the whole
    log again."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "first")
    ready.wait_turn(session["id"])

    first = raw_events(ready, session["id"])
    assert raw_events(ready, session["id"], first["cursor"])["events"] == []

    ready.send(session["id"], "second")
    ready.wait_turn(session["id"])
    second = raw_events(ready, session["id"], first["cursor"])

    task_id = next(iter(first["cursor"]))
    assert second["events"], "the second turn produced no increment"
    assert min(e["seq"] for e in second["events"]) > first["cursor"][task_id]
    assert second["cursor"][task_id] > first["cursor"][task_id]


def test_a_subagents_own_stream_is_reachable(make_api):
    """The named defect: reading only the root stream meant clicking a
    subagent on the trace page showed nothing.

    Its events must arrive in the same round as the spawn marker that
    announced it — a subtask discovered this round is followed immediately
    rather than a poll later."""
    ready = make_api(provider=delegating_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    wait_fanout(ready, session["id"])

    page = raw_events(ready, session["id"])

    root = ready.detail(session["id"])["task_streams"][0]["task_id"]
    streams = {e["task_id"] for e in page["events"]}
    assert len(streams) == 2, "the subtask's own stream was not read"
    subtask = next(t for t in streams if t != root)
    assert subtask in page["cursor"]
    # And the child's stream counts its own seq from zero — which is exactly
    # why one scalar cursor cannot address both.
    child_seqs = [e["seq"] for e in page["events"] if e["task_id"] == subtask]
    assert min(child_seqs) == 0


def test_a_cursor_that_names_a_subtask_keeps_incrementing_it(make_api):
    ready = make_api(provider=delegating_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    wait_fanout(ready, session["id"])
    first = raw_events(ready, session["id"])

    again = raw_events(ready, session["id"], first["cursor"])

    assert again["events"] == []
    assert again["cursor"] == first["cursor"]


def test_the_envelope_serialization_is_the_whole_record(make_api):
    """`envelope_to_dict` verbatim: a folding frontend sees every field the
    durable record holds, and tagged values keep their `__canonical_tag__` so
    a `ContentRef` is recognisable and derefable by hash."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])

    events = raw_events(ready, session["id"])["events"]

    genesis = events[0]
    assert genesis["type"] == "TaskCreated"
    assert set(genesis) >= {
        "id",
        "task_id",
        "seq",
        "type",
        "schema_version",
        "occurred_at",
        "actor",
        "trace_id",
        "correlation_id",
        "causation_id",
        "payload",
        "origin",
    }
    refs = [
        value
        for event in events
        for value in _walk(event["payload"])
        if isinstance(value, dict) and value.get("__canonical_tag__") == "content_ref"
    ]
    assert refs, "no ContentRef survived the serialization"
    assert all("hash" in ref for ref in refs)


def _walk(value: Any) -> list[Any]:
    found = [value]
    if isinstance(value, dict):
        for item in value.values():
            found.extend(_walk(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_walk(item))
    return found


def test_events_are_time_ordered_across_streams(make_api):
    """A trace is read to answer "what happened next", so a subagent's work
    belongs where it ran rather than in a block at the end."""
    ready = make_api(provider=delegating_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.wait_turn(session["id"], timeout=30.0)

    events = raw_events(ready, session["id"])["events"]

    stamps = [e["occurred_at"] for e in events]
    assert stamps == sorted(stamps)


def test_a_malformed_cursor_is_400(api: Api):
    project, session = api.open_session()

    for bad in ("not json", '["a", "b"]', '{"task": "not an int"}'):
        response = api.http.get(
            f"/api/v1/trace/sessions/{session['id']}/raw-events", params={"cursor": bad}
        )
        assert response.status_code == 400, bad
        assert api.error(response)["code"] == "invalid_cursor", bad


def test_the_trace_of_an_unknown_session_is_404(api: Api):
    response = api.http.get("/api/v1/trace/sessions/nope/raw-events")

    assert response.status_code == 404
    assert api.error(response)["code"] == "unknown_session"


def test_a_session_with_no_turn_traces_as_empty(api: Api):
    project, session = api.open_session()

    page = raw_events(api, session["id"])

    assert page == {"events": [], "cursor": {}}


# ---------------------------------------------------------------------------
# `/content/{hash}`
# ---------------------------------------------------------------------------


def test_content_is_64_hex_characters_or_404(api: Api):
    """The store is content-addressed, so a malformed hash and an unknown one
    are the same answer: there is nothing there."""
    for bad in ("short", "g" * 64, "A" * 64, "0" * 63, "0" * 65, "../etc/passwd"):
        response = api.http.get(f"/api/v1/content/{bad}")
        assert response.status_code == 404, bad

    assert api.http.get(f"/api/v1/content/{'0' * 64}").status_code == 404


def test_content_is_cached_by_its_hash(make_api):
    """Immutable by construction: the hash names these exact bytes forever, so
    the browser may keep them until it runs out of disk."""
    import base64

    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(
        session["id"],
        "look",
        images=[
            {"media_type": "image/png", "data_base64": base64.b64encode(PNG_BYTES).decode()}
        ],
    )
    ready.wait_turn(session["id"], timeout=30.0)
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    digest = next(f for f in frames if f.event == "user_message").data["images"][0]["hash"]

    response = ready.http.get(f"/api/v1/content/{digest}")

    assert "immutable" in response.headers["cache-control"]
