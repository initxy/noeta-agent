"""Session titles: an instant fallback, then one LLM call in the background.

Two titles with two different lives, and conflating them is the mistake this
module is shaped to prevent:

- the **fallback** is set synchronously at the first send — the first line of
  the message, capped at 40 characters — so the sidebar never shows an empty
  row while a turn runs;
- the **generated** title replaces it once, when the first turn ends, from one
  LLM call on a dedicated daemon thread, cleaned and capped at 16 characters.

Three properties are load-bearing:

- **All material comes from the event stream**, never from in-process memory:
  the first `user_message` and the last `assistant_text`, re-derived through
  the same translator the wire uses. That is what lets a session recovered
  after a restart back-fill its title correctly instead of being stuck with
  the truncation forever.
- **The call is a direct HTTP POST**, not a turn through the `Client`. A title
  is not part of the conversation; putting it through the engine would write
  it into the ledger and occupy a worker.
- **Reasoning is disabled on that call** (`reasoning: {"effort": "none"}`). A
  reasoning model defaults to medium effort, spends the entire 64-token output
  budget on reasoning tokens and returns `status=incomplete` with no message —
  the title comes back empty, every time, silently.

Retry policy: success is recorded durably and never repeats; failure is
remembered **in this process only**, so a persistent failure stops costing
calls while a restart retries once. Persistent failures self-heal, transient
failures do not spam.

The store and the event hub are injected as callables (see `TitleService`):
this module decides *when* and *what*, never *where it is kept*.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Callable, Optional

import httpx

from noeta.agent.config import Settings
from noeta.agent.host.translator import DerefFn, UIEvent, translate
from noeta.agent.models_config import get_default_model

logger = logging.getLogger(__name__)

#: Cap on the *generated* title. Short on purpose: it is a sidebar label, not
#: a summary.
TITLE_MAXLEN = 16

#: Cap on the *fallback* title — the first line of the user's message. A
#: different number for a different thing; do not fold the two together.
FALLBACK_MAXLEN = 40

#: How much of the conversation the prompt carries.
FIRST_MESSAGE_CLIP = 600
ASSISTANT_REPLY_CLIP = 300

#: A title is tiny. The 300s chat timeout would leave a hung gateway holding a
#: thread for five minutes to produce a sidebar label.
TITLE_TIMEOUT = 30.0

#: Output ceiling for the call. With reasoning off, 64 tokens is plenty.
TITLE_MAX_OUTPUT_TOKENS = 64

_INSTRUCTIONS = (
    "Generate one concise title for this conversation in the user's language, "
    "no more than 16 characters, summarizing the user's intent. "
    "Output the title itself only - no quotes, no trailing punctuation, no "
    "book-title marks, and no prefix, suffix, or explanation."
)

#: Wrapping characters a model adds unasked: ASCII and typographic quotes, CJK
#: book-title marks, and the backticks a code-trained model reaches for.
_WRAPPERS = ('"', "'", "\u201c", "\u201d", "\u2018", "\u2019",
             "\u300a", "\u300b", "\u300c", "\u300d", "\u300e", "\u300f", "`")

#: Sentence-ending punctuation stripped from both edges, full-width first
#: because that is what a CJK model emits.
_EDGE_PUNCTUATION = " \u3002.\u3001,\uff0c;\uff1b:\uff1a!\uff01?\uff1f"


# ---------------------------------------------------------------------------
# Pure text handling
# ---------------------------------------------------------------------------


def fallback_title(text: str) -> str:
    """The instant title for a new session: the message's first line, ≤40.

    Returns `""` for a message with no text at all — an image-only send — and
    the caller leaves the existing title alone. `"".splitlines()` is `[]`, so
    the empty case has to be handled here rather than by indexing.
    """
    lines = text.strip().splitlines() or [""]
    return lines[0][:FALLBACK_MAXLEN]


def fork_title(parent_title: str) -> str:
    """The seed title for a fork: the parent's, marked as a fork, ≤40.

    A fork starts with no message of its own, so `fallback_title` has nothing
    to work from until the edited message lands; this labels the row in the
    meantime, and `title_generated` stays false so the first real turn still
    replaces it. An untitled parent yields `""` — the child stays untitled too,
    exactly as an ordinary new session does, rather than reading `" (fork)"`.
    """
    base = parent_title.strip()
    if not base:
        return ""
    suffix = " (fork)"
    return base[: FALLBACK_MAXLEN - len(suffix)] + suffix


def clean_title(raw: str) -> str:
    """Model output → a title, or `""` when nothing usable is left.

    Models wrap titles in quotes or book-title marks, end them with a period,
    and occasionally answer in two lines. All three fold away here; `""` means
    the generation failed, whatever the transport said.
    """
    title = raw.strip()
    for char in _WRAPPERS:
        title = title.replace(char, "")
    # Any line break becomes a space, then runs of whitespace collapse: a
    # two-line answer is one title, not a paragraph.
    title = " ".join(title.replace("\r", " ").replace("\n", " ").split())
    title = title.strip(_EDGE_PUNCTUATION)
    return title[:TITLE_MAXLEN].strip()


def _build_prompt(first_message: str, assistant_reply: Optional[str]) -> str:
    parts = [f"User's first message:\n{first_message.strip()[:FIRST_MESSAGE_CLIP]}"]
    if assistant_reply:
        parts.append(
            "\nAssistant reply (excerpt):\n"
            f"{assistant_reply.strip()[:ASSISTANT_REPLY_CLIP]}"
        )
    return "\n".join(parts)


def _extract_output_text(payload: Mapping[str, Any]) -> str:
    """The text of an OpenAI Responses payload, ignoring reasoning items."""
    output = payload.get("output")
    if not isinstance(output, list):
        return ""
    texts: list[str] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for segment in item.get("content") or []:
            if isinstance(segment, dict) and segment.get("type") == "output_text":
                text = segment.get("text")
                if isinstance(text, str):
                    texts.append(text)
    return "".join(texts)


# ---------------------------------------------------------------------------
# The gateway call
# ---------------------------------------------------------------------------


def generate_title(
    settings: Settings,
    first_message: str,
    assistant_reply: Optional[str],
    task_id: str,
) -> Optional[str]:
    """One title, or `None` when there is none to be had.

    `None` covers every reason equally — no gateway configured, an empty
    conversation, a network failure, a model that answered with punctuation —
    because the caller's response to all of them is the same: keep the
    fallback and stop retrying in this process.
    """
    if settings.effective_provider != "openai":
        return None
    if not first_message.strip():
        return None

    # An explicitly configured title model must be a NON-reasoning one; empty
    # falls back to the conversation's default model.
    model = settings.title_model or get_default_model(settings).id
    endpoint = settings.llm_base_url.rstrip("/") + "/responses"
    body: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": _build_prompt(first_message, assistant_reply),
                    }
                ],
            }
        ],
        "instructions": _INSTRUCTIONS,
        # Nothing gateway-side should outlive this call.
        "store": False,
        # See the module docstring: without this a reasoning model burns the
        # whole budget below on hidden tokens and returns no message at all.
        "reasoning": {"effort": "none"},
        "max_output_tokens": TITLE_MAX_OUTPUT_TOKENS,
    }
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "content-type": "application/json",
        # Same affinity key the chat turns carry, so the title call does not
        # land on a different backend account.
        "x-session-id": task_id,
    }
    try:
        response = httpx.post(
            endpoint, json=body, headers=headers, timeout=TITLE_TIMEOUT
        )
        response.raise_for_status()
        payload = response.json()
    except Exception:  # noqa: BLE001 - transport / gateway / parse are one outcome
        logger.warning("title generation request failed", exc_info=True)
        return None

    return clean_title(_extract_output_text(payload)) or None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TitleTarget:
    """What the title thread needs to know about a session.

    `task_id` is the stream to read the conversation from — the session's
    first, since the title describes how the conversation opened.
    """

    task_id: str
    generated: bool


#: `session_id -> TitleTarget | None`. `None` means the session is gone, which
#: is also how the thread checks it still exists before persisting.
ReadSessionFn = Callable[[str], Optional[TitleTarget]]

#: `session_id, title -> None`. Persists the title AND marks it generated;
#: they are one durable fact and splitting them invites a second LLM call.
SaveTitleFn = Callable[[str, str], None]

#: `session_id, frame -> None`. Broadcasts one synthetic frame to the
#: session's SSE subscribers.
PushFrameFn = Callable[[str, UIEvent], None]

#: `task_id -> envelopes`, i.e. `client.events_after(task_id, after_seq=None)`.
EventsAfterFn = Callable[[str], Iterable[Any]]

#: The generation call itself, injected so the orchestration can be tested
#: without a gateway.
GenerateFn = Callable[[Settings, str, Optional[str], str], Optional[str]]


class TitleService:
    """Decides when a session gets its generated title, and runs the call.

    Triggered at the end of the first turn. Four conditions skip it, and each
    one closes a different hole: already generated (durable, survives a
    restart), already failed in this process (in-memory, deliberately does
    not), a generation in flight (a turn boundary can arrive twice), and no
    task id yet (the session has not been seeded).

    The call runs on its own daemon thread. Not the jobs worker and not the
    engine pool: an LLM call that occupies either one stalls real work to
    produce a sidebar label.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        read_session: ReadSessionFn,
        save_title: SaveTitleFn,
        push_frame: PushFrameFn,
        events_after: EventsAfterFn,
        deref: DerefFn,
        generate: GenerateFn = generate_title,
    ) -> None:
        self._settings = settings
        self._read_session = read_session
        self._save_title = save_title
        self._push_frame = push_frame
        self._events_after = events_after
        self._deref = deref
        self._generate = generate
        self._lock = threading.Lock()
        # In-process only, and that is the policy: a restart clears it and
        # retries once.
        self._failed: set[str] = set()
        self._in_flight: set[str] = set()

    def maybe_generate(self, session_id: str) -> Optional[threading.Thread]:
        """Start title generation if this session still wants one.

        Called from the envelope-observer thread at a turn boundary, so it
        does no I/O beyond the session read and never blocks. Returns the
        thread it started (or `None`), which callers ignore and tests join.
        """
        target = self._read_session(session_id)
        if target is None or target.generated or not target.task_id:
            return None
        with self._lock:
            if session_id in self._failed or session_id in self._in_flight:
                return None
            self._in_flight.add(session_id)
        thread = threading.Thread(
            target=self._run,
            args=(session_id, target.task_id),
            name=f"title-gen-{session_id[:8]}",
            daemon=True,
        )
        thread.start()
        return thread

    def forget(self, session_id: str) -> None:
        """Drop a deleted session's failure memory, so a later session
        reusing the id is not born already-failed."""
        with self._lock:
            self._failed.discard(session_id)

    # -- the thread body ---------------------------------------------------

    def _run(self, session_id: str, task_id: str) -> None:
        try:
            first_message = self._first_user_message(task_id)
            if not first_message:
                self._mark_failed(session_id)
                return
            assistant_reply = self._latest_assistant_reply(task_id)
            try:
                title = self._generate(
                    self._settings, first_message, assistant_reply, task_id
                )
            except Exception:  # noqa: BLE001 - a backstop; any crash is a failure
                logger.warning(
                    "title generation crashed for %s", session_id, exc_info=True
                )
                title = None
            if not title:
                self._mark_failed(session_id)
                return
            # The session may have been deleted while the gateway was
            # thinking; persisting now would resurrect a row.
            if self._read_session(session_id) is None:
                return
            self._save_title(session_id, title)
            # Synthetic: a title is not derivable from the event log, so it
            # carries no seq and is not replayed. The sidebar updates live;
            # a refresh reads the persisted row.
            self._push_frame(
                session_id, UIEvent(None, "session_meta", {"title": title})
            )
        finally:
            with self._lock:
                self._in_flight.discard(session_id)

    def _mark_failed(self, session_id: str) -> None:
        with self._lock:
            self._failed.add(session_id)

    def _first_user_message(self, task_id: str) -> Optional[str]:
        """The conversation's opening message, read back off the event stream.

        Deliberately not taken from the send path's in-process state: reading
        the log is what makes a session recovered after a restart eligible for
        a title at all.
        """
        try:
            for envelope in self._events_after(task_id):
                for event in translate(envelope, self._deref):
                    if event.type != "user_message":
                        continue
                    text = event.data.get("content")
                    if isinstance(text, str) and text.strip():
                        return text.strip()[:FIRST_MESSAGE_CLIP]
            return None
        except Exception:  # noqa: BLE001 - an unreadable stream is "no first message"
            logger.debug("first user message read failed", exc_info=True)
            return None

    def _latest_assistant_reply(self, task_id: str) -> Optional[str]:
        """The most recent assistant text, as extra context for the prompt.

        Absent is fine — the title is then generated from the user's message
        alone. Skipped entirely under the mock provider: `generate_title`
        returns `None` there anyway, so reading would start a pointless
        concurrent pass over the event stream on every single mock turn.
        """
        if self._settings.effective_provider != "openai":
            return None
        try:
            latest: Optional[str] = None
            for envelope in self._events_after(task_id):
                for event in translate(envelope, self._deref):
                    if event.type != "assistant_text":
                        continue
                    text = event.data.get("text")
                    if isinstance(text, str) and text.strip():
                        latest = text
            return latest[:ASSISTANT_REPLY_CLIP] if latest else None
        except Exception:  # noqa: BLE001 - never let context-gathering block the title
            logger.debug("latest assistant reply read failed", exc_info=True)
            return None
