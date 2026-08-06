"""Token streaming end to end: `LEDGER §9.2` rows 12-15.

The delta path has two halves and they fail in opposite directions:

- **the preview** must reach the browser while the LLM call is still running,
  and
- **the record** must not contain it. A delta is a preview of bytes the turn
  records anyway; the durable `MessagesAppended` is what a reload reads.

The load-bearing consequence is the one this module reads off the wire rather
than off a parsed object: a `delta` frame carries **no `id:` line**. With one,
the client's resume cursor would advance past envelopes it never received and
a reconnect would skip them forever — silent, permanent loss.

The last test here is an acceptance criterion in its own right: the streamed
and the batch path of the *same* script must produce the same durable record.
`FakeStreamingLLMProvider` is exactly that instrument — `complete_streaming`
and `complete` serve one script, and `streamed_calls` / `batch_calls` say
which path a turn actually took, so "streaming was on" is asserted rather than
assumed.
"""
from __future__ import annotations

import json
import re
import threading
from typing import Any, Callable, Optional

import httpx

from tests.test_api_flow import (  # noqa: F401 - fixtures are used by name
    Api,
    api,
    make_api,
)

CHUNKS = ("Hel", "lo, ", "world")
ANSWER = "".join(CHUNKS)

# How long a gated LLM round waits for the reader to subscribe before giving
# up. Generous: it bounds a hang, and on a green run it is never reached.
SUBSCRIBE_TIMEOUT = 20.0


class Script:
    """`FakeStreamingLLMProvider` with the two knobs these rows need.

    **The gate** holds the LLM round open until the reader has actually
    subscribed. Deltas are live-only by design (§6.1), so a test that sends
    first and connects afterwards is racing the worker thread for them — it
    passes on a fast machine and fails under load, which is the worst kind of
    green.

    **`stop_streaming()` removes the capability structurally.** The runtime
    picks the transport with `isinstance(provider, StreamingProvider)`, a
    runtime-checkable Protocol — so the probe is really `hasattr`. Setting
    `complete_streaming = None` leaves the attribute in place: the probe still
    matches, the call raises `TypeError`, and the turn fails for a reason that
    has nothing to do with transports. Binding the method on the *instance* and
    deleting it is the only spelling of "this provider does not stream" the
    probe actually reads.
    """

    def __init__(self, *, gate: Optional[threading.Event] = None) -> None:
        from noeta.sdk import LLMResponse, StreamDelta, TextBlock, Usage
        from noeta.sdk.testing import FakeStreamingLLMProvider

        response = LLMResponse(
            stop_reason="end_turn", content=(TextBlock(text=ANSWER),), usage=Usage()
        )
        deltas = [StreamDelta(kind="text", text=chunk, index=0) for chunk in CHUNKS]
        # The same script for every round: the turn is one round, and a
        # scripted provider that runs out mid-turn fails for an unrelated
        # reason.
        self.inner = FakeStreamingLLMProvider(
            responses=[response] * 8, deltas=[list(deltas)] * 8
        )
        self._gate = gate
        self.complete_streaming = self._streamed

    # `complete` is on the class: every provider has it, always.
    def complete(self, request: Any) -> Any:
        return self.inner.complete(request)

    def _streamed(
        self,
        request: Any,
        on_delta: Callable[[Any], None],
        request_headers: Optional[dict[str, str]] = None,
    ) -> Any:
        if self._gate is not None:
            assert self._gate.wait(SUBSCRIBE_TIMEOUT), "the reader never subscribed"
        return self.inner.complete_streaming(request, on_delta, request_headers)

    def stop_streaming(self) -> None:
        del self.complete_streaming

    @property
    def streamed_calls(self) -> int:
        return self.inner.streamed_calls

    @property
    def batch_calls(self) -> int:
        return self.inner.batch_calls


def streaming_provider(*, gate: Optional[threading.Event] = None) -> Script:
    """One scripted answer, delivered as three deltas then the full response."""
    return Script(gate=gate)


def read_raw(
    ready: Api,
    session_id: str,
    *,
    on_connect: Optional[Callable[[], None]] = None,
    **params: Any,
) -> str:
    """The SSE response body as text, unparsed.

    Parsing first would hide the very thing rows 12-15 are about: whether an
    `id:` line was written.

    `on_connect` fires once the `: connected` preamble has arrived, which per
    §4.2 is emitted *after* the subscription exists — so it is the earliest
    moment at which releasing a gated turn cannot lose a live frame."""
    timeouts = httpx.Timeout(connect=5.0, read=15.0, write=5.0, pool=5.0)
    chunks: list[str] = []
    with httpx.Client(base_url=ready.http.base_url, timeout=timeouts) as client:
        try:
            with client.stream(
                "GET", f"/api/v1/sessions/{session_id}/events", params=params
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    chunks.append(line)
                    if on_connect is not None and line.startswith(": connected"):
                        on_connect()
                        on_connect = None
                    if line.startswith("event: turn_finished"):
                        # One more blank line closes the frame; the stream is
                        # infinite, so stopping here beats waiting out a read
                        # timeout on every test.
                        break
        except (httpx.TimeoutException, TimeoutError):
            pass
    return "\n".join(chunks)


def frames_of(raw: str) -> list[tuple[str | None, str, Any]]:
    """`(id, event, data)` per frame, with `id` `None` when none was written."""
    out: list[tuple[str | None, str, Any]] = []
    current: dict[str, str] = {}
    for line in raw.split("\n"):
        if not line.strip():
            continue
        if line.startswith(":"):
            continue
        key, _, value = line.partition(": ")
        current[key] = value
        if key == "data":
            out.append(
                (current.get("id"), current.get("event", ""), json.loads(value))
            )
            current = {}
    return out


# ---------------------------------------------------------------------------
# Row 12 / 13 — the preview arrives, and it is not addressable
# ---------------------------------------------------------------------------


def test_deltas_reach_the_stream(make_api):
    gate = threading.Event()
    ready = make_api(provider=streaming_provider(gate=gate))
    project, session = ready.open_session()
    ready.send(session["id"], "hello")

    raw = read_raw(ready, session["id"], since_seq=0, on_connect=gate.set)
    deltas = [data for _, event, data in frames_of(raw) if event == "delta"]

    assert [d["text"] for d in deltas] == list(CHUNKS)
    assert {d["kind"] for d in deltas} == {"text"}
    # Stamped with the stream it belongs to, or a client filtered to one
    # branch would paint another branch's tokens into its preview.
    assert all(d["_task"] for d in deltas)
    # One call_id AND one index per LLM round: the client keys its delta buffer
    # on the pair, and a buffer keyed on nothing cannot be reset between rounds.
    assert len({d["call_id"] for d in deltas}) == 1
    assert {d["index"] for d in deltas} == {0}
    # And their concatenation is the durable text, byte for byte — the preview
    # is repainted by `assistant_text`, so a preview that says something else
    # is a visible flicker on every turn.
    assert "".join(d["text"] for d in deltas) == ANSWER


def test_no_delta_frame_carries_an_sse_id(make_api):
    """Read off the wire, not off a parsed frame.

    An `id:` on a delta would advance the browser's `lastEventId` past
    envelopes it never received, and the next reconnect would skip them
    forever."""
    gate = threading.Event()
    ready = make_api(provider=streaming_provider(gate=gate))
    project, session = ready.open_session()
    ready.send(session["id"], "hello")

    raw = read_raw(ready, session["id"], since_seq=0, on_connect=gate.set)

    assert "event: delta" in raw, "the turn streamed nothing to test"
    for seq, event, _ in frames_of(raw):
        if event == "delta":
            assert seq is None, f"a delta frame carried id: {seq}"
    # And the durable frames DO carry one — otherwise the assertion above
    # would pass on a stream that lost every id.
    durable = [seq for seq, event, _ in frames_of(raw) if event == "assistant_text"]
    assert durable and all(seq is not None for seq in durable)


# ---------------------------------------------------------------------------
# Row 14 — the durable record is what a reload reads
# ---------------------------------------------------------------------------


def test_a_replay_carries_the_text_and_none_of_the_deltas(make_api):
    """Deltas are live-only. Replaying them would double the text on every
    reconnect, and they are not in the log to replay from in the first
    place."""
    ready = make_api(provider=streaming_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "hello")
    ready.wait_turn(session["id"])

    replayed = frames_of(read_raw(ready, session["id"], since_seq=0))

    assert not [event for _, event, _ in replayed if event == "delta"]
    texts = [data["text"] for _, event, data in replayed if event == "assistant_text"]
    assert texts == [ANSWER]


# ---------------------------------------------------------------------------
# Row 15 — streamed and batch produce the same record
# ---------------------------------------------------------------------------


#: Any engine task id, wherever it appears inside a stored body. Two sessions
#: are two tasks by definition, so this is the one difference the criterion
#: cannot be asking about.
_TASK_ID = re.compile(r"task-[0-9a-f]{32}")


def _durable_shape(ready: Api, session_id: str) -> list[tuple[int, str, Any]]:
    """`(seq, type, the ContentStore bodies it points at)` per envelope.

    Comparing *hashes* would have been the cheap version and it is the wrong
    one: `TaskSnapshot.state_ref` embeds the task id, so two sessions can never
    hash-match no matter how identical the exchange was, and a test that
    tolerated that mismatch would have had to stop looking at snapshots
    altogether — which is where the whole conversation is stored.

    So the bodies are fetched and compared byte for byte, with task ids
    normalised. Everything an envelope legitimately re-rolls (its id, its
    timestamps, its trace correlation) is dropped by keeping only
    `(seq, type)`; what remains is the claim: the same envelope sequence
    carrying the same bytes.
    """
    shape: list[tuple[int, str, Any]] = []
    for event in _raw_events(ready, session_id):
        bodies = [_body(ready, h) for h in sorted(_hashes(event["payload"]))]
        shape.append((event["seq"], event["type"], bodies))
    return shape


def _body(ready: Api, content_hash: str) -> str:
    response = ready.http.get(f"/api/v1/content/{content_hash}")
    assert response.status_code == 200, response.text
    return _TASK_ID.sub("task-<id>", response.text)


def _hashes(value: Any) -> list[str]:
    if isinstance(value, dict):
        if value.get("__canonical_tag__") == "content_ref":
            return [str(value.get("hash"))]
        return [h for item in value.values() for h in _hashes(item)]
    if isinstance(value, list):
        return [h for item in value for h in _hashes(item)]
    return []


def test_streamed_and_batch_turns_record_the_same_thing(make_api):
    """The acceptance criterion, as an assertion.

    One provider instance serves both paths, so the *content* is identical by
    construction and the only variable is the transport. `streamed_calls` /
    `batch_calls` prove each session actually took the path it was meant to —
    without them a provider that silently fell back to `complete` would make
    this test pass by doing nothing."""
    provider = streaming_provider()
    ready = make_api(provider=provider)
    project = ready.create_project()

    streamed_session = ready.create_session(project["id"])
    ready.send(streamed_session["id"], "hello")
    ready.wait_turn(streamed_session["id"])
    assert provider.streamed_calls >= 1

    # The batch path: the same instance, no longer advertising the streaming
    # capability. The runtime picks streaming whenever the provider offers it,
    # so the switch has to be a structural one — see `Script.stop_streaming`.
    provider.stop_streaming()
    before = provider.batch_calls
    batch_session = ready.create_session(project["id"])
    ready.send(batch_session["id"], "hello")
    ready.wait_turn(batch_session["id"])
    assert provider.batch_calls > before, "the second turn still streamed"

    streamed = _durable_shape(ready, streamed_session["id"])
    batch = _durable_shape(ready, batch_session["id"])

    assert streamed == batch
    # Guard the guard: an empty shape would compare equal to another empty one.
    assert [kind for _, kind, _ in streamed].count("MessagesAppended") >= 2
    assert any(bodies for _, _, bodies in streamed)


def _raw_events(ready: Api, session_id: str) -> list[dict[str, Any]]:
    response = ready.http.get(f"/api/v1/trace/sessions/{session_id}/raw-events")
    assert response.status_code == 200, response.text
    return response.json()["events"]
