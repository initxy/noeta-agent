"""The SSE contract: framing, startup order, dedup, filtering, backpressure.

Against a **real uvicorn**, because `TestClient` does not truly stream a
response body and the events endpoint is an infinite stream — consuming one
synchronously blocks forever.

The parts of the contract that cannot be observed through a server without
waiting on wall-clock time (the 15 s heartbeat, a queue overflowing) are pinned
directly against `Subscription`, which is the object that implements them.
"""
from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from noeta.agent.api.events import HEARTBEAT_S, Cursor
from noeta.agent.host.hub import QUEUE_SIZE, Subscription, sse_frame
from noeta.agent.host.translator import UIEvent
from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    delegating_provider,
    make_api,
    pacing_provider,
    text_provider,
    types_of,
)




def raw_blocks(base_url: str, path: str, **params: Any) -> list[str]:
    """The wire, unparsed, up to the end of replay.

    A separate reader from the harness's `SSEReader` on purpose: that one
    parses, and three of the rules below are about bytes the parser is
    designed to hide (the comment preamble, the absence of an `id:` line, the
    exact field separator)."""
    timeouts = httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0)
    chunks: list[str] = []
    with httpx.Client(base_url=base_url, timeout=timeouts) as client:
        with client.stream("GET", path, params=params) as response:
            response.raise_for_status()
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["cache-control"] == "no-cache"
            # nginx buffers an event stream into uselessness without this.
            assert response.headers["x-accel-buffering"] == "no"
            buffer = ""
            try:
                for chunk in response.iter_text():
                    buffer += chunk
                    while "\n\n" in buffer:
                        block, buffer = buffer.split("\n\n", 1)
                        chunks.append(block)
                        if "event: replay_done" in block:
                            return chunks
            except (httpx.TimeoutException, TimeoutError):
                pass
    return chunks


# ---------------------------------------------------------------------------
# Framing and startup order
# ---------------------------------------------------------------------------


def test_the_startup_order_is_connected_then_replay_then_replay_done(api: Api):
    """Every step of the order is a bug fix.

    The comment frame first because buffering proxies wait for the first body
    byte before forwarding response headers — and replay can be slow, so
    without it the browser sees no headers for seconds and the app looks dead.
    `replay_done` last because it is what ends the client's loading skeleton."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait_turn(session["id"])

    blocks = raw_blocks(
        api.sse.base_url, f"/api/v1/sessions/{session['id']}/events", since_seq=0
    )

    assert blocks[0] == ": connected"
    assert blocks[-1] == "event: replay_done\ndata: {}"
    assert "event: user_message" in blocks[1]


def test_the_field_separator_is_a_colon_and_exactly_one_space(api: Api):
    """`id: 12`, never `id:12`. The reader splits on that literal, so a
    drifting emitter fails loudly here instead of confusing a client."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait_turn(session["id"])

    blocks = raw_blocks(
        api.sse.base_url, f"/api/v1/sessions/{session['id']}/events", since_seq=0
    )

    for block in blocks:
        for line in block.split("\n"):
            if line.startswith(":"):
                continue
            key, separator, _ = line.partition(": ")
            assert separator, line
            assert key in {"id", "event", "data"}, line


def test_a_synthetic_frame_carries_no_id_line(api: Api):
    """`replay_done` is synthetic and never replayed, so it must not move the
    client's resume cursor. With an `id:`, the cursor would advance past
    envelopes that never arrived and a reconnect would skip them forever —
    silent, permanent loss. Omitting it makes that a property of the format."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait_turn(session["id"])

    blocks = raw_blocks(
        api.sse.base_url, f"/api/v1/sessions/{session['id']}/events", since_seq=0
    )

    done = [b for b in blocks if "event: replay_done" in b]
    assert done and all("id:" not in block for block in done)


def test_a_delta_frame_is_emitted_without_an_id(api: Api):
    """The same rule at the emitter, where it is decided.

    Pinned here as well as end to end because the mock provider deliberately
    does not stream — that keeps every other test's expected event stream
    stable — so the wire-level assertion needs the frame builder itself."""
    delta = UIEvent(None, "delta", {"call_id": "c1", "kind": "text", "text": "hi"})

    wire = sse_frame(delta)

    assert wire == 'event: delta\ndata: {"call_id": "c1", "kind": "text", "text": "hi"}\n\n'
    assert "id:" not in wire


def test_data_is_always_one_line(api: Api):
    """A multi-line `data:` is a different framing than the reader implements,
    and a newline inside a JSON string is escaped rather than emitted."""
    wire = sse_frame(UIEvent(3, "assistant_text", {"text": "one\ntwo"}))

    assert wire == 'id: 3\nevent: assistant_text\ndata: {"text": "one\\ntwo"}\n\n'


def test_unicode_is_not_escaped(api: Api):
    """`ensure_ascii=False`: a Chinese conversation must not triple in size on
    the wire, and the reader parses UTF-8 either way."""
    wire = sse_frame(UIEvent(1, "assistant_text", {"text": "中文"}))

    assert "中文" in wire


def test_an_unknown_session_is_404_before_the_stream_opens(api: Api):
    """Once the stream is open the status line is already on the wire, and the
    only way left to say "no such session" is to close it — which a client
    reads as a disconnect and retries forever."""
    response = api.http.get("/api/v1/sessions/nope/events")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_session"


# ---------------------------------------------------------------------------
# Replay, dedup and the cursor
# ---------------------------------------------------------------------------


def test_since_seq_replay_is_exactly_the_suffix(api: Api):
    """Row 18: same seqs, same types, same order.

    This is what makes reconnect free of an entire class of bug — the client
    does not have to reason about what it may have missed, because the suffix
    is the whole answer."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait_turn(session["id"])

    full = api.frames(session["id"], params={"since_seq": 0}, timeout=3.0)
    durable = [f for f in full if f.seq is not None]
    cut = durable[len(durable) // 2].seq

    suffix = api.frames(session["id"], params={"since_seq": cut}, timeout=3.0)

    expected = [(f.seq, f.event) for f in durable if f.seq > cut]
    assert [(f.seq, f.event) for f in suffix if f.seq is not None] == expected


def test_since_seq_zero_is_a_full_replay(api: Api):
    """Row 19. It is the client's real first-connect path, not an increment.

    A cursor of `0` would be indistinguishable from "I have seen seq 0" if it
    meant anything else, and the very first envelope of a session would be
    unreachable."""
    project, session = api.open_session()
    api.send(session["id"], "hello")
    api.wait_turn(session["id"])

    explicit = api.frames(session["id"], params={"since_seq": 0}, timeout=3.0)
    implicit = api.frames(session["id"], timeout=3.0)

    assert [(f.seq, f.event) for f in explicit] == [(f.seq, f.event) for f in implicit]
    assert types_of(explicit).count("replay_done") == 1


def test_the_cursor_is_kept_per_task_stream():
    """One cursor per stream, seeded from `since_seq`.

    For the single-stream session every client actually has, this is §4.3's
    rule exactly. It is keyed by `_task` because a `fork` makes siblings that
    count `seq` from 0 independently — one shared cursor would silently
    swallow the younger branch's entire history, which is the same failure the
    subtask rule exists to prevent."""
    cursor = Cursor(5)

    assert not cursor.accepts(UIEvent(5, "assistant_text", {"_task": "a"}))
    assert cursor.accepts(UIEvent(6, "assistant_text", {"_task": "a"}))
    assert not cursor.accepts(UIEvent(6, "assistant_text", {"_task": "a"}))
    # A sibling branch counts from its own zero and must not be deduped away.
    assert cursor.accepts(UIEvent(6, "assistant_text", {"_task": "b"}))
    # Seq-less frames always pass and never move a cursor.
    assert cursor.accepts(UIEvent(None, "delta", {"_task": "a"}))
    assert cursor.accepts(UIEvent(None, "delta", {"_task": "a"}))


def test_a_full_replay_carries_subtask_frames_and_a_reconnect_does_not(make_api):
    """Row 19's second half.

    Subtask frames carry no `seq` — a subtask stream counts its own, and
    carrying it would collide with the parent's dedup cursor and silently
    swallow root events — so the client cannot dedup them. Re-sending them on
    a reconnect would therefore duplicate every tool row under the card."""
    ready = make_api(provider=delegating_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.wait_turn(session["id"], timeout=30.0)

    full = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    # Frames read off the *subtask's own* stream. The root's `subtask_started`
    # and `subtask_finished` also mention a subtask, but they are derived from
    # the root's log and are durable — the distinction is the whole rule.
    from_subtask = [
        f for f in full if f.event in {"tool_call", "tool_result"} and "subtask_id" in f.data
    ]
    assert from_subtask, "the delegation chain produced no subtask frames"
    assert all(f.seq is None for f in from_subtask), "a subtask frame carried a seq"
    assert next(f for f in full if f.event == "subtask_started").seq is not None
    # And they are stamped with the PARENT's stream, not their own: their own
    # task id is a stream no client filters on, so stamping it would hide
    # every subtask card behind the branch filter.
    root = next(f for f in full if f.event == "user_message").data["_task"]
    assert {f.data["_task"] for f in from_subtask} == {root}

    durable = [f.seq for f in full if f.seq is not None]
    reconnect = ready.frames(
        session["id"], params={"since_seq": min(durable)}, timeout=5.0
    )

    assert not [
        f
        for f in reconnect
        if f.event in {"tool_call", "tool_result"} and "subtask_id" in f.data
    ]


def test_a_subtask_card_is_opened_and_closed_in_replay(make_api):
    """The tool rows of a subtask are spliced in right after its
    `subtask_started`.

    Order is not decoration here: a client receives them in stream order and
    has nowhere to put a tool row whose card has not been opened yet."""
    ready = make_api(provider=delegating_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "go")
    ready.wait_turn(session["id"], timeout=30.0)

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)

    kinds = types_of(frames)
    assert kinds.index("subtask_started") < kinds.index("tool_call")
    assert kinds.index("tool_call") < kinds.index("tool_result")


def test_replay_stamps_every_frame_with_its_stream(make_api):
    """Every replayed frame carries a `_task` tag identifying its stream.

    A session now owns exactly one live stream (its root) — `fork` mints a
    child *session*, not a sibling stream — so the tag is constant across an
    ordinary session's replay. The tag is still stamped because the client fold
    keys on it and a fork's inherited prefix rides the child's own tag."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "first")
    ready.wait_turn(session["id"])
    ready.send(session["id"], "second")
    ready.wait_turn(session["id"])

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=3.0)
    tags = {f.data.get("_task") for f in frames if f.data.get("_task")}
    assert len(tags) == 1
    messages = [f for f in frames if f.event == "user_message"]
    assert [f.data["content"] for f in messages] == ["first", "second"]


def test_a_live_frame_arrives_after_replay_done(api: Api):
    """Subscribe **before** replaying, or an event landing in the gap between
    the two is lost forever. The overlap the early subscription creates is
    deduped by `seq`, which costs nothing."""
    project, session = api.open_session()

    timeouts = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    with httpx.Client(base_url=api.sse.base_url, timeout=timeouts) as client:
        with client.stream(
            "GET", f"/api/v1/sessions/{session['id']}/events", params={"since_seq": 0}
        ) as response:
            lines = response.iter_lines()
            seen: list[str] = []
            for line in lines:
                seen.append(line)
                if line == "event: replay_done":
                    break
            # Only now does anything happen in the session at all.
            api.send(session["id"], "hello")
            for line in lines:
                seen.append(line)
                if line == "event: user_message":
                    break

    assert seen.index("event: replay_done") < seen.index("event: user_message")


# ---------------------------------------------------------------------------
# Backpressure and heartbeat
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_a_full_queue_drops_deltas_and_never_a_durable_frame():
    """The one place the deleted implementation was known-wrong: an unbounded
    queue with no drop guard.

    A `delta` is a preview of bytes the turn records anyway, so dropping one
    costs a repaint. A frame carrying a `seq` is durable and its loss is
    invisible — the client's cursor moves past it and a reconnect never asks
    for it again."""
    import asyncio

    sub = Subscription(asyncio.get_running_loop(), maxsize=3)
    for index in range(3):
        sub.offer(UIEvent(None, "delta", {"index": index}))

    sub.offer(UIEvent(None, "delta", {"index": 99}))
    assert sub.dropped_deltas == 1
    assert not sub.overflowed

    # A durable frame at a full queue evicts a delta rather than being lost.
    sub.offer(UIEvent(7, "assistant_text", {}))
    assert sub.dropped_deltas == 2
    assert not sub.overflowed
    drained = [await sub.next(0.01) for _ in range(3)]
    assert [f.type for f in drained] == ["delta", "delta", "assistant_text"]


@pytest.mark.anyio
async def test_a_queue_that_cannot_make_room_closes_the_stream():
    """With no delta to evict there is nothing safe to drop, so the stream ends
    and the client reconnects with `since_seq`. Re-derivation **is** the
    recovery path — which is why replay is a pure function of the log and not
    a stored projection."""
    import asyncio

    sub = Subscription(asyncio.get_running_loop(), maxsize=2)
    sub.offer(UIEvent(1, "assistant_text", {}))
    sub.offer(UIEvent(2, "assistant_text", {}))

    sub.offer(UIEvent(3, "assistant_text", {}))

    assert sub.overflowed
    assert sub.dropped_deltas == 0


@pytest.mark.anyio
async def test_silence_yields_a_heartbeat_rather_than_a_frame():
    """15 seconds of silence must produce `: ping`, not a closed connection.

    Pinned against the queue rather than the endpoint: waiting 15 s in a test
    would cost more than the rule is worth, and this is the object that
    decides."""
    import asyncio

    sub = Subscription(asyncio.get_running_loop(), maxsize=4)

    assert await sub.next(0.05) is None
    assert HEARTBEAT_S == 15.0


def test_the_queue_is_bounded():
    """A browser tab left paused must not be able to hold a session's whole
    history in the server's memory."""
    assert 0 < QUEUE_SIZE <= 4096


# ---------------------------------------------------------------------------
# Reads never queue behind the drive worker
# ---------------------------------------------------------------------------


def test_replay_does_not_queue_behind_an_active_turn(make_api):
    """Row 33, with a real timing assertion.

    One worker, one turn holding it for seconds. If replay went through the
    same queue, **every** session's stream — finished ones included — would
    sit without `replay_done` until the turn ended, and the whole frontend
    would hang on a loading skeleton."""
    ready = make_api(provider=pacing_provider(delay=1.0, rounds=6), agent_num_workers=1)
    project = ready.create_project()
    busy = ready.create_session(project["id"])
    idle = ready.create_session(project["id"])
    ready.send(busy["id"], "hold the worker")
    ready.wait(busy["id"], "running")

    started = time.monotonic()
    frames = ready.frames(
        idle["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "replay_done",
        timeout=3.0,
    )
    elapsed = time.monotonic() - started

    assert types_of(frames) == ["replay_done"]
    assert elapsed < 1.5, f"replay waited {elapsed:.2f}s on an unrelated turn"
    # And the busy session's own replay is just as free.
    started = time.monotonic()
    ready.frames(
        busy["id"],
        params={"since_seq": 0},
        until=lambda frame: frame.event == "replay_done",
        timeout=3.0,
    )
    assert time.monotonic() - started < 1.5


def test_a_content_read_does_not_queue_behind_an_active_turn(make_api):
    """Row 32. An active turn holds the worker; a trace-page deref must not
    wait for it."""
    import base64

    png = base64.b64encode(PNG_BYTES).decode()
    ready = make_api(provider=pacing_provider(delay=1.0, rounds=6), agent_num_workers=1)
    project = ready.create_project()
    attached = ready.create_session(project["id"])
    ready.send(attached["id"], "look", images=[{"media_type": "image/png", "data_base64": png}])
    ready.wait_turn(attached["id"], timeout=30.0)
    image = next(
        f
        for f in ready.frames(attached["id"], params={"since_seq": 0}, timeout=5.0)
        if f.event == "user_message" and "images" in f.data
    )
    digest = image.data["images"][0]["hash"]

    busy = ready.create_session(project["id"])
    ready.send(busy["id"], "hold the worker")
    ready.wait(busy["id"], "running")

    started = time.monotonic()
    response = ready.http.get(f"/api/v1/content/{digest}", timeout=3.0)
    elapsed = time.monotonic() - started

    assert response.status_code == 200
    assert elapsed < 1.5, f"a content read waited {elapsed:.2f}s on an unrelated turn"


#: The smallest valid PNG: an 8-bit RGBA 1×1 pixel. Real bytes rather than a
#: placeholder because the content endpoint sniffs the type from them.
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000002000100fe21bc330000000049454e44ae"
    "426082"
)
