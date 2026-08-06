"""`LLMRetryScheduled` → `llm_retry`, pinned as a pure mapping.

Driving a real retry end to end needs the provider to raise a genuinely
retryable error, which the mock cannot be made to do reliably. The translator
is a pure function, so constructing the envelope directly pins the mapping
exactly as well — and this is the one frame whose whole job is invisible: it
renders no UI, and only tells the client to drop its delta buffer.
"""

from __future__ import annotations

from types import SimpleNamespace as NS

from noeta.agent.host.translator import translate


def retry_env(seq: int, call_id: str, *, task_id: str = "task-x"):
    return NS(
        type="LLMRetryScheduled",
        seq=seq,
        task_id=task_id,
        payload=NS(
            call_id=call_id,
            attempt=1,
            max_retries=3,
            delay_seconds=2.0,
            category="rate_limit",
            error="429 Too Many Requests",
        ),
    )


def test_llm_retry_scheduled_carries_only_the_call_id():
    """The retry re-streams under the same call id.

    Without this frame the client concatenates the abandoned half-stream onto
    the new one and renders garbage; with it, the buffer is dropped and the
    durable `assistant_text` repaints. The backoff details stay off the wire —
    they belong to the raw-event trace surface.
    """
    (event,) = translate(retry_env(42, "call-abc"), None)
    assert event.seq == 42
    assert event.type == "llm_retry"
    assert event.data == {"call_id": "call-abc", "_task": "task-x"}


def test_llm_retry_is_durable_so_replay_re_derives_it():
    """It carries a seq: it is on the ledger and survives a reconnect.

    A synthetic frame would leave a resumed client holding a stale buffer for
    a call whose retry it never saw.
    """
    (event,) = translate(retry_env(7, "call-xyz"), None)
    assert event.seq is not None


def test_llm_retry_inside_a_subtask_stream_is_dropped():
    """Subtask streaming is unimplemented, so there is no buffer to clear."""
    assert translate(retry_env(8, "call-sub"), None, subtask_id="s1") == []
