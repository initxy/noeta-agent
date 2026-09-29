"""The offline model.

The mock is a product feature — it is what makes a credential-free first run a
working workbench — so it is pinned like one. Every assertion below is about a
decision the responder makes from the conversation alone: there is no cursor to
advance, no script to keep in step, and arbitrary input has to produce a turn
rather than an exception.
"""
from __future__ import annotations

from typing import Any

import pytest

from noeta.agent.host import mock_llm
from noeta.agent.host.mock_llm import (
    CONSOLIDATION_PREAMBLE,
    DEMO_REPORT_PATH,
    SUBAGENT_GOAL_PREFIX,
    SUBAGENT_PACE_SECONDS,
    TOOL_ASK,
    TOOL_MEMORY_WRITE,
    TOOL_SHELL,
    TOOL_SKILL,
    TOOL_SPAWN,
    TOOL_WRITE,
    build_mock_provider,
    mock_responder,
)
from noeta.presets import main_options
from noeta.sdk import (
    LLMRequest,
    LLMResponse,
    Message,
    StreamingProvider,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)

# The receipt the engine writes when a question is answered. The 0.6.x answer
# shape is `{question_id, answers}` where each answer is
# `{"selected": [labels...], "other": text}`, keyed by the question's index.
_ANSWERED = {
    "question_id": "0",
    "answers": {"0": {"selected": ["Engineer"], "other": None}},
}

ALL_TOOLS = (
    TOOL_ASK, TOOL_SKILL, TOOL_WRITE, TOOL_SHELL, TOOL_MEMORY_WRITE, TOOL_SPAWN,
)


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _schema(name: str) -> dict[str, Any]:
    """A tool as the runtime renders it: the provider function-calling shape."""
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def _request(messages: list[Message], tools: tuple[str, ...] = ALL_TOOLS) -> LLMRequest:
    return LLMRequest(
        model="mock-model", messages=messages, tools=[_schema(n) for n in tools]
    )


def _user(text: str, origin: str | None = None) -> Message:
    return Message(role="user", content=[TextBlock(text=text)], origin=origin)


def _assistant_call(call_id: str, tool_name: str, **arguments: Any) -> Message:
    return Message(
        role="assistant",
        content=[
            ToolUseBlock(call_id=call_id, tool_name=tool_name, arguments=arguments)
        ],
    )


def _assistant_text(text: str) -> Message:
    return Message(role="assistant", content=[TextBlock(text=text)])


def _receipt(call_id: str, output: Any = "ok") -> Message:
    return Message(
        role="tool",
        content=[ToolResultBlock(call_id=call_id, output=output, success=True)],
    )


def _tool_call(response: LLMResponse) -> ToolUseBlock:
    assert response.stop_reason == "tool_use", response
    block = response.content[0]
    assert isinstance(block, ToolUseBlock)
    return block


def _text(response: LLMResponse) -> str:
    assert response.stop_reason == "end_turn", response
    block = response.content[0]
    assert isinstance(block, TextBlock)
    return block.text


# ---------------------------------------------------------------------------
# The demo chain
# ---------------------------------------------------------------------------


def test_first_turn_asks_a_clarifying_question() -> None:
    call = _tool_call(mock_responder(_request([_user("Write a platform report")])))
    assert call.tool_name == TOOL_ASK
    question = call.arguments["questions"][0]
    assert question["multiSelect"] is False
    # The "Other" free-text slot is always added by the engine, so no
    # `allow_freeform` flag is needed to keep the freeform path exercised.


def test_question_shape_is_engine_valid() -> None:
    """The 0.6.x `AskUserQuestion` schema: a header (max 12 chars), a question
    string, and 2-4 `{label, description}` options. A malformed call is a
    failed turn rather than a validation message the user can act on."""
    call = _tool_call(mock_responder(_request([_user("Write a report")])))
    question = call.arguments["questions"][0]
    assert question["question"] and question["question"].endswith("?")
    assert question["header"] and len(question["header"]) <= 12
    assert 2 <= len(question["options"]) <= 4
    for option in question["options"]:
        assert option["label"]
        assert option["description"]


def test_answered_question_activates_a_skill() -> None:
    messages = [
        _user("Write a report"),
        _assistant_call("c1", TOOL_ASK),
        _receipt("c1", _ANSWERED),
    ]
    call = _tool_call(mock_responder(_request(messages)))
    assert call.tool_name == TOOL_SKILL


def test_an_activated_skill_writes_the_report() -> None:
    """`skill` is a CONTROL tool: it produces no tool receipt, only an
    `Activated skill:` user message. Resuming the chain from a receipt that
    never arrives is why a workspace with a real skill used to lose the file
    write — verified live against 0.5.1, not assumed from the schema."""
    messages = [
        _user("Write a report"),
        _assistant_call("c1", TOOL_ASK),
        _receipt("c1", _ANSWERED),
        _assistant_call("c2", TOOL_SKILL),
        _user("Activated skill: demo-skill"),
    ]
    call = _tool_call(mock_responder(_request(messages)))
    assert call.tool_name == TOOL_WRITE
    assert call.arguments["file_path"] == DEMO_REPORT_PATH
    # The answer the user gave is carried into the artifact, which is what
    # makes the chain a round trip rather than four unrelated steps. The 0.6.x
    # answer surfaces the option's label ("Engineer"), not a choice id.
    assert "Engineer" in call.arguments["content"]


def test_write_receipt_ends_the_turn() -> None:
    messages = [
        _user("Write a report"),
        _assistant_call("c1", TOOL_WRITE),
        _receipt("c1"),
    ]
    assert DEMO_REPORT_PATH in _text(mock_responder(_request(messages)))


def test_chain_ends_instead_of_calling_a_tool_the_session_lacks() -> None:
    """A session with no file tool is a configuration, not an error: calling a
    tool that was never mounted fails the turn for an unrelated reason."""
    messages = [
        _user("Write a report"),
        _assistant_call("c1", TOOL_SKILL),
        _user("Activated skill: demo-skill"),
    ]
    without_write = tuple(t for t in ALL_TOOLS if t != TOOL_WRITE)
    assert _text(mock_responder(_request(messages, without_write)))


def test_chain_skips_straight_to_the_write_without_a_skill_tool() -> None:
    messages = [
        _user("Write a report"),
        _assistant_call("c1", TOOL_ASK),
        _receipt("c1", {"question_id": "q1", "answers": {}}),
    ]
    without_skill = tuple(t for t in ALL_TOOLS if t != TOOL_SKILL)
    call = _tool_call(mock_responder(_request(messages, without_skill)))
    assert call.tool_name == TOOL_WRITE


# ---------------------------------------------------------------------------
# Host-injected messages are not the user
# ---------------------------------------------------------------------------


def test_origin_tagged_messages_are_not_the_goal() -> None:
    """A recall is recorded as an `origin="memory"` user message. Counting it
    would make the mock answer the host instead of the human."""
    recall = _user("remember the deploy steps", origin="memory")
    response = mock_responder(_request([recall]))
    # No goal at all: not the memory chain, not the demo question.
    assert _text(response)


def test_legacy_untagged_injections_are_skipped() -> None:
    messages = [
        _user("<workspace-environment>cwd=/tmp</workspace-environment>"),
        _user("Activated skill: demo-skill"),
    ]
    assert _text(mock_responder(_request(messages)))


def test_a_background_notice_wakes_exactly_the_turn_it_arrived_on() -> None:
    notice = _user(
        'Background sub-agent "explorer" finished. Here is its result:\n\nfound 3 '
        'files\n\n<background-subagent id="sub-1" status="completed"/>',
        origin="system",
    )
    woken = [
        _user("run a parallel search"),
        _assistant_call("c1", TOOL_SPAWN),
        _receipt("c1"),
        _assistant_text("Started a background search."),
        notice,
    ]
    assert "background search finished" in _text(mock_responder(_request(woken)))

    # The notice stays in the history forever. A later turn must not answer as
    # if it had just been woken by it.
    later = [
        *woken,
        _assistant_text("The background search finished."),
        _user("now summarise it differently"),
    ]
    assert "background search finished" not in _text(mock_responder(_request(later)))


# ---------------------------------------------------------------------------
# Keyword chains
# ---------------------------------------------------------------------------


def test_memory_chain() -> None:
    goal = "remember that I prefer bullets"
    call = _tool_call(mock_responder(_request([_user(goal)])))
    assert call.tool_name == TOOL_MEMORY_WRITE
    assert call.arguments["name"]

    messages = [
        _user("remember that I prefer bullets"),
        _assistant_call("c1", TOOL_MEMORY_WRITE),
        _receipt("c1"),
    ]
    assert "Remembered" in _text(mock_responder(_request(messages)))


def test_delegation_chain() -> None:
    goal = "do a parallel search of the repo"
    call = _tool_call(mock_responder(_request([_user(goal)])))
    assert call.tool_name == TOOL_SPAWN
    assert call.arguments["background"] is True
    # 0.6.x `Task` is one subagent per call: `{description, prompt,
    # subagent_type}`, not a `spawns` array.
    assert call.arguments["prompt"].startswith(SUBAGENT_GOAL_PREFIX)
    agent = call.arguments["subagent_type"]
    # Against the real roster, not a string literal. An unknown agent name is
    # refused with `SubtaskDenied`, which on the wire looks exactly like a
    # subagent that finished instantly — so the demo would appear to work
    # while delegating nothing at all.
    assert agent in (main_options().agents or {})

    messages = [
        _user("do a parallel search of the repo"),
        _assistant_call("c1", TOOL_SPAWN),
        _receipt("c1"),
    ]
    assert "background" in _text(mock_responder(_request(messages)))


def test_the_spawned_child_searches_then_reports() -> None:
    """The child runs through this same responder; its goal prefix is what
    makes its own history recognisable."""
    goal = f"{SUBAGENT_GOAL_PREFIX} scan the repo"
    call = _tool_call(mock_responder(_request([_user(goal)])))
    assert call.tool_name == TOOL_SHELL

    messages = [_user(goal), _assistant_call("c1", TOOL_SHELL), _receipt("c1")]
    assert "Search complete" in _text(mock_responder(_request(messages)))


def test_a_slow_child_is_paced_and_a_normal_one_is_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The pacing hook is not padding: it is the window that makes a cancel
    cascade observable, because the parent has to be cancellable while a child
    is demonstrably still running."""
    waits: list[float] = []
    monkeypatch.setattr(mock_llm, "sleep", waits.append)

    mock_responder(_request([_user(f"{SUBAGENT_GOAL_PREFIX} slow scan")]))
    assert waits == [SUBAGENT_PACE_SECONDS]

    waits.clear()
    mock_responder(_request([_user(f"{SUBAGENT_GOAL_PREFIX} quick scan")]))
    assert waits == []


def test_consolidation_agent_writes_one_memory() -> None:
    goal = f"{CONSOLIDATION_PREAMBLE}: curate the long-term memory store."
    call = _tool_call(mock_responder(_request([_user(goal)])))
    assert call.tool_name == TOOL_MEMORY_WRITE

    messages = [_user(goal), _assistant_call("c1", TOOL_MEMORY_WRITE), _receipt("c1")]
    assert "Consolidation done" in _text(mock_responder(_request(messages)))


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------


def test_tool_availability_is_read_from_the_function_calling_shape() -> None:
    """The runtime renders `{"type": "function", "function": {"name": …}}`.
    Reading only a top-level `name` sees an empty tool set and silently
    disables every branch that needs one."""
    message = [_user("Write a report")]
    assert _tool_call(mock_responder(_request(message))).tool_name == TOOL_ASK

    # A flat `{"name": …}` list is accepted too, so a differently-shaped
    # caller does not silently lose the whole chain.
    flat = LLMRequest(model="m", messages=message, tools=[{"name": TOOL_ASK}])
    assert _tool_call(mock_responder(flat)).tool_name == TOOL_ASK


def test_no_tools_at_all_still_produces_a_turn() -> None:
    assert _text(mock_responder(_request([_user("Write a report")], tools=())))


@pytest.mark.parametrize(
    "messages",
    [
        pytest.param([], id="empty-history"),
        pytest.param([_user("")], id="empty-text"),
        pytest.param([Message(role="user", content=[])], id="no-blocks"),
        pytest.param([_receipt("orphan")], id="unpaired-receipt"),
        pytest.param([Message(role="assistant", content=[])], id="assistant-only"),
    ],
)
def test_arbitrary_input_never_crashes(messages: list[Message]) -> None:
    response = mock_responder(_request(messages))
    assert response.stop_reason in ("end_turn", "tool_use")


def test_the_default_mock_does_not_stream() -> None:
    """Load-bearing: the mock path emits zero deltas, which is what keeps every
    other test's expected event stream the batch one. The single test that
    needs deltas swaps in `FakeStreamingLLMProvider`."""
    provider = build_mock_provider()
    assert not isinstance(provider, StreamingProvider)
    assert not hasattr(provider, "complete_streaming")


def test_the_provider_routes_through_the_responder() -> None:
    provider = build_mock_provider()
    request = _request([_user("Write a report")])
    assert _tool_call(provider.complete(request)).tool_name == TOOL_ASK
    assert provider.received_requests == [request]
