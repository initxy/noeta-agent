"""The SSE reader's framing rules.

Phase 1 puts the whole conversation through this reader, so its shape is pinned
before anything depends on it. The rules are not stylistic: `": "` is what the
emitter and the reader agree on, a missing `id:` line is how the format makes
loss-on-reconnect impossible for deltas, and returning-on-timeout is what turns
"the event never arrived" into a readable content failure.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from tests.conftest import SSEFrame, SSEReader, parse_sse_lines, serve_app


def frame(text: str) -> list[str]:
    """Split an SSE wire snippet the way `httpx.Response.iter_lines` does."""
    return text.split("\n")


def test_parses_event_data_and_id():
    frames = parse_sse_lines(frame('event: assistant_text\ndata: {"text": "hi"}\nid: 12\n\n'))

    assert frames == [SSEFrame(event="assistant_text", data={"text": "hi"}, seq=12)]


def test_a_frame_without_an_id_line_has_seq_none():
    """Not an error state. A `delta` frame carries no `id:` on purpose: with one,
    the resume cursor advances past envelopes that never reached the client and
    reconnect skips them forever. Every synthetic frame is the same."""
    frames = parse_sse_lines(frame('event: delta\ndata: {"text": "a"}\n\n'))

    assert frames == [SSEFrame(event="delta", data={"text": "a"}, seq=None)]


def test_comment_lines_are_skipped():
    """Heartbeats and the `: connected` preamble keep the connection alive
    without being events."""
    frames = parse_sse_lines(frame(': connected\n\n:\n\nevent: ping\ndata: 1\n\n'))

    assert frames == [SSEFrame(event="ping", data=1, seq=None)]


def test_blank_lines_terminate_frames():
    frames = parse_sse_lines(frame("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"))

    assert [(f.event, f.data) for f in frames] == [("a", 1), ("b", 2)]


def test_an_unterminated_frame_is_not_emitted():
    """A stream cut mid-frame yields the frames that completed, not a partial."""
    frames = parse_sse_lines(frame("event: a\ndata: 1\n\nevent: b\ndata: 2"))

    assert [f.event for f in frames] == ["a"]


def test_the_separator_is_colon_space_exactly():
    """`id:12` must fail here rather than silently parse — the emitter and the
    reader agree on one literal, and drift shows up at the source."""
    with pytest.raises(AssertionError, match="separator"):
        parse_sse_lines(frame("event: a\nid:12\ndata: 1\n\n"))


def test_data_must_be_single_line_json():
    with pytest.raises(AssertionError, match="single-line JSON"):
        parse_sse_lines(frame("event: a\ndata: not json\n\n"))

    with pytest.raises(AssertionError, match="repeated 'data'"):
        parse_sse_lines(frame('event: a\ndata: {"a":\ndata: 1}\n\n'))


def test_limit_and_until_stop_early():
    wire = frame("event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3\n\n")

    assert [f.event for f in parse_sse_lines(wire, limit=2)] == ["a", "b"]
    assert [
        f.event for f in parse_sse_lines(wire, until=lambda f: f.event == "b")
    ] == ["a", "b"]


def test_a_read_timeout_returns_what_arrived():
    """The single most useful property of this reader.

    A test that expected a stop event and got nothing then fails on *content* —
    showing exactly which frames did arrive — instead of on a timeout traceback
    that says nothing about the bug."""

    def lines():
        yield from frame("event: a\ndata: 1\n\n")
        raise httpx.ReadTimeout("no data")

    assert [f.event for f in parse_sse_lines(lines())] == ["a"]


def test_reader_returns_what_arrived_on_a_still_open_stream(settings):
    """The same property over the real transport: an SSE endpoint is an infinite
    stream, so the reader has to come back from one that is alive and silent.

    This is also why the harness runs a real uvicorn — starlette's `TestClient`
    does not truly stream a body, and reading this endpoint through it would
    block forever."""
    app = FastAPI()

    @app.get("/stream")
    async def stream():
        async def body():
            yield 'event: hello\ndata: {"n": 1}\nid: 1\n\n'
            yield ": heartbeat\n\n"
            await asyncio.sleep(30)  # never reached: the reader gives up first

        return StreamingResponse(body(), media_type="text/event-stream")

    with serve_app(app, settings) as server:
        frames = SSEReader(server.base_url).read("/stream", timeout=0.3)

    assert frames == [SSEFrame(event="hello", data={"n": 1}, seq=1)]
