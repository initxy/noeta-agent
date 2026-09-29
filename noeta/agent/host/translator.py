"""EventEnvelope → the flat UI-event vocabulary, as one pure function.

`translate` is the single implementation of the product wire (the **UI event**
term in `CONTEXT.md`). Live streaming and replay both call it, over the same
envelopes, in the same order — which is what makes "replay is re-derivation"
true rather than aspirational: there is no stored UI-event projection to drift
from the log, nothing to migrate, and no second fold to keep in sync.

Three properties are load-bearing, and each has a cost attached to breaking it:

- **No engine type is imported.** A `ContentRef` and a wake condition are
  recognised by their `__canonical_tag__`, never by `isinstance`. That is what
  lets the whole vocabulary be unit-tested with `types.SimpleNamespace`, and
  what keeps this module's test surface off the engine's release cadence.
  The `SUSPEND_REASON_*` constants and `parse_suspend_reason` below are
  strings and a string parser, not types — importing them is how the
  `"<kind>: <detail>"` suspend-tag convention stays defined in exactly one
  place instead of being substring-matched here.
- **Pure, total, deterministic.** No clock, no state, no I/O beyond `deref`.
  The same envelope yields the same frames forever, so a reconnect that
  re-reads the log cannot produce a different conversation.
- **A frame that cannot be derived from the log must be synthetic** (`seq
  is None`) and therefore will not survive a refresh. That is a deliberate
  per-frame choice made here, never a discovery made later.

An unknown envelope type yields `[]`, and an unknown suspend kind parks the
turn rather than failing it — the ledger's suspend tag is documented as a
legibility field that a new producer may extend without a protocol bump.

`deref` is the `ContentRef -> bytes | None` content-store getter. Deref'd
bodies are canonical JSON, so they arrive here as plain dicts and lists and
are read as such; only values carried *inline* on a payload (a wake
condition, a subtask result's output) are objects read by attribute.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Optional

from noeta.sdk import (
    SUSPEND_REASON_INTERRUPTED,
    SUSPEND_REASON_TURN_FAILED,
    parse_suspend_reason,
)

#: Character cap for the bulky machine-written bodies — tool output and model
#: thinking. Deliberately *not* applied to assistant text or to a subtask's
#: summary: those are the answer itself, and clipping them drops the
#: conclusion the user came for.
OUTPUT_CLIP = 2000

#: Character cap for an error message. Tighter than `OUTPUT_CLIP` because an
#: error renders inline in the conversation; the full traceback belongs to the
#: raw-event trace surface.
ERROR_CLIP = 500

#: Wake-condition tags that mean "the root task parked on a subtask barrier".
#: Read as a tag rather than by probing for a `handle` field, because that
#: absence is exactly what distinguishes a barrier from a human-response wake.
_SUBTASK_BARRIER_TAGS = frozenset({"subtask_group_completed", "subtask_completed"})

#: `HumanResponseReceived.handle` prefix minted for a pending question.
_QUESTION_WAKE_PREFIX = "question-"

#: Memory is four ordinary tools in the engine; the conversation shows one
#: semantic marker instead of four generic tool cards.
_MEMORY_TOOL_OPS = {
    "memory_write": "write",
    "memory_read": "read",
    "memory_search": "search",
    "memory_archive": "archive",
}

DerefFn = Callable[[Any], Optional[bytes]]


@dataclass(slots=True)
class UIEvent:
    """One frame of the product wire.

    `seq is None` marks a synthetic frame: it is not derivable from the event
    log, carries no SSE `id:` line, and does not survive a reconnect.

    Field access and item access both work. The wire contract writes a frame
    as an object literal in one place and as `ev.seq` in another, and the
    consumers of this module are written in parallel with it; supporting both
    spellings costs three lines and removes an integration guess.
    """

    seq: Optional[int]
    type: str
    data: dict[str, Any]

    def __getitem__(self, key: str) -> Any:
        return {"seq": self.seq, "type": self.type, "data": self.data}[key]


# ---------------------------------------------------------------------------
# Structural helpers — no engine type crosses this line
# ---------------------------------------------------------------------------


def _canonical_tag(value: Any) -> str:
    """The `__canonical_tag__` of a tagged value, or `""`.

    Every value the engine round-trips through the ContentStore declares one,
    on the class for a live object and as a plain key once it has been encoded
    to canonical JSON. Reading it structurally is what keeps this module free
    of engine imports.
    """
    if isinstance(value, dict):
        return str(value.get("__canonical_tag__") or "")
    return str(getattr(value, "__canonical_tag__", "") or "")


def is_subtask_barrier(wake_on: Any) -> bool:
    """Whether a `TaskSuspended` parked the root on a wait-for-subtasks barrier.

    Exported because the status machine needs the *same* predicate: during
    this window the session is `running`, not idle — subtask cards are live,
    the composer stays locked, and no `turn_finished` is emitted. Two copies
    of the rule would eventually disagree and let a user inject a message into
    the middle of a fan-out.
    """
    return _canonical_tag(wake_on) in _SUBTASK_BARRIER_TAGS


def is_question_wake(wake_on: Any) -> bool:
    """Whether a `TaskSuspended` parked the task on a pending question.

    Exported for the same reason as `is_subtask_barrier`: the status machine
    reads it as `waiting`, and this module reads it as "emit nothing, the
    `question` frame already says this".
    """
    if isinstance(wake_on, dict):
        handle = wake_on.get("handle", "")
    else:
        handle = getattr(wake_on, "handle", "")
    return isinstance(handle, str) and handle.startswith(_QUESTION_WAKE_PREFIX)


def _is_content_ref(value: Any) -> bool:
    return _canonical_tag(value) == "content_ref"


def _clip(text: str, limit: int = OUTPUT_CLIP) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… (truncated; {len(text)} characters total)"


def _deref_json(deref: DerefFn, ref: Any) -> Any:
    """Fetch a `ContentRef` and decode its canonical-JSON body.

    Bodies that are not JSON (a tool that returned raw bytes) come back as
    replacement-decoded text rather than raising: one unreadable body must
    cost one frame's detail, not the turn.
    """
    if ref is None:
        return None
    raw = deref(ref)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return raw.decode("utf-8", errors="replace")


def _as_text(value: Any) -> str:
    """Render a deref'd body as the string the conversation shows."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _text_blocks(content: Any) -> str:
    """The text blocks of one message, joined and stripped."""
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text") or "")
        for block in content
        if isinstance(block, dict) and block.get("__canonical_tag__") == "text_block"
    ).strip()


def _flatten_questions(body: Any) -> list[dict[str, Any]]:
    """The question body from the ContentStore → the wire's questions array.

    The stored body is the SDK's 0.6.x reference shape: each question carries an
    index `id`, a `header`, an `options` list of `{label, description}`, and a
    `multiSelect` flag. There is no per-option id and no `allow_freeform` — the
    free-text "Other" slot is always available on the answer side."""
    if not isinstance(body, dict):
        return []
    questions = []
    for q in body.get("questions") or []:
        if not isinstance(q, dict):
            continue
        questions.append(
            {
                "id": q.get("id", ""),
                "question": q.get("question", ""),
                "header": q.get("header"),
                "options": [
                    {
                        "label": o.get("label", ""),
                        "description": o.get("description"),
                    }
                    for o in (q.get("options") or [])
                    if isinstance(o, dict)
                ],
                "multiSelect": bool(q.get("multiSelect", False)),
            }
        )
    return questions


# ---------------------------------------------------------------------------
# MessagesAppended — the one envelope that fans out
# ---------------------------------------------------------------------------


def _from_messages(seq: Optional[int], body: Any) -> list[UIEvent]:
    """One `MessagesAppended` body → the frames its messages carry, in order.

    What is deliberately *not* forwarded:

    - `role == "tool"` messages. Tool receipts and question-answer echoes are
      `ToolResultRecorded`'s and `UserQuestionAnswered`'s jobs; forwarding
      them here would double every tool result.
    - user messages carrying an `origin` other than `memory`. Those are
      host-injected content riding the user channel — `@`-mention snapshots,
      background-subagent completion notices, todo reminders — written for the
      model to read, not things the user said. Rendering them as user messages
      is a defect this branch exists to prevent.
    - assistant `tool_use_block`s other than `skill`. An executing tool comes
      through `ToolCallStarted` and a question through `UserQuestionRequested`;
      only the skill activation has no other envelope to arrive on.
    """
    events: list[UIEvent] = []
    if not isinstance(body, list):
        return events
    for msg in body:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content") or []
        origin = msg.get("origin")

        if role == "user" and origin == "memory":
            # Auto-recall is recorded as an origin-tagged user turn. It gets
            # its own frame so the UI can chip it as "recalled" — the one
            # host-injected message the user is entitled to see, and never as
            # something they typed.
            text = _text_blocks(content)
            if text:
                events.append(UIEvent(seq, "recall", {"text": _clip(text)}))
        elif role == "user" and not origin:
            text = _text_blocks(content)
            # Composer attachments ride the user turn as image blocks whose
            # source is a ContentRef; the wire carries {hash, media_type} and
            # the client refetches the bytes from the content endpoint. Image
            # bytes never travel the event stream.
            images = []
            for block in content if isinstance(content, list) else []:
                if (
                    not isinstance(block, dict)
                    or block.get("__canonical_tag__") != "image_block"
                ):
                    continue
                source = block.get("source")
                if not isinstance(source, dict) or not source.get("hash"):
                    continue
                images.append(
                    {
                        "hash": str(source["hash"]),
                        "media_type": str(source.get("media_type") or ""),
                    }
                )
            if text or images:
                data: dict[str, Any] = {"content": text}
                if images:
                    # Attached only when non-empty: a text-only turn's data
                    # stays exactly {content, _task}, with no empty list for a
                    # client to have to distinguish from "no attachment".
                    data["images"] = images
                events.append(UIEvent(seq, "user_message", data))
        elif role == "assistant":
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                tag = block.get("__canonical_tag__")
                if tag == "text_block":
                    text = str(block.get("text") or "").strip()
                    if text:
                        # Never clipped: this is the answer.
                        events.append(UIEvent(seq, "assistant_text", {"text": text}))
                elif tag == "tool_use_block" and block.get("tool_name") == "skill":
                    arguments = block.get("arguments")
                    skill = arguments.get("skill", "") if isinstance(arguments, dict) else ""
                    if skill:
                        events.append(
                            UIEvent(seq, "skill_activated", {"skill": str(skill)})
                        )
    return events


# ---------------------------------------------------------------------------
# Subtask streams — the narrow vocabulary
# ---------------------------------------------------------------------------


def _translate_subtask(env: Any, deref: DerefFn, subtask_id: str) -> list[UIEvent]:
    """Tool activity plus a cancel wrap-up. Everything else is dropped.

    Two rules here are correctness, not taste:

    - **Every frame carries `seq is None`.** A subtask stream counts `seq`
      independently of the parent, so carrying it would collide with the
      parent stream's dedup cursor and silently swallow root events — the
      failure is invisible and permanent.
    - **`TaskCancelled` must be wrapped up.** On a cancel cascade the subtask
      writes only `TaskCancelled` to its own stream; no delivery event ever
      reaches the parent, so without this branch the subtask card stays
      "running" forever.

    A subtask's lifecycle does not map to `turn_started` / `turn_finished` —
    the session follows the root task alone — and its `Compacted` must not
    surface in the parent conversation.
    """
    etype = env.type
    p = env.payload

    if etype == "ToolCallStarted":
        return [
            UIEvent(
                None,
                "tool_call",
                {
                    "call_id": p.call_id,
                    "tool_name": p.tool_name,
                    "arguments": _tool_arguments(p, deref),
                    "subtask_id": subtask_id,
                },
            )
        ]

    if etype == "ToolResultRecorded":
        return [
            UIEvent(
                None,
                "tool_result",
                {
                    "call_id": p.call_id,
                    "success": bool(p.success),
                    "summary": getattr(p, "summary", "") or "",
                    "output": _clip(
                        _as_text(_deref_json(deref, getattr(p, "output_ref", None)))
                    ),
                    "subtask_id": subtask_id,
                },
            )
        ]

    if etype == "TaskCancelled":
        return [
            UIEvent(
                None,
                "subtask_finished",
                {"subtask_id": subtask_id, "status": "cancelled", "summary": ""},
            )
        ]

    return []


def _tool_arguments(payload: Any, deref: DerefFn) -> dict[str, Any]:
    """A tool call's arguments, inline or deref'd — exactly one is populated."""
    arguments = getattr(payload, "arguments", None)
    if arguments is None and getattr(payload, "arguments_ref", None) is not None:
        arguments = _deref_json(deref, payload.arguments_ref)
    return arguments if isinstance(arguments, dict) else {}


# ---------------------------------------------------------------------------
# The root vocabulary
# ---------------------------------------------------------------------------


def _translate_root(env: Any, deref: DerefFn) -> list[UIEvent]:
    etype = env.type
    seq = env.seq
    p = env.payload

    if etype == "MessagesAppended":
        return _from_messages(seq, _deref_json(deref, p.messages_ref))

    if etype == "AssistantThinkingRecorded":
        body = _deref_json(deref, p.thinking_ref)
        texts = []
        for block in body if isinstance(body, list) else []:
            if not isinstance(block, dict):
                continue
            # `thinking` is read first so a provider that names the field for
            # its own vocabulary still renders; `text` is the recorded shape.
            text = block.get("thinking") or block.get("text")
            if text:
                texts.append(str(text))
        joined = "\n".join(texts).strip()
        return [UIEvent(seq, "thinking", {"text": _clip(joined)})] if joined else []

    if etype == "ToolCallStarted":
        arguments = _tool_arguments(p, deref)
        op = _MEMORY_TOOL_OPS.get(p.tool_name)
        if op is not None:
            # The four memory tools fold into one semantic marker. `name`
            # uniformly carries the object being acted on, which for a search
            # is the query and for the rest is the memory's name.
            key = "query" if op == "search" else "name"
            return [
                UIEvent(
                    seq,
                    "memory_op",
                    {
                        "call_id": p.call_id,
                        "op": op,
                        "name": str(arguments.get(key, "")),
                    },
                )
            ]
        return [
            UIEvent(
                seq,
                "tool_call",
                {
                    "call_id": p.call_id,
                    "tool_name": p.tool_name,
                    "arguments": arguments,
                },
            )
        ]

    if etype == "ToolResultRecorded":
        # A memory call's paired result still arrives here, and cannot be
        # suppressed: `ToolResultRecordedPayload` carries no tool name, and a
        # pure function has no memory of which call ids folded to `memory_op`.
        # The client drops a `tool_result` whose `call_id` matches no rendered
        # call, which is the designed fallback.
        return [
            UIEvent(
                seq,
                "tool_result",
                {
                    "call_id": p.call_id,
                    "success": bool(p.success),
                    "summary": getattr(p, "summary", "") or "",
                    "output": _clip(
                        _as_text(_deref_json(deref, getattr(p, "output_ref", None)))
                    ),
                },
            )
        ]

    if etype == "TaskStatePatched":
        # `todo_write` lands as a state patch that replaces the whole list.
        # The same envelope type also carries skill activation and goal
        # setting, so anything without a `set_todos` key emits nothing.
        patch = getattr(p, "patch", None)
        todos = patch.get("set_todos") if isinstance(patch, dict) else None
        if not isinstance(todos, list):
            return []
        return [
            UIEvent(
                seq,
                "todo_update",
                {
                    "todos": [
                        {
                            "id": str(t.get("id", "")),
                            "content": str(t.get("content", "")),
                            "status": str(t.get("status", "pending")),
                        }
                        for t in todos
                        if isinstance(t, dict)
                    ]
                },
            )
        ]

    if etype == "UserQuestionRequested":
        return [
            UIEvent(
                seq,
                "question",
                {
                    "question_id": p.question_id,
                    "reason": getattr(p, "reason", None),
                    "questions": _flatten_questions(
                        _deref_json(deref, p.questions_ref)
                    ),
                },
            )
        ]

    if etype == "UserQuestionAnswered":
        return [UIEvent(seq, "question_answered", {"question_id": p.question_id})]

    if etype == "UserQuestionWithdrawn":
        # 0.6.2: a Stop pressed while a question is pending withdraws it (the
        # "Esc" landing) rather than driving a turn. The card stays in the
        # transcript as a trace, marked cancelled; the pending gate is cleared
        # so the composer returns to normal.
        return [UIEvent(seq, "question_withdrawn", {"question_id": p.question_id})]

    # Two engine shapes spawn a subagent — a background single spawn, where
    # the parent does not block, and a foreground fan-out — and the
    # conversation shows one card for both.
    if etype in ("BackgroundSubagentStarted", "SubtaskSpawned"):
        return [
            UIEvent(
                seq,
                "subtask_started",
                {
                    "subtask_id": p.subtask_id,
                    "agent_name": p.agent_name,
                    "goal": p.goal,
                },
            )
        ]

    if etype == "BackgroundSubagentDelivered":
        return [
            UIEvent(
                seq,
                "subtask_finished",
                {
                    "subtask_id": p.subtask_id,
                    "status": str(p.status),
                    "summary": str(getattr(p, "summary", "") or ""),
                },
            )
        ]

    if etype == "SubtaskCompleted":
        result = getattr(p, "result", None)
        status = str(getattr(result, "status", "completed"))
        if status == "failed":
            summary = getattr(result, "error", None)
        else:
            summary = getattr(result, "output", None)
            if _is_content_ref(summary):
                # An output above the inline threshold is a ContentRef and
                # must be fetched. Rendering it directly once put the literal
                # string `ContentRef(hash=…)` on the card in place of the
                # subtask's answer.
                summary = _deref_json(deref, summary)
        return [
            UIEvent(
                seq,
                "subtask_finished",
                {
                    "subtask_id": p.subtask_id,
                    "status": status,
                    # Never clipped: a subtask's result is its answer, exactly
                    # like assistant text. Folding a long card is the client's
                    # business, not the wire's.
                    "summary": _as_text(summary),
                },
            )
        ]

    if etype == "Compacted":
        replaced = getattr(p, "replaced_count", None)
        return [
            UIEvent(
                seq,
                "compaction",
                {"replaced_count": replaced if isinstance(replaced, int) else 0},
            )
        ]

    if etype == "LLMRetryScheduled":
        # Renders nothing. Its only job is telling the client to drop the
        # delta buffer for this call id: the retry re-streams under the same
        # id, and an uncleared buffer splices the abandoned half-stream onto
        # the new one.
        return [UIEvent(seq, "llm_retry", {"call_id": p.call_id})]

    if etype in ("TaskStarted", "TaskWoken"):
        return [UIEvent(seq, "turn_started", {})]

    if etype == "TaskSuspended":
        return _from_suspend(seq, p)

    if etype == "TaskCancelled":
        return [UIEvent(seq, "turn_finished", {"status": "cancelled"})]

    if etype == "TaskFailed":
        return [
            UIEvent(seq, "error", {"message": _clip(_as_text(p.reason), ERROR_CLIP)}),
            UIEvent(seq, "turn_finished", {"status": "failed"}),
        ]

    if etype == "TaskCompleted":
        return [UIEvent(seq, "turn_finished", {"status": "completed"})]

    if etype == "TaskRewound":
        # The engine re-based the stream to before the user message at
        # `target_seq` (this and every later turn are now dead history, still
        # on the stream). The client folds this into a truncation: it drops
        # every item keyed past `target_seq`. `state_ref` is a server-only fold
        # baseline and never crosses the wire.
        return [UIEvent(seq, "rewind", {"target_seq": int(p.target_seq)})]

    return []


def _from_suspend(seq: Optional[int], payload: Any) -> list[UIEvent]:
    """`TaskSuspended` → the turn's resting state, or nothing.

    A suspend no longer implies the turn went well: a provider failure now
    parks the turn as `turn_failed` instead of sealing the ledger, and the
    difference between that and `failed` is whether the conversation can be
    resumed by typing again.
    """
    wake_on = getattr(payload, "wake_on", None)
    if is_subtask_barrier(wake_on):
        # Parked on a barrier: subtasks are still running, so the turn is not
        # over and the composer must stay locked.
        return []
    if is_question_wake(wake_on):
        # The `question` frame already expresses this state; a second frame
        # saying "awaiting input" would race it into a wrong resting status.
        return []

    # `parse_suspend_reason` owns the "<kind>: <detail>" convention, so the
    # raw tag is never substring-matched here. It reads the tag as a string,
    # and a hand-built or future envelope may leave it unset.
    reason = parse_suspend_reason(getattr(payload, "reason", "") or "")
    if reason.kind == SUSPEND_REASON_INTERRUPTED:
        return [UIEvent(seq, "turn_finished", {"status": "interrupted"})]
    if reason.kind == SUSPEND_REASON_TURN_FAILED:
        data: dict[str, Any] = {"status": "turn_failed"}
        if reason.detail:
            data["reason"] = reason.detail
        return [UIEvent(seq, "turn_finished", data)]

    # Everything else parks, including a kind this build has never seen: the
    # suspend tag is a legibility field a new producer may extend without a
    # protocol bump, so an unknown one is "resting", never an error.
    return [UIEvent(seq, "turn_finished", {"status": "awaiting_input"})]


def translate(
    env: Any, deref: DerefFn, subtask_id: Optional[str] = None
) -> list[UIEvent]:
    """One envelope → zero or more UI frames.

    A non-`None` `subtask_id` means the envelope came from one of this
    session's subtask streams — the caller decides that from the envelope's
    task id — and it goes through the narrow subtask vocabulary.

    Root frames are stamped with `data["_task"] = env.task_id`, the stream
    they belong to, which is what the SSE endpoint's `?task_id=` branch filter
    reads. Subtask frames are deliberately left unstamped: their envelope's
    task id is the *subtask's* stream, which no client ever filters on, so
    stamping it would hide every subtask card. The caller fills theirs in with
    the parent stream's id (`setdefault`, so a root frame's stamp wins), and
    until it does, an absent `_task` reaches every consumer.

    Root frames are also stamped with `data["ts"]` — the envelope's
    `occurred_at`, epoch seconds. It is an **optional** field by contract, and
    it exists because a finished turn folds behind "Worked for 1m 35s": a
    duration measured by a browser stopwatch restarts at every reload, so the
    label has to be re-derived from the log like everything else on the screen.
    An envelope with no clock simply produces no `ts`, and the client falls
    back to a step count. Subtask frames get none: they are synthetic, and no
    envelope of the parent stream produced them.
    """
    if subtask_id is not None:
        return _translate_subtask(env, deref, subtask_id)

    events = _translate_root(env, deref)
    occurred_at = getattr(env, "occurred_at", None)
    stamp = float(occurred_at) if isinstance(occurred_at, (int, float)) else None
    for event in events:
        event.data["_task"] = env.task_id
        if stamp is not None:
            event.data["ts"] = stamp
    return events
