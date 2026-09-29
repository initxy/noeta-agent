"""Session titles.

Two titles with two different caps and two different lifetimes, and most of
the assertions here exist because conflating them is easy: the synchronous
fallback is the message's first line at 40 characters, the generated one is a
cleaned model answer at 16.

The rest pins the trigger policy — generated exactly once, never retried in a
process that already failed, all material re-read from the event stream — and
the one gateway detail that made every title come back empty until it was
found: reasoning must be switched off on the call.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from types import SimpleNamespace as NS
from typing import Any

import pytest

from noeta.agent.config import Settings
from noeta.agent.host import title as title_module
from noeta.agent.host.title import (
    FALLBACK_MAXLEN,
    TITLE_MAX_OUTPUT_TOKENS,
    TITLE_MAXLEN,
    TITLE_TIMEOUT,
    TitleService,
    TitleTarget,
    clean_title,
    fallback_title,
    generate_title,
)

TASK = "task-1"
SESSION = "session-1"


# ---------------------------------------------------------------------------
# Event-stream doubles
#
# Envelopes are SimpleNamespaces for the same reason the translator's own
# tests use them: the translator reads structural tags, never engine types.
# ---------------------------------------------------------------------------


def _messages_envelope(seq: int, body: list[dict[str, Any]]) -> Any:
    return NS(
        type="MessagesAppended",
        seq=seq,
        task_id=TASK,
        payload=NS(messages_ref=NS(__canonical_tag__="content_ref", hash=f"h{seq}")),
    )


def _deref_for(bodies: dict[str, list[dict[str, Any]]]):
    return lambda ref: json.dumps(bodies[ref.hash]).encode()


def _text_message(role: str, text: str, origin: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "__canonical_tag__": "message",
        "role": role,
        "content": [{"__canonical_tag__": "text_block", "text": text}],
    }
    if origin is not None:
        body["origin"] = origin
    return body


def _conversation(user_text: str, assistant_text: str | None = None):
    """An `events_after` + `deref` pair carrying one exchange."""
    bodies = {"h0": [_text_message("user", user_text)]}
    envelopes = [_messages_envelope(0, bodies["h0"])]
    if assistant_text is not None:
        bodies["h1"] = [_text_message("assistant", assistant_text)]
        envelopes.append(_messages_envelope(1, bodies["h1"]))
    return envelopes, _deref_for(bodies)


class _Recorder:
    """The store and hub halves the service is injected with."""

    def __init__(self, target: TitleTarget | None) -> None:
        self.target = target
        self.saved: list[tuple[str, str]] = []
        self.pushed: list[tuple[str, Any]] = []
        self.reads = 0

    def read_session(self, session_id: str) -> TitleTarget | None:
        self.reads += 1
        return self.target

    def save_title(self, session_id: str, title: str) -> None:
        self.saved.append((session_id, title))
        # The store marks it generated in the same write; mirror that so a
        # later trigger in this test sees what a later trigger would see.
        if self.target is not None:
            self.target = TitleTarget(task_id=self.target.task_id, generated=True)

    def push_frame(self, session_id: str, frame: Any) -> None:
        self.pushed.append((session_id, frame))


def _service(
    settings: Settings,
    recorder: _Recorder,
    *,
    generate: Any,
    conversation: tuple[list[Any], Any] | None = None,
    events_calls: list[str] | None = None,
) -> TitleService:
    envelopes, deref = conversation or _conversation("Write a platform report")

    def events_after(task_id: str) -> list[Any]:
        if events_calls is not None:
            events_calls.append(task_id)
        return envelopes

    return TitleService(
        settings,
        read_session=recorder.read_session,
        save_title=recorder.save_title,
        push_frame=recorder.push_frame,
        events_after=events_after,
        deref=deref,
        generate=generate,
    )


@pytest.fixture
def mock_settings(make_settings: Callable[..., Settings]) -> Settings:
    return make_settings()


@pytest.fixture
def gateway_settings(make_settings: Callable[..., Settings]) -> Settings:
    return make_settings(
        llm_provider="auto",
        llm_base_url="https://gateway.test/api",
        llm_api_key="gw-key",
        secondary_llm_base_url="",
        secondary_llm_api_key="",
    )


# ---------------------------------------------------------------------------
# The two caps
# ---------------------------------------------------------------------------


def test_the_two_caps_are_different_numbers() -> None:
    """The generated title is a sidebar label; the fallback is the user's own
    first line. Folding them into one constant silently retruncates one of
    them."""
    assert (TITLE_MAXLEN, FALLBACK_MAXLEN) == (16, 40)

    message = "Help me analyze checkout conversion"  # 35 characters
    assert fallback_title(message) == message
    # Cut at 16, then the dangling separator goes: a title never ends mid-gap.
    assert clean_title(message) == "Help me analyze"


def test_fallback_takes_the_first_line_and_caps_at_40() -> None:
    assert fallback_title("first line\nsecond line") == "first line"
    assert fallback_title("x" * 60) == "x" * FALLBACK_MAXLEN


def test_fallback_survives_a_message_with_no_text() -> None:
    """An image-only send has no lines at all: `"".splitlines()` is `[]`, so
    indexing it crashes the send path that sets the title."""
    assert fallback_title("") == ""
    assert fallback_title("   \n  ") == ""


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param('"Platform report"', "Platform report", id="quotes"),
        pytest.param("《Tracking plan》。", "Tracking plan", id="cjk-marks"),
        pytest.param("`Deploy runbook`", "Deploy runbook", id="backticks"),
        pytest.param("Analyze churn\n", "Analyze churn", id="trailing-newline"),
        pytest.param("Row a\nRow b", "Row a Row b", id="two-lines-fold"),
        pytest.param("abcdefghijklmnopqrst", "abcdefghijklmnop", id="truncated-to-16"),
        pytest.param("   。、  ", "", id="punctuation-only"),
        pytest.param("", "", id="empty"),
    ],
)
def test_clean_title_examples(raw: str, expected: str) -> None:
    assert clean_title(raw) == expected


# ---------------------------------------------------------------------------
# The gateway call
# ---------------------------------------------------------------------------


def test_generate_title_is_a_no_op_under_the_mock_provider(
    mock_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("the mock provider must not reach a gateway")

    monkeypatch.setattr(title_module.httpx, "post", _forbidden)
    assert generate_title(mock_settings, "Write a report", None, TASK) is None


def test_generate_title_skips_an_empty_conversation(gateway_settings: Settings) -> None:
    assert generate_title(gateway_settings, "   ", None, TASK) is None


def _capture_post(
    monkeypatch: pytest.MonkeyPatch, payload: dict[str, Any]
) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    def _post(url: str, **kwargs: Any) -> Any:
        captured["url"] = url
        captured.update(kwargs)
        return NS(raise_for_status=lambda: None, json=lambda: payload)

    monkeypatch.setattr(title_module.httpx, "post", _post)
    return captured


def _responses_payload(text: str) -> dict[str, Any]:
    return {
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "content": [{"type": "output_text", "text": text}]},
        ]
    }


def test_the_call_disables_reasoning_and_stays_small(
    gateway_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without `reasoning: {"effort": "none"}` a reasoning model spends the
    whole output budget on hidden tokens and returns `status=incomplete` with
    no message — the title comes back empty every time, silently."""
    captured = _capture_post(monkeypatch, _responses_payload('"Platform report"'))

    assert generate_title(gateway_settings, "Write a platform report", None, TASK) == (
        "Platform report"
    )

    assert captured["url"] == "https://gateway.test/api/responses"
    body = captured["json"]
    assert body["reasoning"] == {"effort": "none"}
    assert body["max_output_tokens"] == TITLE_MAX_OUTPUT_TOKENS
    assert body["store"] is False
    assert captured["timeout"] == TITLE_TIMEOUT
    # Same prompt-cache affinity key the chat turns carry.
    assert captured["headers"]["x-session-id"] == TASK
    assert captured["headers"]["Authorization"] == "Bearer gw-key"


def test_the_prompt_carries_the_user_message_and_the_reply(
    gateway_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured = _capture_post(monkeypatch, _responses_payload("Churn review"))
    generate_title(
        gateway_settings, "Analyse churn", "Here is the churn breakdown", TASK
    )

    prompt = captured["json"]["input"][0]["content"][0]["text"]
    assert "Analyse churn" in prompt
    assert "Here is the churn breakdown" in prompt


def test_an_empty_or_punctuation_only_answer_is_a_failure(
    gateway_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    _capture_post(monkeypatch, _responses_payload("。、"))
    assert generate_title(gateway_settings, "Write a report", None, TASK) is None


def test_a_transport_failure_is_a_failure_not_a_crash(
    gateway_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("gateway down")

    monkeypatch.setattr(title_module.httpx, "post", _boom)
    assert generate_title(gateway_settings, "Write a report", None, TASK) is None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def test_a_generated_title_is_persisted_and_pushed_once(
    mock_settings: Settings,
) -> None:
    """The frame is synthetic — `seq is None` — because a title cannot be
    derived from the event log. That is what keeps it out of a replay."""
    calls: list[tuple[str, str | None, str]] = []

    def _generate(settings, first_message, assistant_reply, task_id):
        calls.append((first_message, assistant_reply, task_id))
        return "Platform report"

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(mock_settings, recorder, generate=_generate)

    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert recorder.saved == [(SESSION, "Platform report")]
    session_id, frame = recorder.pushed[0]
    assert (session_id, frame.type, frame.data, frame.seq) == (
        SESSION,
        "session_meta",
        {"title": "Platform report"},
        None,
    )

    # A second turn boundary must not spend another LLM call: the store now
    # reports the title generated, and that flag is durable.
    assert service.maybe_generate(SESSION) is None
    assert len(calls) == 1


def test_the_generator_receives_the_raw_goal_and_the_task_id(
    mock_settings: Settings,
) -> None:
    """Read back off the event stream, not from the send path's memory — which
    is what lets a session recovered after a restart be titled at all."""
    calls: list[tuple[str, str | None, str]] = []

    def _generate(settings, first_message, assistant_reply, task_id):
        calls.append((first_message, assistant_reply, task_id))
        return "Report"

    goal = "Write a report on the data platform"
    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(
        mock_settings, recorder, generate=_generate, conversation=_conversation(goal)
    )
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert calls == [(goal, None, TASK)]


def test_a_failed_generation_leaves_the_fallback_and_does_not_set_the_flag(
    mock_settings: Settings,
) -> None:
    """Persistent failures self-heal, transient failures do not spam: the
    process stops retrying, the durable flag stays unset, and a restart gets
    exactly one more attempt."""
    calls: list[int] = []

    def _generate(settings, first_message, assistant_reply, task_id):
        calls.append(1)
        return None

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(mock_settings, recorder, generate=_generate)

    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert calls == [1]
    assert recorder.saved == []
    assert recorder.pushed == []
    # Still not generated durably, but this process will not try again.
    assert recorder.target == TitleTarget(task_id=TASK, generated=False)
    assert service.maybe_generate(SESSION) is None
    assert calls == [1]


def test_a_crashing_generator_is_a_failure_not_a_dead_thread(
    mock_settings: Settings,
) -> None:
    def _generate(settings, first_message, assistant_reply, task_id):
        raise RuntimeError("boom")

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(mock_settings, recorder, generate=_generate)
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert recorder.saved == []
    assert service.maybe_generate(SESSION) is None


def test_a_session_deleted_mid_generation_is_not_resurrected(
    mock_settings: Settings,
) -> None:
    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))

    def _generate(settings, first_message, assistant_reply, task_id):
        # The user deletes the session while the gateway is thinking.
        recorder.target = None
        return "Platform report"

    service = _service(mock_settings, recorder, generate=_generate)
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert recorder.saved == []
    assert recorder.pushed == []


def test_nothing_runs_without_a_seeded_task_or_an_existing_session(
    mock_settings: Settings,
) -> None:
    def _generate(*args: Any) -> str:
        raise AssertionError("must not be called")

    for recorder in (
        # Seeded with no task stream yet: the first message has not landed.
        _Recorder(TitleTarget(task_id="", generated=False)),
        # Deleted between the turn boundary and the read.
        _Recorder(None),
        # Already titled, durably.
        _Recorder(TitleTarget(task_id=TASK, generated=True)),
    ):
        service = _service(mock_settings, recorder, generate=_generate)
        assert service.maybe_generate(SESSION) is None


def test_a_second_trigger_while_one_is_in_flight_starts_nothing(
    mock_settings: Settings,
) -> None:
    """A turn boundary can arrive twice before the first call returns."""
    import threading

    released = threading.Event()
    started = threading.Event()
    calls: list[int] = []

    def _generate(settings, first_message, assistant_reply, task_id):
        calls.append(1)
        started.set()
        released.wait(timeout=5)
        return "Platform report"

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(mock_settings, recorder, generate=_generate)

    thread = service.maybe_generate(SESSION)
    assert thread is not None
    assert started.wait(timeout=5)
    assert service.maybe_generate(SESSION) is None
    released.set()
    thread.join(timeout=5)

    assert calls == [1]


def test_forget_clears_the_in_process_failure_memory(mock_settings: Settings) -> None:
    outcomes = [None, "Platform report"]

    def _generate(settings, first_message, assistant_reply, task_id):
        return outcomes.pop(0)

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(mock_settings, recorder, generate=_generate)

    first = service.maybe_generate(SESSION)
    assert first is not None
    first.join(timeout=5)
    assert service.maybe_generate(SESSION) is None

    service.forget(SESSION)
    second = service.maybe_generate(SESSION)
    assert second is not None
    second.join(timeout=5)
    assert recorder.saved == [(SESSION, "Platform report")]


# ---------------------------------------------------------------------------
# Reading the conversation
# ---------------------------------------------------------------------------


def test_the_assistant_read_is_short_circuited_under_the_mock(
    mock_settings: Settings,
) -> None:
    """`generate_title` returns `None` under the mock anyway, so reading the
    reply would start a pointless second pass over the event stream on every
    single mock turn."""
    reads: list[str] = []
    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(
        mock_settings,
        recorder,
        generate=lambda *args: "Platform report",
        conversation=_conversation("Write a report", "Here is the report"),
        events_calls=reads,
    )
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert reads == [TASK]


def test_the_gateway_path_reads_the_latest_assistant_reply(
    gateway_settings: Settings,
) -> None:
    calls: list[tuple[str, str | None, str]] = []

    def _generate(settings, first_message, assistant_reply, task_id):
        calls.append((first_message, assistant_reply, task_id))
        return "Platform report"

    reads: list[str] = []
    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = _service(
        gateway_settings,
        recorder,
        generate=_generate,
        conversation=_conversation("Write a report", "Here is the report"),
        events_calls=reads,
    )
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert calls == [("Write a report", "Here is the report", TASK)]
    assert reads == [TASK, TASK]


def test_an_unreadable_event_stream_is_a_failure_not_a_crash(
    mock_settings: Settings,
) -> None:
    def _events_after(task_id: str) -> list[Any]:
        raise RuntimeError("event log unavailable")

    recorder = _Recorder(TitleTarget(task_id=TASK, generated=False))
    service = TitleService(
        mock_settings,
        read_session=recorder.read_session,
        save_title=recorder.save_title,
        push_frame=recorder.push_frame,
        events_after=_events_after,
        deref=lambda ref: None,
        generate=lambda *args: "Platform report",
    )
    thread = service.maybe_generate(SESSION)
    assert thread is not None
    thread.join(timeout=5)

    assert recorder.saved == []
