"""The envelope → UI-event vocabulary, pinned frame by frame.

Every envelope here is a `types.SimpleNamespace`. That is not a convenience:
the translator recognises a ContentRef and a wake condition by their
`__canonical_tag__` rather than by `isinstance`, so the whole vocabulary is
testable without constructing a single engine object — and this file does not
start failing when the engine renames a class.

`deref` is the content-store getter, stubbed here as a hash → bytes map.
"""

from __future__ import annotations

import json
from types import SimpleNamespace as NS

from noeta.agent.host.translator import (
    ERROR_CLIP,
    OUTPUT_CLIP,
    is_question_wake,
    is_subtask_barrier,
    translate,
)

ROOT = "task-root"


def deref_map(mapping: dict[str, bytes]):
    """A content store as a dict, keyed the way `ContentStore.get` keys: hash."""
    return lambda ref: mapping.get(ref.hash)


def no_deref(ref):
    """A deref that must never be called with a real ref."""
    raise AssertionError(f"deref called unexpectedly with {ref!r}")


def env(etype: str, seq: int, *, task_id: str = ROOT, **payload):
    return NS(type=etype, seq=seq, task_id=task_id, payload=NS(**payload))


def ref(hash_: str):
    return NS(__canonical_tag__="content_ref", hash=hash_, size=0, media_type="")


def message(role: str, blocks: list[dict], origin: str | None = None) -> dict:
    body = {"__canonical_tag__": "message", "role": role, "content": blocks}
    if origin is not None:
        body["origin"] = origin
    return body


def text_block(text: str) -> dict:
    return {"__canonical_tag__": "text_block", "text": text}


def messages_env(seq: int, body: list[dict], *, task_id: str = ROOT):
    """A `MessagesAppended` envelope plus the deref that resolves its body."""
    return (
        env("MessagesAppended", seq, task_id=task_id, messages_ref=ref("msg"), count=len(body)),
        deref_map({"msg": json.dumps(body).encode()}),
    )


# ---------------------------------------------------------------------------
# MessagesAppended fan-out
# ---------------------------------------------------------------------------


def test_messages_appended_fans_out_in_order_under_one_seq():
    """One envelope, three frames, one seq.

    The order is the message order, and it is what the conversation renders
    top to bottom. A `role="tool"` message and an `ask_user_question`
    tool_use block are both in the body and both emit nothing: tool receipts
    arrive as `ToolResultRecorded`, questions as `UserQuestionRequested`.
    """
    body = [
        message("user", [text_block("Hello")]),
        message(
            "assistant",
            [
                text_block("Reply"),
                {
                    "__canonical_tag__": "tool_use_block",
                    "tool_name": "skill",
                    "call_id": "c1",
                    "arguments": {"skill": "demo-skill"},
                },
                {
                    "__canonical_tag__": "tool_use_block",
                    "tool_name": "AskUserQuestion",
                    "call_id": "c2",
                    "arguments": {"questions": []},
                },
            ],
        ),
        message(
            "tool",
            [
                {
                    "__canonical_tag__": "tool_result_block",
                    "call_id": "c1",
                    "output": "ok",
                    "success": True,
                }
            ],
        ),
    ]
    envelope, deref = messages_env(7, body)
    events = translate(envelope, deref)

    assert [(e.type, e.seq) for e in events] == [
        ("user_message", 7),
        ("assistant_text", 7),
        ("skill_activated", 7),
    ]
    assert events[1].data == {"text": "Reply", "_task": ROOT}
    assert events[2].data == {"skill": "demo-skill", "_task": ROOT}


def test_text_only_user_message_carries_no_images_key():
    """A text-only turn's data is exactly {content, _task}.

    Not `images: []`. The key's presence is the signal, so a client never has
    to distinguish "no attachments" from "attachments not yet loaded".
    """
    envelope, deref = messages_env(3, [message("user", [text_block("  Hi  ")])])
    (event,) = translate(envelope, deref)
    assert event.data == {"content": "Hi", "_task": ROOT}


def test_user_message_images_carry_hash_and_media_type_only():
    """Image bytes never travel the event stream — the client refetches them."""
    body = [
        message(
            "user",
            [
                text_block("look"),
                {
                    "__canonical_tag__": "image_block",
                    "source": {
                        "__canonical_tag__": "content_ref",
                        "hash": "abc123",
                        "size": 42,
                        "media_type": "image/png",
                    },
                },
                # A malformed source (no hash) is skipped rather than crashing
                # the whole turn's frame.
                {"__canonical_tag__": "image_block", "source": {}},
            ],
        )
    ]
    envelope, deref = messages_env(4, body)
    (event,) = translate(envelope, deref)
    assert event.data == {
        "content": "look",
        "images": [{"hash": "abc123", "media_type": "image/png"}],
        "_task": ROOT,
    }


def test_image_only_user_message_still_emits():
    body = [
        message(
            "user",
            [
                {
                    "__canonical_tag__": "image_block",
                    "source": {"hash": "h", "media_type": "image/jpeg"},
                }
            ],
        )
    ]
    envelope, deref = messages_env(5, body)
    (event,) = translate(envelope, deref)
    assert event.data["content"] == ""
    assert event.data["images"] == [{"hash": "h", "media_type": "image/jpeg"}]


def test_origin_tagged_user_message_emits_nothing():
    """Host-injected content riding the user channel is not a user message.

    Pinned for the background-subagent completion notice, which would
    otherwise appear in the chat as something the user sent.
    """
    body = [
        message(
            "user",
            [text_block('Search finished\n<background-subagent id="s1"/>')],
            origin="system",
        )
    ]
    envelope, deref = messages_env(20, body)
    assert translate(envelope, deref) == []


def test_memory_origin_becomes_a_recall_frame():
    """Auto-recall is the one host-injected message the user gets to see."""
    body = [message("user", [text_block("You prefer terse replies.")], origin="memory")]
    envelope, deref = messages_env(21, body)
    (event,) = translate(envelope, deref)
    assert event.type == "recall"
    assert event.data == {"text": "You prefer terse replies.", "_task": ROOT}


def test_recall_is_clipped_at_the_output_limit():
    long = "m" * (OUTPUT_CLIP + 50)
    body = [message("user", [text_block(long)], origin="memory")]
    envelope, deref = messages_env(22, body)
    (event,) = translate(envelope, deref)
    assert event.data["text"].startswith("m" * OUTPUT_CLIP)
    assert event.data["text"].endswith(
        f"\n… (truncated; {OUTPUT_CLIP + 50} characters total)"
    )


def test_empty_messages_emit_nothing():
    envelope, deref = messages_env(
        23,
        [
            message("user", [text_block("   ")]),
            message("assistant", [text_block("")]),
        ],
    )
    assert translate(envelope, deref) == []


# ---------------------------------------------------------------------------
# Clipping boundaries
# ---------------------------------------------------------------------------


def test_assistant_text_is_never_clipped():
    long = "A" * (OUTPUT_CLIP + 500)
    envelope, deref = messages_env(8, [message("assistant", [text_block(long)])])
    (event,) = translate(envelope, deref)
    assert event.data["text"] == long


def test_thinking_joins_blocks_and_clips_at_2000():
    blocks = [
        {"__canonical_tag__": "thinking_block", "text": "T" * 1500},
        {"__canonical_tag__": "thinking_block", "text": "U" * 1500},
    ]
    events = translate(
        env("AssistantThinkingRecorded", 9, call_id="c1", thinking_ref=ref("th"), block_count=2),
        deref_map({"th": json.dumps(blocks).encode()}),
    )
    (event,) = events
    assert event.type == "thinking"
    # 1500 + "\n" + 1500 = 3001 characters before clipping.
    assert event.data["text"].startswith("T" * 1500)
    assert event.data["text"].endswith("\n… (truncated; 3001 characters total)")
    assert len(event.data["text"]) == OUTPUT_CLIP + len(
        "\n… (truncated; 3001 characters total)"
    )


def test_empty_thinking_emits_nothing():
    events = translate(
        env("AssistantThinkingRecorded", 10, call_id="c1", thinking_ref=ref("th"), block_count=0),
        deref_map({"th": json.dumps([]).encode()}),
    )
    assert events == []


def test_tool_output_is_clipped_at_2000_with_a_total_suffix():
    big = "x" * (OUTPUT_CLIP + 100)
    events = translate(
        env(
            "ToolResultRecorded",
            11,
            call_id="c9",
            success=True,
            output_ref=ref("o1"),
            summary="written",
        ),
        deref_map({"o1": json.dumps(big).encode()}),
    )
    (event,) = events
    assert event.data["success"] is True
    assert event.data["summary"] == "written"
    assert event.data["output"].startswith("x" * OUTPUT_CLIP)
    assert event.data["output"].endswith(
        f"\n… (truncated; {OUTPUT_CLIP + 100} characters total)"
    )


def test_error_is_clipped_at_500():
    boom = "E" * (ERROR_CLIP + 200)
    events = translate(env("TaskFailed", 12, reason=boom, retryable=False), no_deref)
    assert [e.type for e in events] == ["error", "turn_finished"]
    assert events[0].data["message"].startswith("E" * ERROR_CLIP)
    assert events[0].data["message"].endswith(
        f"\n… (truncated; {ERROR_CLIP + 200} characters total)"
    )
    assert events[1].data == {"status": "failed", "_task": ROOT}


# ---------------------------------------------------------------------------
# Tool calls, memory folding, todos
# ---------------------------------------------------------------------------


def test_tool_call_arguments_inline_or_deref():
    inline = translate(
        env(
            "ToolCallStarted",
            13,
            call_id="c1",
            tool_name="write",
            arguments={"path": "a.md"},
            arguments_ref=None,
        ),
        no_deref,
    )
    assert inline[0].type == "tool_call"
    assert inline[0].data == {
        "call_id": "c1",
        "tool_name": "write",
        "arguments": {"path": "a.md"},
        "_task": ROOT,
    }

    offloaded = translate(
        env(
            "ToolCallStarted",
            14,
            call_id="c2",
            tool_name="write",
            arguments=None,
            arguments_ref=ref("args"),
        ),
        deref_map({"args": json.dumps({"path": "big.md"}).encode()}),
    )
    assert offloaded[0].data["arguments"] == {"path": "big.md"}


def test_memory_tools_fold_to_memory_op_with_the_object_as_name():
    """All four ops, each with the argument key its `name` comes from."""
    cases = [
        ("memory_write", {"name": "user-prefs", "text": "# Preferences"}, "write", "user-prefs"),
        ("memory_read", {"name": "user-prefs"}, "read", "user-prefs"),
        ("memory_search", {"query": "rate limiting"}, "search", "rate limiting"),
        ("memory_archive", {"name": "stale-note"}, "archive", "stale-note"),
    ]
    for i, (tool_name, arguments, op, name) in enumerate(cases):
        events = translate(
            env(
                "ToolCallStarted",
                30 + i,
                call_id=f"m{i}",
                tool_name=tool_name,
                arguments=arguments,
                arguments_ref=None,
            ),
            no_deref,
        )
        assert [(e.type, e.data) for e in events] == [
            ("memory_op", {"call_id": f"m{i}", "op": op, "name": name, "_task": ROOT})
        ]


def test_memory_result_still_emits_a_tool_result():
    """The paired result cannot be suppressed and is not pretended otherwise.

    `ToolResultRecordedPayload` carries no tool name, and the translator is
    stateless, so nothing here can know the call folded to `memory_op`. The
    frame goes out and the client drops it as unmatched — the designed
    fallback, pinned so a future reader does not "fix" a suppression that was
    never derivable.
    """
    events = translate(
        env(
            "ToolResultRecorded",
            35,
            call_id="m0",
            success=True,
            output_ref=ref("o"),
            summary="wrote user-prefs",
        ),
        deref_map({"o": json.dumps({"name": "user-prefs", "bytes": 13}).encode()}),
    )
    assert events[0].type == "tool_result"
    assert events[0].data["call_id"] == "m0"


def test_todo_update_only_from_a_set_todos_patch():
    todos = [
        {"id": "1", "content": "Read the docs", "status": "completed"},
        {"id": "2", "content": "Write the report", "status": "in_progress"},
    ]
    events = translate(
        env("TaskStatePatched", 40, patch={"set_goal": None, "set_todos": todos}),
        no_deref,
    )
    assert [(e.type, e.data["todos"]) for e in events] == [("todo_update", todos)]

    # Skill activation and goal setting ride the same envelope type.
    assert (
        translate(
            env("TaskStatePatched", 41, patch={"activate_skills": ["demo-skill"]}),
            no_deref,
        )
        == []
    )
    assert translate(env("TaskStatePatched", 42, patch=None), no_deref) == []


# ---------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------


def test_question_is_deref_d_and_flattened():
    body = {
        "questions": [
            {
                "id": "0",
                "question": "Audience?",
                "header": "Scope",
                "options": [{"label": "Engineer", "description": None}],
                "multiSelect": False,
            }
        ]
    }
    events = translate(
        env(
            "UserQuestionRequested",
            50,
            question_id="q1",
            call_id="c1",
            questions_ref=ref("q"),
            question_count=1,
            reason="needs clarification",
        ),
        deref_map({"q": json.dumps(body).encode()}),
    )
    (event,) = events
    assert event.type == "question"
    assert event.data["question_id"] == "q1"
    assert event.data["reason"] == "needs clarification"
    assert event.data["questions"] == [
        {
            "id": "0",
            "question": "Audience?",
            "header": "Scope",
            "options": [{"label": "Engineer", "description": None}],
            "multiSelect": False,
        }
    ]


def test_question_answered():
    events = translate(
        env(
            "UserQuestionAnswered",
            51,
            question_id="q1",
            call_id="c1",
            answers_ref=ref("a"),
            answer_count=1,
        ),
        no_deref,
    )
    assert events[0].type == "question_answered"
    assert events[0].data == {"question_id": "q1", "_task": ROOT}


def test_question_withdrawn():
    events = translate(
        env(
            "UserQuestionWithdrawn",
            52,
            question_id="q1",
            call_id="c1",
            withdrawn_by="host",
        ),
        no_deref,
    )
    assert events[0].type == "question_withdrawn"
    assert events[0].data == {"question_id": "q1", "_task": ROOT}


# ---------------------------------------------------------------------------
# Subtasks on the parent stream
# ---------------------------------------------------------------------------


def test_both_spawn_shapes_become_one_subtask_started():
    background = translate(
        env(
            "BackgroundSubagentStarted",
            60,
            subtask_id="s1",
            agent_name="explorer",
            goal="find the code",
            call_id="c1",
        ),
        no_deref,
    )
    foreground = translate(
        env("SubtaskSpawned", 61, subtask_id="s2", agent_name="explorer", goal="check config", inputs={}),
        no_deref,
    )
    assert background[0].type == foreground[0].type == "subtask_started"
    assert background[0].data == {
        "subtask_id": "s1",
        "agent_name": "explorer",
        "goal": "find the code",
        "_task": ROOT,
    }
    assert foreground[0].data["subtask_id"] == "s2"


def test_background_subagent_delivered_uses_the_inline_summary():
    events = translate(
        env(
            "BackgroundSubagentDelivered",
            62,
            subtask_id="s1",
            result_ref=ref("r1"),
            summary="found 3 places",
            status="completed",
        ),
        no_deref,
    )
    assert events[0].type == "subtask_finished"
    assert events[0].data == {
        "subtask_id": "s1",
        "status": "completed",
        "summary": "found 3 places",
        "_task": ROOT,
    }


def test_failed_subtask_reports_its_error():
    events = translate(
        env(
            "SubtaskCompleted",
            63,
            subtask_id="s2",
            result=NS(status="failed", output=None, error="boom"),
        ),
        no_deref,
    )
    assert events[0].data["status"] == "failed"
    assert events[0].data["summary"] == "boom"


def test_subtask_completed_output_as_a_content_ref_is_deref_d():
    """Regression: the card once showed the literal `ContentRef(hash=…)`.

    An output above the inline threshold is offloaded, so rendering the ref
    itself puts the reference's repr on screen instead of the subtask's answer.
    """
    events = translate(
        env(
            "SubtaskCompleted",
            64,
            subtask_id="s3",
            result=NS(status="completed", output=ref("out1"), error=None),
        ),
        deref_map({"out1": json.dumps("found 3 tracking designs").encode()}),
    )
    assert events[0].data["status"] == "completed"
    assert events[0].data["summary"] == "found 3 tracking designs"


def test_small_inline_subtask_output_skips_deref():
    events = translate(
        env(
            "SubtaskCompleted",
            65,
            subtask_id="s4",
            result=NS(status="completed", output="inline summary", error=None),
        ),
        no_deref,
    )
    assert events[0].data["summary"] == "inline summary"


def test_subtask_summary_is_never_clipped():
    """A subtask's result is its answer; truncating it loses the conclusion."""
    long = "L" * 1200
    events = translate(
        env(
            "SubtaskCompleted",
            66,
            subtask_id="s5",
            result=NS(status="completed", output=ref("out2"), error=None),
        ),
        deref_map({"out2": json.dumps(long).encode()}),
    )
    assert events[0].data["summary"] == long


# ---------------------------------------------------------------------------
# Compaction
# ---------------------------------------------------------------------------


def test_compacted_forwards_the_replaced_count():
    events = translate(
        env(
            "Compacted",
            744,
            summary_ref=ref("s"),
            boundary_count=103,
            replaced_count=103,
            composer_version="three_segment.v5",
        ),
        no_deref,
    )
    assert [(e.type, e.seq) for e in events] == [("compaction", 744)]
    assert events[0].data == {"replaced_count": 103, "_task": ROOT}


def test_compacted_without_a_count_defaults_to_zero():
    events = translate(env("Compacted", 745, summary_ref=ref("s")), no_deref)
    assert events[0].data["replaced_count"] == 0


def test_compaction_requested_is_never_forwarded():
    """One frame when compaction lands, none when it is merely asked for."""
    assert (
        translate(
            env("CompactionRequested", 743, reason="proactive", estimated_tokens=37484),
            no_deref,
        )
        == []
    )


def test_a_subtask_compaction_never_reaches_the_parent_conversation():
    """Compaction cards pair per task stream, never by adjacency.

    A subagent's `Compacted` emits nothing at all here, so it can never be
    paired with the root stream's `CompactionRequested` downstream — the wire
    makes the mis-pairing unrepresentable rather than relying on a consumer
    to keep two streams apart.
    """
    assert (
        translate(
            env("Compacted", 9, summary_ref=ref("s"), replaced_count=4),
            no_deref,
            subtask_id="s1",
        )
        == []
    )


# ---------------------------------------------------------------------------
# Lifecycle and the turn_finished triage
# ---------------------------------------------------------------------------


def test_started_and_woken_both_open_a_turn():
    started = translate(env("TaskStarted", 70, lease_id="l"), no_deref)
    woken = translate(env("TaskWoken", 71, wake_event=None), no_deref)
    assert [(e.type, e.data) for e in started] == [("turn_started", {"_task": ROOT})]
    assert [(e.type, e.data) for e in woken] == [("turn_started", {"_task": ROOT})]


def test_terminal_envelopes_map_to_their_statuses():
    cancelled = translate(env("TaskCancelled", 72, reason="user", cascade=False), no_deref)
    assert [(e.type, e.data["status"]) for e in cancelled] == [
        ("turn_finished", "cancelled")
    ]

    completed = translate(env("TaskCompleted", 73, answer="done", answer_ref=None), no_deref)
    assert [(e.type, e.data["status"]) for e in completed] == [
        ("turn_finished", "completed")
    ]

    failed = translate(env("TaskFailed", 74, reason="boom", retryable=False), no_deref)
    assert [e.type for e in failed] == ["error", "turn_finished"]
    assert failed[0].data["message"] == "boom"
    assert failed[1].data["status"] == "failed"
    # Both frames come off the same envelope and share its seq, so a
    # reconnect cursor can never land between them.
    assert failed[0].seq == failed[1].seq == 74


def suspend(seq: int, reason: str, wake_on):
    return env("TaskSuspended", seq, reason=reason, wake_on=wake_on)


def test_suspend_on_a_question_emits_nothing():
    """The `question` frame already expresses this resting state."""
    assert translate(suspend(80, "waiting_human", NS(handle="question-c1")), no_deref) == []


def test_suspend_on_the_next_goal_handle_parks_the_turn():
    events = translate(
        suspend(81, "waiting_human", NS(handle="noeta-code-next-goal")), no_deref
    )
    assert [(e.type, e.data) for e in events] == [
        ("turn_finished", {"status": "awaiting_input", "_task": ROOT})
    ]


def test_suspend_on_a_subtask_barrier_emits_nothing():
    """The root is parked mid-fan-out: the turn is not over."""
    group = translate(
        suspend(
            82,
            "waiting_subtask_group",
            NS(
                __canonical_tag__="subtask_group_completed",
                group_id="g-1",
                subtask_ids=("s1", "s2"),
                concurrent=True,
            ),
        ),
        no_deref,
    )
    single = translate(
        suspend(
            83,
            "waiting_subtask",
            NS(__canonical_tag__="subtask_completed", subtask_id="s1", result=None),
        ),
        no_deref,
    )
    assert group == [] and single == []


def test_interrupt_suspend_is_its_own_status():
    events = translate(suspend(84, "interrupted", NS(handle="noeta-code-next-goal")), no_deref)
    assert [(e.type, e.data) for e in events] == [
        ("turn_finished", {"status": "interrupted", "_task": ROOT})
    ]


def test_turn_failed_carries_the_parsed_detail_as_reason():
    """`turn_failed` is resumable; `failed` is not. The detail is the why."""
    events = translate(
        suspend(85, "turn_failed: provider returned 503", NS(handle="noeta-code-next-goal")),
        no_deref,
    )
    assert [(e.type, e.data) for e in events] == [
        (
            "turn_finished",
            {"status": "turn_failed", "reason": "provider returned 503", "_task": ROOT},
        )
    ]


def test_turn_failed_without_a_detail_omits_the_reason_key():
    events = translate(suspend(86, "turn_failed", NS(handle="h")), no_deref)
    assert [(e.type, e.data) for e in events] == [
        ("turn_finished", {"status": "turn_failed", "_task": ROOT})
    ]


def test_an_unknown_suspend_kind_parks_rather_than_fails():
    """The suspend tag is a legibility field a new producer may extend.

    Treating an unrecognised one as an error would turn a forward-compatible
    engine change into a broken conversation.
    """
    for reason in ("waiting_timer", "waiting_external", "some_future_tag: detail", ""):
        events = translate(suspend(87, reason, NS(handle="h")), no_deref)
        assert [(e.type, e.data["status"]) for e in events] == [
            ("turn_finished", "awaiting_input")
        ], reason


def test_a_suspend_with_no_reason_attribute_still_parks():
    """`parse_suspend_reason` raises on `None`; the tag is never trusted raw."""
    events = translate(env("TaskSuspended", 88, wake_on=NS(handle="h")), no_deref)
    assert events[0].data["status"] == "awaiting_input"


def test_the_barrier_and_question_predicates_are_exported():
    """The status machine must branch on the same predicates as the wire.

    Two copies of "is this a subtask barrier" eventually disagree, and the
    session then reports idle while a fan-out is still running.
    """
    barrier = NS(__canonical_tag__="subtask_group_completed", group_id="g")
    question = NS(__canonical_tag__="human_response", handle="question-c1")
    next_goal = NS(__canonical_tag__="human_response", handle="noeta-code-next-goal")

    assert is_subtask_barrier(barrier) is True
    assert is_subtask_barrier(question) is False
    assert is_subtask_barrier(None) is False
    assert is_question_wake(question) is True
    assert is_question_wake(next_goal) is False
    assert is_question_wake(barrier) is False


# ---------------------------------------------------------------------------
# Subtask streams
# ---------------------------------------------------------------------------


def test_subtask_tool_frames_carry_the_subtask_id_and_no_seq():
    """A subtask counts seq independently of its parent.

    Carrying it would collide with the parent stream's dedup cursor and
    silently swallow root events — invisible, and permanent.
    """
    call = translate(
        env(
            "ToolCallStarted",
            5,
            task_id="task-sub",
            call_id="c1",
            tool_name="glob",
            arguments={"pattern": "**/*.md"},
            arguments_ref=None,
        ),
        no_deref,
        subtask_id="s1",
    )
    assert call[0].type == "tool_call"
    assert call[0].seq is None
    assert call[0].data["subtask_id"] == "s1"
    assert call[0].data["tool_name"] == "glob"

    result = translate(
        env(
            "ToolResultRecorded",
            6,
            task_id="task-sub",
            call_id="c1",
            success=True,
            output_ref=None,
            summary="2 matches",
        ),
        no_deref,
        subtask_id="s1",
    )
    assert result[0].type == "tool_result"
    assert result[0].seq is None
    assert result[0].data["subtask_id"] == "s1"
    assert result[0].data["output"] == ""


def test_subtask_cancel_is_wrapped_up_locally():
    """On a cancel cascade no delivery event ever reaches the parent.

    Without this branch the subtask card stays "running" forever.
    """
    events = translate(
        env("TaskCancelled", 7, task_id="task-sub", reason="user", cascade=True),
        no_deref,
        subtask_id="s1",
    )
    assert events[0].type == "subtask_finished"
    assert events[0].data == {"subtask_id": "s1", "status": "cancelled", "summary": ""}


def test_subtask_streams_forward_nothing_else():
    """Lifecycle and messages inside a subtask are not the session's turn."""
    for envelope in (
        env("TaskStarted", 1, task_id="task-sub", lease_id="l"),
        env("TaskCompleted", 2, task_id="task-sub", answer=None, answer_ref=None),
        env("TaskFailed", 3, task_id="task-sub", reason="boom", retryable=False),
        env("TaskSuspended", 4, task_id="task-sub", reason="waiting_human", wake_on=NS(handle="h")),
        env("MessagesAppended", 5, task_id="task-sub", messages_ref=ref("m"), count=1),
        env("AssistantThinkingRecorded", 6, task_id="task-sub", call_id="c", thinking_ref=ref("t"), block_count=1),
        env("SubtaskSpawned", 7, task_id="task-sub", subtask_id="s2", agent_name="a", goal="g", inputs={}),
        env("LLMRetryScheduled", 8, task_id="task-sub", call_id="c", attempt=1, max_retries=3, delay_seconds=1.0, category="rate_limit"),
    ):
        assert translate(envelope, no_deref, subtask_id="s1") == [], envelope.type


def test_subtask_frames_omit_task_so_they_reach_every_branch_filter():
    """A subtask's own task id is a stream no client filters on.

    Stamping it would make `?task_id=<root>` hide every subtask card; the
    caller fills in the parent stream's id instead.
    """
    events = translate(
        env(
            "ToolCallStarted",
            5,
            task_id="task-sub",
            call_id="c1",
            tool_name="glob",
            arguments={},
            arguments_ref=None,
        ),
        no_deref,
        subtask_id="s1",
    )
    assert "_task" not in events[0].data


# ---------------------------------------------------------------------------
# The boundary of the vocabulary
# ---------------------------------------------------------------------------


def test_out_of_vocabulary_envelopes_return_empty():
    """The never-forwarded list is the contract's boundary.

    Anything the translator does not name is silently outside the wire, so a
    new engine event type cannot leak into the conversation by default.
    """
    never_forwarded = [
        env("TaskCreated", 1, goal="g", policy_name="p"),
        env("TaskHostBound", 2, host_id="h"),
        env("AgentBound", 3, agent_name="a"),
        env("ModelBound", 4, selector="m"),
        env("TaskSnapshot", 5, state_ref=ref("s")),
        env("TaskForked", 7, source_task_id="t", source_seq=3, state_ref=ref("s")),
        env("TurnInterrupted", 8, reason=None, interrupted_by="user"),
        env("StepTransitionMarked", 9, reason="r", attempt=0),
        env("StepAttemptAbandoned", 10, reason="r"),
        env("LLMRequestStarted", 11, call_id="c", model="m"),
        env("LLMRequestFinished", 12, call_id="c", success=True),
        env("LLMResponseRecorded", 13, call_id="c", response_ref=ref("r"), stop_reason="end_turn"),
        env("ContextPlanComposed", 14, plan_ref=ref("p")),
        env("ContextContentRecorded", 15, kind="skill", content_ref=ref("c")),
        env("ToolCallFinished", 16, call_id="c"),
        env("ToolCallDenied", 17, call_id="c", tool_name="t", reason="no"),
        env("ToolCallApprovalRequested", 18, call_id="c", tool_name="t", arguments={}),
        env("SomeEventTypeInventedNextYear", 19, whatever=True),
    ]
    for envelope in never_forwarded:
        assert translate(envelope, no_deref) == [], envelope.type


def test_task_rewound_forwards_the_target_seq():
    """`TaskRewound` is vocabulary now (undo last turn): it forwards a `rewind`
    frame carrying `target_seq` — the boundary the client truncates to. The
    server-only `state_ref` never crosses the wire.

    `TaskForked` stays out of the vocabulary next door: fork's inherited history
    rides a separate replay path, not this marker."""
    events = translate(
        env("TaskRewound", 6, target_seq=3, state_ref=ref("s")),
        no_deref,
    )
    assert [(e.type, e.seq) for e in events] == [("rewind", 6)]
    assert events[0].data == {"target_seq": 3, "_task": ROOT}


# ---------------------------------------------------------------------------
# The properties, not the frames
# ---------------------------------------------------------------------------


def test_every_root_frame_carries_the_stream_it_belongs_to():
    """`_task` is what the SSE endpoint's branch filter reads.

    A fork appends a sibling task stream to the same session, so a frame with
    no stream identity would show up in both branches.
    """
    envelope, deref = messages_env(
        90,
        [
            message("user", [text_block("hi")]),
            message("assistant", [text_block("hello")]),
        ],
        task_id="task-branch-2",
    )
    events = translate(envelope, deref)
    assert len(events) == 2
    assert all(e.data["_task"] == "task-branch-2" for e in events)


def test_translation_is_deterministic():
    """Same envelope in, same frames out — the premise replay rests on."""
    envelope, deref = messages_env(91, [message("user", [text_block("hi")])])
    first = translate(envelope, deref)
    second = translate(envelope, deref)
    assert [(e.seq, e.type, e.data) for e in first] == [
        (e.seq, e.type, e.data) for e in second
    ]


def test_a_ui_event_reads_as_an_object_and_as_a_mapping():
    (event,) = translate(env("TaskCompleted", 92, answer=None, answer_ref=None), no_deref)
    assert event.seq == event["seq"] == 92
    assert event.type == event["type"] == "turn_finished"
    assert event.data is event["data"]


def test_an_unreadable_content_body_costs_one_frame_not_the_turn():
    """A missing or non-JSON body degrades, it does not raise."""
    missing = translate(
        env("MessagesAppended", 93, messages_ref=ref("gone"), count=1), deref_map({})
    )
    assert missing == []

    binary = translate(
        env(
            "ToolResultRecorded",
            94,
            call_id="c1",
            success=False,
            output_ref=ref("bin"),
            summary="raw bytes",
        ),
        deref_map({"bin": b"\xff\xfe not json"}),
    )
    assert binary[0].type == "tool_result"
    assert "not json" in binary[0].data["output"]


# ---------------------------------------------------------------------------
# `ts` — the optional server clock (wire contract §2.7)
# ---------------------------------------------------------------------------


def test_a_durable_frame_carries_the_envelopes_clock_as_ts():
    """The fold label "Worked for 1m 35s" is re-derived, not stopwatch-measured.

    A duration is the one thing on the screen a reload cannot recompute from
    the log without a server clock, so every durable frame carries the
    envelope's `occurred_at`."""
    envelope = env("TaskStarted", 95)
    envelope.occurred_at = 1769812345.5
    (event,) = translate(envelope, no_deref)
    assert event.data["ts"] == 1769812345.5


def test_ts_is_optional_and_absent_when_the_envelope_has_no_clock():
    """Optional by contract: a consumer that does not find it must degrade,
    never fail — so an envelope with no clock produces no key at all rather
    than a zero that reads as 1970."""
    (event,) = translate(env("TaskStarted", 96), no_deref)
    assert "ts" not in event.data


def test_a_subtask_frame_carries_no_ts():
    """A subtask frame is synthetic — no envelope of the parent stream produced
    it — and `ts` is meaningless on one."""
    envelope = env("ToolCallStarted", 97, call_id="c1", tool_name="read", arguments={})
    envelope.occurred_at = 1769812345.5
    (event,) = translate(envelope, no_deref, subtask_id="sub-1")
    assert event.seq is None
    assert "ts" not in event.data
