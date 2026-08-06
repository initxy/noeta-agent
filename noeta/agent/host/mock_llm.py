"""The offline model: a deterministic responder that routes on conversation
content.

This is a **feature**, not a test fixture. It is what makes
`python -m noeta.agent` boot with no `.env`, no Docker and no credentials and
still be a usable product — and, as a side effect, what lets the whole suite
run without a network.

Two design rules carry the weight:

- **Content routing, never a positional cursor.** The responder reads the
  request's message history and decides from it, with an `end_turn` fallback,
  so arbitrary input cannot crash a turn and no test breaks because a script
  drifted a step out of alignment.
- **Host-injected messages are not the user.** Reminders, recalls and
  background notices arrive as `role="user"` messages with an `origin`; a
  responder that counted them would answer the host instead of the human. The
  woken-turn detection scans backwards over *only* the trailing origin-tagged
  messages and stops at the first real one, so exactly the turn a notice woke
  matches and later turns do not re-trigger.

Every branch that emits a tool call first checks the tool is actually offered
in `request.tools`. A mock that calls a tool the session never mounted fails
the turn for a reason that has nothing to do with what was being tested.

The trigger table, all matched against the message history:

- **any first message** — the demo chain: `AskUserQuestion` (options and
  freeform) → `skill` → `Write` → `end_turn`. One chain exercising questions,
  answers, skills, tools, files and turn boundaries.
- **goal contains `remember`** — `memory_write` → `end_turn`.
- **goal contains `parallel search`** — `Task(background=True)`;
  the child's result notice wakes the parent → `end_turn`.
- **goal starts with `search:`** (the spawned child, running through this same
  responder) — `Bash` → `end_turn`. A goal containing `slow` paces every
  one of its responses.
- **goal starts with `Memory consolidation run`** (the SDK's preamble) —
  `memory_write` → `end_turn`.
- **anything else** — `end_turn` echoing the last user message.

`build_mock_provider()` deliberately returns a provider that does **not**
implement `StreamingProvider`, so the mock path emits zero deltas and every
other test's expected event stream stays stable. The one test that needs
deltas swaps in `FakeStreamingLLMProvider` from `noeta.sdk.testing`.
"""
from __future__ import annotations

import uuid
from time import sleep
from typing import Any, Optional

from noeta.sdk import (
    LLMRequest,
    LLMResponse,
    Message,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
)
from noeta.sdk.testing import FakeLLMProvider

# Tool names as the runtime registers them (Claude Code alignment, 0.6.x).
# Wrong names here do not fail loudly — the branch is simply skipped by the
# availability guard — so they are named once, at the top.
TOOL_ASK = "AskUserQuestion"
TOOL_SKILL = "skill"
TOOL_WRITE = "Write"
TOOL_SHELL = "Bash"
TOOL_MEMORY_WRITE = "memory_write"
TOOL_SPAWN = "Task"

#: Goal keywords that pick a chain other than the demo one.
MEMORY_TRIGGER = "remember"
DELEGATION_TRIGGER = "parallel search"

#: The agent the delegation demo spawns. It MUST be one of `main_options()`'s
#: spawnable roster (`general-purpose` / `explore` / `plan`) — an unknown name
#: is refused with `SubtaskDenied`, which on the wire is indistinguishable from
#: a subagent that finished instantly, so the demo would look like it worked.
SUBAGENT_NAME = "explore"

#: The goal prefix `Task` is given below, and the marker that makes
#: the child slow. Kept as one prefix so the child's own turns are recognisable
#: from its history alone — a subagent runs through this same responder.
SUBAGENT_GOAL_PREFIX = "search:"
SUBAGENT_SLOW_MARKER = "slow"

#: The SDK's consolidation goal preamble (`noeta.sdk.run_consolidation`).
CONSOLIDATION_PREAMBLE = "Memory consolidation run"

#: Seconds a "slow" subagent waits before each response. This is not padding:
#: it is the timing window that makes a cancel-cascade observable at all — the
#: parent has to be cancellable while a child is demonstrably still running.
SUBAGENT_PACE_SECONDS = 1.0

#: The demo chain's artifact. Relative to the workspace root, so it lands in
#: the project directory whichever execution tier is serving the session.
DEMO_REPORT_PATH = "report.md"


# ---------------------------------------------------------------------------
# Reading the request
# ---------------------------------------------------------------------------


def _text_of(message: Message) -> str:
    return "\n".join(
        block.text for block in (message.content or []) if isinstance(block, TextBlock)
    ).strip()


def _user_texts(messages: list[Message]) -> list[str]:
    """What the human actually said, in order.

    Excluded: `origin`-tagged messages (recalls, reminders, background
    notices — everything the host injects), and the legacy untagged
    injections that predate `origin` (a leading `<…>` tag block, an
    `Activated skill:` preamble). Both exclusions are what keeps the goal
    stable as the runtime adds new injections around it.
    """
    out: list[str] = []
    for message in messages:
        if message.role != "user" or message.origin:
            continue
        text = _text_of(message)
        if (
            not text
            or text.lstrip().startswith("<")
            or text.startswith("Activated skill:")
        ):
            continue
        out.append(text)
    return out


def _background_notice(messages: list[Message]) -> str:
    """The background-subagent notice, if this turn is the one it woke.

    Scans backwards over the trailing run of origin-tagged user messages and
    stops at the first real message. That bound is the whole point: the notice
    stays in the history forever, so a plain "is it anywhere in the messages"
    check would make every later turn answer as if it had just been woken.
    """
    for message in reversed(messages):
        if message.role == "user" and message.origin:
            text = _text_of(message)
            if "<background-subagent" in text:
                return text
            continue
        break
    return ""


def _tool_uses(messages: list[Message]) -> dict[str, str]:
    """`call_id` → tool name, over every assistant message."""
    index: dict[str, str] = {}
    for message in messages:
        if message.role != "assistant":
            continue
        for block in message.content or []:
            if isinstance(block, ToolUseBlock):
                index[block.call_id] = block.tool_name
    return index


def _has_tool_use(messages: list[Message], tool_name: str) -> bool:
    return tool_name in _tool_uses(messages).values()


def _last_tool_result(messages: list[Message]) -> Optional[ToolResultBlock]:
    """The tool receipt this turn is answering, or `None`.

    The composer appends `origin`-tagged reminders after the receipt, so the
    scan skips those before judging whether the conversation is really sitting
    on a tool result.
    """
    for message in reversed(messages):
        if message.role == "user" and message.origin:
            continue
        if message.role != "tool":
            return None
        for block in message.content or []:
            if isinstance(block, ToolResultBlock):
                return block
        return None
    return None


def _tool_names(request: LLMRequest) -> set[str]:
    """Every tool this request actually offers.

    The runtime renders schemas in the provider's function-calling shape,
    `{"type": "function", "function": {"name": …}}`. Reading only a top-level
    `name` silently sees an empty tool set and disables every branch that
    depends on one, so both spellings are accepted.
    """
    names: set[str] = set()
    for entry in request.tools or []:
        if not isinstance(entry, dict):
            continue
        function = entry.get("function")
        name = function.get("name") if isinstance(function, dict) else entry.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _answer_summary(messages: list[Message]) -> str:
    """The user's answer to the demo question, for the report body.

    The answered-question receipt is `{question_id, answers}`, where each
    answer is `{"selected": [labels...], "other": text}` (0.6.x reference
    shape). The report just wants something human — the chosen labels, or the
    freeform text when the user picked "Other"."""
    for message in messages:
        if message.role != "tool":
            continue
        for block in message.content or []:
            if not isinstance(block, ToolResultBlock):
                continue
            if not isinstance(block.output, dict):
                continue
            answers = block.output.get("answers")
            if isinstance(answers, dict):
                parts: list[str] = []
                for answer in answers.values():
                    if not isinstance(answer, dict):
                        continue
                    selected = answer.get("selected")
                    if isinstance(selected, list):
                        parts.extend(str(label) for label in selected if label)
                    other = answer.get("other")
                    if isinstance(other, str) and other:
                        parts.append(other)
                return ", ".join(part for part in parts if part)
    return ""


# ---------------------------------------------------------------------------
# Writing the response
# ---------------------------------------------------------------------------


def _call_id() -> str:
    return f"mock-{uuid.uuid4().hex[:8]}"


def _tool_use(tool_name: str, arguments: dict[str, Any]) -> LLMResponse:
    return LLMResponse(
        stop_reason="tool_use",
        content=[
            ToolUseBlock(call_id=_call_id(), tool_name=tool_name, arguments=arguments)
        ],
        usage=Usage(uncached=1, output=1),
    )


def _end_turn(text: str) -> LLMResponse:
    return LLMResponse(
        stop_reason="end_turn",
        content=[TextBlock(text=text)],
        usage=Usage(uncached=1, output=1),
    )


def _report_markdown(goal: str, audience: str) -> str:
    return (
        "\n".join(
            [
                "# Structured report (mock demo)",
                "",
                f"> Request: {goal[:120]}",
                f"> Audience: {audience or 'unspecified'}",
                "",
                "## Background",
                "Generated offline by the mock model, so the whole pipeline can be "
                "exercised without a gateway.",
                "",
                "## Key points",
                "1. Skill activation works.",
                "2. The clarifying-question round trip completed.",
                "3. The workspace file write succeeded.",
                "",
                "## Conclusion",
                "End-to-end verification passed.",
            ]
        )
        + "\n"
    )


def _write_or_finish(
    request: LLMRequest, messages: list[Message], goal: str
) -> LLMResponse:
    """The demo chain's last step: write the report, or end the turn saying
    why it could not. A session with no file tool is a legitimate
    configuration, not an error to surface as a failed turn."""
    if TOOL_WRITE not in _tool_names(request):
        return _end_turn(
            "(mock) No file tool is available in this session, so I skipped the "
            "report file. The skill activation and the clarifying-question round "
            "trip both completed."
        )
    return _tool_use(
        TOOL_WRITE,
        {
            "file_path": DEMO_REPORT_PATH,
            "content": _report_markdown(goal, _answer_summary(messages)),
        },
    )


# ---------------------------------------------------------------------------
# The responder
# ---------------------------------------------------------------------------


def mock_responder(request: LLMRequest) -> LLMResponse:
    """One LLM round trip, decided entirely from the request."""
    messages = list(request.messages or [])
    users = _user_texts(messages)
    goal = users[0] if users else ""
    available = _tool_names(request)
    tool_uses = _tool_uses(messages)
    receipt = _last_tool_result(messages)

    # --- the consolidation agent (goal starts with the SDK's preamble) -----
    if goal.startswith(CONSOLIDATION_PREAMBLE):
        if receipt is not None:
            return _end_turn(
                "Consolidation done (mock): merged the recurring preferences from "
                "recent sessions into one memory."
            )
        if TOOL_MEMORY_WRITE in available:
            return _tool_use(
                TOOL_MEMORY_WRITE,
                {
                    "name": "consolidated-note",
                    "text": "Recent sessions show the user prefers concise replies "
                    "(merged by consolidation).",
                    "description": "user preference merged by the mock consolidation",
                    "type": "user",
                },
            )
        return _end_turn("Consolidation done (mock): nothing to merge.")

    # --- the delegated child (its goal is the prefix the spawn below gave) --
    if goal.startswith(SUBAGENT_GOAL_PREFIX):
        if SUBAGENT_SLOW_MARKER in goal:
            # Before the branch decides anything, so *every* response of this
            # child is paced — a cancel arriving mid-chain still finds it busy.
            sleep(SUBAGENT_PACE_SECONDS)
        if receipt is not None:
            return _end_turn(
                "Search complete (mock): scanned the workspace; the relevant "
                "material is concentrated under the project source tree."
            )
        if TOOL_SHELL in available:
            return _tool_use(TOOL_SHELL, {"command": "find . -name '*.md' -type f"})
        return _end_turn("Search complete (mock): no shell available to search with.")

    # --- answering a tool receipt ------------------------------------------
    if receipt is not None:
        # The answered-question receipt is `{question_id, answers}`; it is
        # matched on shape because the question tool is a control tool and its
        # call never appears in the tool-use index.
        if isinstance(receipt.output, dict) and "question_id" in receipt.output:
            if TOOL_SKILL in available:
                return _tool_use(TOOL_SKILL, {"skill": "demo-skill"})
            return _write_or_finish(request, messages, goal)

        previous = tool_uses.get(receipt.call_id, "")
        if previous == TOOL_MEMORY_WRITE:
            return _end_turn(
                "Remembered (mock): this preference will apply in later sessions."
            )
        if previous == TOOL_SPAWN:
            return _end_turn(
                "Started a background search; I will summarise once its results "
                "arrive."
            )
        if previous == TOOL_WRITE:
            return _end_turn(
                f"The report is written to `{DEMO_REPORT_PATH}` in the workspace. "
                "Open it in the file panel; tell me if the structure needs "
                "adjusting."
            )
        return _end_turn("(mock) Tool result processed.")

    # --- continuing after a skill activation --------------------------------
    # `skill` is a CONTROL tool: activating one appends an `Activated skill:`
    # user message and produces no tool receipt, so the demo chain cannot
    # resume from the receipt branch above the way `write` does. Without this,
    # a workspace that actually has a skill loses the file-write step — the
    # chain would run question → skill → generic echo, and the one config
    # where skill activation is observable is the one where the artifact is
    # not. Guarded on the write not having happened, or it would loop.
    if _has_tool_use(messages, TOOL_SKILL) and not _has_tool_use(
        messages, TOOL_WRITE
    ):
        return _write_or_finish(request, messages, goal)

    # --- answering a user (or host-injected) message ------------------------
    if _background_notice(messages):
        return _end_turn(
            "The background search finished; its conclusions are folded into this "
            "reply (mock demo)."
        )
    if (
        MEMORY_TRIGGER in goal
        and TOOL_MEMORY_WRITE in available
        and not _has_tool_use(messages, TOOL_MEMORY_WRITE)
    ):
        return _tool_use(
            TOOL_MEMORY_WRITE,
            {
                "name": "user-preference-demo",
                "text": f"User asked to remember: {goal[:120]}",
                "description": "user preference written by the mock demo",
                "type": "user",
            },
        )
    if (
        DELEGATION_TRIGGER in goal
        and TOOL_SPAWN in available
        and not _has_tool_use(messages, TOOL_SPAWN)
    ):
        return _tool_use(
            TOOL_SPAWN,
            {
                "description": "scout the workspace",
                "subagent_type": SUBAGENT_NAME,
                "prompt": f"{SUBAGENT_GOAL_PREFIX} {goal[:60]}",
                "background": True,
            },
        )
    if (
        len(users) == 1
        and TOOL_ASK in available
        and not _has_tool_use(messages, TOOL_ASK)
    ):
        return _tool_use(
            TOOL_ASK,
            {
                "questions": [
                    {
                        "question": "Who is the primary audience for this report?",
                        # Chip label, max 12 chars.
                        "header": "Audience",
                        "options": [
                            {
                                "label": "Engineer",
                                "description": "prefers technical detail",
                            },
                            {
                                "label": "Product manager",
                                "description": "prefers conclusions and impact",
                            },
                        ],
                        # An "Other" free-text option is always added
                        # automatically, so the freeform path stays exercised.
                        "multiSelect": False,
                    }
                ],
            },
        )
    if users:
        return _end_turn(
            f'(mock) Received your message: "{users[-1][:80]}". A real model would '
            "continue from the context here."
        )
    return _end_turn("(mock) Hello, I am noeta-agent.")


def build_mock_provider() -> FakeLLMProvider:
    """The offline provider.

    `FakeLLMProvider` implements `complete` only — no `complete_streaming` —
    which is load-bearing: the mock path emits no deltas, so every test's
    expected event stream is the batch one.
    """
    return FakeLLMProvider(responder=mock_responder)
