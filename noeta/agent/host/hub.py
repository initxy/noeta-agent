"""The event hub: one subscription from the engine, fanned out to sessions.

Everything that has to happen exactly once per committed envelope happens here
— routing, translation, the status machine, the store's activity write, and the
fan-out to whatever SSE streams are attached. The HTTP layer above it does none
of that; a handler subscribes, replays, and forwards frames.

Four properties are load-bearing, and each is a bug that has already been paid
for once:

- **A translation failure never propagates into the engine's emit path.** The
  subscription callback runs inside the runtime's post-commit hook, so an
  exception escaping it would surface as a failed turn. One bad envelope costs
  one dropped frame, logged, and nothing else.
- **Queues are bounded, and only `delta` frames may be dropped.** A frame that
  carries a `seq` is durable and its loss is invisible: the client's cursor
  moves past it and a reconnect never asks for it again. When no delta can be
  evicted to make room, the stream is closed instead and the client reconnects
  with `since_seq` — re-derivation *is* the recovery path.
- **The routing map is rebuilt from the database before the workers start.**
  The pool's stale-lease sweep re-drives tasks that were mid-turn when the
  process died; with an empty map their envelopes cannot be routed to a
  session and their turns run invisibly.
- **A brand-new task routes from the first envelope.** `seed_start` writes
  `TaskCreated`, the user message and `TaskStarted` *before* it returns the id
  the caller would bind, and the post-commit hook fires on the seeding thread —
  so `binding()` opens a thread-local window that claims exactly those
  envelopes. It is race-free by construction rather than by a set of lock-free
  invariants, for the same reason `MemoryRoots.seeding` is.

The read path (`replay`) is here too, because replay and live must be the same
pure function of the same envelopes — that is what makes "replay is
re-derivation" true instead of aspirational. It is a plain blocking call: the
HTTP layer runs it on the thread pool, never on the engine's drive queue.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import sqlite3
import threading
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any, Optional

from noeta.agent.host.status import IDLE, StatusMachine
from noeta.agent.host.translator import UIEvent, translate
from noeta.agent.store import projects, sessions

logger = logging.getLogger(__name__)

#: Frames buffered per SSE subscription before the drop rules apply. Large
#: enough that an ordinary turn never touches it (a busy turn is tens of
#: envelopes plus its deltas), small enough that a browser tab left paused
#: cannot hold a session's whole history in memory.
QUEUE_SIZE = 1024

#: Root-stream envelopes that announce a child task. Two engine shapes — a
#: background spawn and a foreground fan-out — and both carry `subtask_id`.
SPAWN_TYPES = frozenset({"SubtaskSpawned", "BackgroundSubagentStarted"})

#: The one frame type backpressure may drop. Everything else either carries a
#: `seq` the client dedups on, or is a synthetic frame (`replay_done`,
#: `branch_created`, a subtask roll-up) that is never replayed and therefore
#: cannot be recovered by reconnecting.
DROPPABLE = "delta"


class Subscription:
    """One SSE stream's inbox.

    Lives on the event loop: `offer` is only ever called through
    `loop.call_soon_threadsafe`, so it and the reading coroutine never run at
    the same time and the whole thing needs no lock.
    """

    __slots__ = ("_items", "_wake", "_maxsize", "overflowed", "dropped_deltas", "loop")

    def __init__(self, loop: asyncio.AbstractEventLoop, *, maxsize: int = QUEUE_SIZE):
        self.loop = loop
        self._items: deque[UIEvent] = deque()
        self._wake = asyncio.Event()
        self._maxsize = maxsize
        #: Set when a durable frame could not be buffered. The reader closes
        #: the stream on it; the client reconnects with `since_seq` and
        #: re-derives what it missed.
        self.overflowed = False
        self.dropped_deltas = 0

    def offer(self, event: UIEvent) -> None:
        """Enqueue one frame, applying the drop rules. Event-loop thread only."""
        if len(self._items) < self._maxsize:
            self._items.append(event)
            self._wake.set()
            return
        if event.type == DROPPABLE:
            self.dropped_deltas += 1
            return
        # A durable frame arrived at a full queue. Evicting a *delta* is free
        # — the authoritative `MessagesAppended` repaints the same bytes — so
        # try that before declaring the stream unrecoverable.
        for index, buffered in enumerate(self._items):
            if buffered.type == DROPPABLE:
                del self._items[index]
                self.dropped_deltas += 1
                self._items.append(event)
                self._wake.set()
                return
        self.overflowed = True
        self._wake.set()

    def close(self) -> None:
        """Mark the stream unrecoverable and wake its reader.

        Used when the subscription's session disappeared, and when a durable
        frame could not be buffered. Either way the honest answer is to end the
        response so the client reconnects with its cursor."""
        self.overflowed = True
        self._wake.set()

    async def next(self, timeout: float) -> Optional[UIEvent]:
        """The next frame, or `None` when `timeout` seconds passed in silence.

        `None` is the heartbeat tick, not an error: an idle session must keep
        writing something or an intermediate proxy eventually closes the
        connection.
        """
        if self._items:
            return self._items.popleft()
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout)
        except (TimeoutError, asyncio.TimeoutError):
            return None
        return self._items.popleft() if self._items else None


class EventHub:
    """Engine envelopes in, per-session UI frames out.

    Constructed before the `Client` (it is the delta sink, which `HostConfig`
    takes at build time) and handed the client afterwards with `attach`.
    """

    def __init__(
        self,
        store: sqlite3.Connection,
        *,
        queue_size: int = QUEUE_SIZE,
        status: Optional[StatusMachine] = None,
        on_turn_boundary: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._store = store
        self._queue_size = queue_size
        self._status = status or StatusMachine()
        self._on_turn_boundary = on_turn_boundary
        self._client: Any = None

        self._lock = threading.Lock()
        #: Root and branch streams: the durable map, mirrored from the store.
        self._tasks: dict[str, str] = {}
        #: Subtask streams: `subtask_id -> (session_id, root task id)`. Memory
        #: only, and deliberately so — a subtask that was running at crash time
        #: has no session to route to after a restart, which costs its live
        #: frames and nothing durable.
        self._subtasks: dict[str, tuple[str, str]] = {}
        self._subs: dict[str, list[Subscription]] = {}
        #: The seed window, per thread. See the module docstring.
        self._seeding = threading.local()

    # -- wiring ---------------------------------------------------------------

    def attach(self, client: Any) -> None:
        """Bind the engine client the hub reads through.

        Separate from the constructor because the two depend on each other:
        `HostConfig.delta_sink` is this hub, and it is fixed when the client is
        built."""
        self._client = client

    @property
    def client(self) -> Any:
        return self._client

    def set_turn_boundary_hook(self, fn: Optional[Callable[[str], None]]) -> None:
        """Register what runs when a session's turn comes to rest.

        Registered after construction because the only consumer — title
        generation — reads and pushes through this hub, so it cannot exist
        before it."""
        self._on_turn_boundary = fn

    def deref(self, ref: Any) -> Optional[bytes]:
        """The `ContentRef -> bytes` getter the translator derefs through."""
        if self._client is None:
            return None
        return self._client.get_content(getattr(ref, "hash", ref))

    # -- the routing map ------------------------------------------------------

    def rebuild(self) -> int:
        """Reload every session's task streams from the store. Returns the count.

        Called **before** the worker pool starts. The pool's stale-lease
        requeue re-drives tasks that were mid-turn at crash time, and their
        envelopes arrive with no session unless this ran first.
        """
        pairs: list[tuple[str, str]] = []
        for project in projects.list_projects(self._store):
            for session in sessions.list_sessions(self._store, project.id):
                for stream in sessions.list_task_streams(self._store, session.id):
                    pairs.append((stream.task_id, session.id))
        with self._lock:
            self._tasks.update(dict(pairs))
        return len(pairs)

    def bind(self, task_id: str, session_id: str) -> None:
        """Route a task stream to a session. Idempotent."""
        if not task_id:
            return
        with self._lock:
            self._tasks[task_id] = session_id

    @contextlib.contextmanager
    def binding(self, session_id: str) -> Iterator[None]:
        """Claim, for this thread only, the tasks created inside the block.

        `seed_start` emits a new task's first envelopes synchronously, on the
        calling thread, before it can return the id — so the caller cannot have
        bound it yet and the leading frames of every session's first turn would
        be dropped from the live stream. The post-commit hook fires on this
        same thread, so a thread-local claim catches exactly those envelopes
        and nothing else.
        """
        previous = getattr(self._seeding, "session_id", None)
        self._seeding.session_id = session_id
        try:
            yield
        finally:
            self._seeding.session_id = previous

    def session_for(self, task_id: str) -> Optional[str]:
        with self._lock:
            found = self._tasks.get(task_id)
            if found is not None:
                return found
            subtask = self._subtasks.get(task_id)
        return subtask[0] if subtask is not None else None

    def forget_session(self, session_id: str) -> None:
        """Drop every in-memory trace of a deleted session."""
        with self._lock:
            for task_id in [t for t, s in self._tasks.items() if s == session_id]:
                del self._tasks[task_id]
                self._status.forget(task_id)
            for task_id in [t for t, v in self._subtasks.items() if v[0] == session_id]:
                del self._subtasks[task_id]
            subs = self._subs.pop(session_id, [])
        # Close whatever is still streaming: the session is gone, so its SSE
        # response has nothing left to say.
        for sub in subs:
            self._call(sub, sub.close)

    # -- ingest ---------------------------------------------------------------

    def on_envelope(self, env: Any) -> None:
        """The `Client.subscribe` callback. Runs on the committing thread.

        Nothing may escape this method. It is called from inside the runtime's
        post-commit hook, and an exception here would surface to the user as a
        failed turn caused by a rendering bug.
        """
        try:
            self._ingest(env)
        except Exception:  # noqa: BLE001 - see the docstring
            logger.exception(
                "dropping one envelope the hub could not process: %s",
                getattr(env, "type", "?"),
            )

    def _ingest(self, env: Any) -> None:
        task_id = getattr(env, "task_id", "") or ""
        session_id, subtask_id = self._route(env, task_id)
        if session_id is None:
            return

        if subtask_id is None:
            self._learn_subtasks(env, session_id, task_id)
            self._advance(session_id, env)

        root_task_id = task_id if subtask_id is None else self._root_of(task_id, task_id)
        for event in self._translate(env, subtask_id):
            # A subtask frame is stamped with the *parent's* stream id: its own
            # task id is a stream no client ever filters on, so stamping that
            # would hide every subtask card behind the `?task_id=` filter.
            event.data.setdefault("_task", root_task_id)
            self._fanout(session_id, event)

    def _translate(self, env: Any, subtask_id: Optional[str]) -> list[UIEvent]:
        try:
            return translate(env, self.deref, subtask_id)
        except Exception:  # noqa: BLE001 - one envelope, never the turn
            logger.exception(
                "translation failed for %s seq=%s; dropping it",
                getattr(env, "type", "?"),
                getattr(env, "seq", "?"),
            )
            return []

    def _route(self, env: Any, task_id: str) -> tuple[Optional[str], Optional[str]]:
        """`(session_id, subtask_id)` for one envelope.

        `subtask_id` is `None` for a root or branch stream — the caller reads
        that as "use the full vocabulary".
        """
        with self._lock:
            session_id = self._tasks.get(task_id)
            if session_id is not None:
                return session_id, None
            known = self._subtasks.get(task_id)
            if known is not None:
                return known[0], task_id

            # A child announced by its own genesis event rather than by the
            # parent's spawn marker — whichever of the two commits first.
            parent = getattr(getattr(env, "payload", None), "parent_task_id", None)
            if parent:
                owner = self._tasks.get(parent)
                if owner is not None:
                    self._subtasks[task_id] = (owner, parent)
                    return owner, task_id
                inherited = self._subtasks.get(parent)
                if inherited is not None:
                    # A nested subtask: it belongs to the same session and
                    # renders under the same root stream.
                    self._subtasks[task_id] = inherited
                    return inherited[0], task_id
                return None, None

            # The seed window: this envelope was committed by the thread that
            # is seeding a turn, so it belongs to that session's new stream.
            seeding = getattr(self._seeding, "session_id", None)
            if seeding is not None:
                self._tasks[task_id] = seeding
                return seeding, None
        return None, None

    def _learn_subtasks(self, env: Any, session_id: str, root_task_id: str) -> None:
        if getattr(env, "type", "") not in SPAWN_TYPES:
            return
        subtask_id = getattr(getattr(env, "payload", None), "subtask_id", None)
        if not subtask_id:
            return
        with self._lock:
            self._subtasks[subtask_id] = (session_id, root_task_id)

    def _root_of(self, task_id: str, default: str) -> str:
        with self._lock:
            known = self._subtasks.get(task_id)
        return known[1] if known is not None else default

    def _advance(self, session_id: str, env: Any) -> None:
        """Write the session's derived status and activity mark.

        Runs before the fan-out, which is what lets a client answer a question
        the instant it sees the `question` frame: the status is already
        `waiting` by then.
        """
        status = self._status.observe(env)
        seq = getattr(env, "seq", None)
        try:
            sessions.advance_session(
                self._store,
                session_id,
                status=status,
                last_seq=seq if isinstance(seq, int) else None,
            )
        except Exception:  # noqa: BLE001 - the wire matters more than the index
            logger.exception("could not record activity for session %s", session_id)
            return
        if status == IDLE and self._on_turn_boundary is not None:
            try:
                self._on_turn_boundary(session_id)
            except Exception:  # noqa: BLE001 - a sidebar label, never the turn
                logger.exception("turn-boundary hook failed for %s", session_id)

    def on_delta(self, ctx: Any, call_id: str, delta: Any) -> None:
        """`HostConfig.delta_sink`. Inside the LLM round trip, on a worker
        thread: never blocks, never raises.

        Only root-stream deltas are forwarded. Subtask streaming is
        unimplemented, and a subtask's tokens interleaved into the parent
        conversation would render as the main agent talking.
        """
        try:
            task_id = getattr(ctx, "task_id", "") or ""
            with self._lock:
                session_id = self._tasks.get(task_id)
            if session_id is None:
                return
            self._fanout(
                session_id,
                UIEvent(
                    None,
                    "delta",
                    {
                        "call_id": call_id,
                        "kind": getattr(delta, "kind", "text"),
                        "text": getattr(delta, "text", ""),
                        "index": getattr(delta, "index", 0),
                        "_task": task_id,
                    },
                ),
            )
        except Exception:  # noqa: BLE001 - a preview must never fail an LLM call
            logger.debug("delta sink dropped a chunk", exc_info=True)

    # -- fan-out --------------------------------------------------------------

    def subscribe(self, session_id: str) -> Subscription:
        """Attach one SSE stream. Called from the event loop."""
        sub = Subscription(asyncio.get_running_loop(), maxsize=self._queue_size)
        with self._lock:
            self._subs.setdefault(session_id, []).append(sub)
        return sub

    def unsubscribe(self, session_id: str, sub: Subscription) -> None:
        with self._lock:
            subs = self._subs.get(session_id)
            if not subs:
                return
            with contextlib.suppress(ValueError):
                subs.remove(sub)
            if not subs:
                del self._subs[session_id]

    def push(self, session_id: str, event: UIEvent) -> None:
        """Broadcast one synthetic frame — a frame nothing in the log implies.

        The send path's optimistic `turn_started`, `branch_created`,
        `session_meta` and the drive-failure notice all arrive this way. They
        carry no `seq` and are never replayed, which is a deliberate per-frame
        choice rather than something discovered after a refresh loses them.
        """
        self._fanout(session_id, event)

    def _fanout(self, session_id: str, event: UIEvent) -> None:
        with self._lock:
            targets = list(self._subs.get(session_id, ()))
        for sub in targets:
            self._call(sub, sub.offer, event)

    @staticmethod
    def _call(sub: Subscription, fn: Callable[..., None], *args: Any) -> None:
        """Run `fn` on the subscription's event loop.

        Every mutation of a `Subscription` funnels through here, which is what
        lets the class itself be lock-free: producers are engine threads, the
        consumer is a coroutine, and this is the one hop between them."""
        try:
            sub.loop.call_soon_threadsafe(fn, *args)
        except RuntimeError:
            # The loop is gone (the client disconnected as we fanned out).
            # Losing the frame is correct; there is nobody left to read it.
            logger.debug("dropping a frame for a closed event loop")

    # -- reads ----------------------------------------------------------------

    def replay(
        self,
        session_id: str,
        *,
        since_seq: Optional[int] = None,
    ) -> list[UIEvent]:
        """Re-derive a session's conversation from the event log.

        Blocking, and called from the HTTP layer's thread pool. It must never
        run behind the engine's drive queue: an active turn holds a worker for
        minutes on LLM retries alone, and a replay parked behind it means every
        session's SSE — finished ones included — never reaches `replay_done`
        and the whole frontend sits on a loading skeleton.

        `since_seq` of `0` (or `None`) is a **full** replay, and it is the only
        one that carries subtask frames: those are synthetic, so a reconnect
        that re-sent them would duplicate content the client cannot dedup.

        A **fork** session prepends its inherited history — the parent stream's
        frames up to the fork anchor — ahead of its own, and on a full replay
        only (see `_inherited_prefix`). Its own stream is then replayed as for
        any session. A session has exactly one own stream (its root); the list
        is iterated rather than indexed only to stay total when a session has
        none yet.
        """
        if self._client is None:
            return []
        after = since_seq if since_seq is not None and since_seq > 0 else None
        streams = sessions.list_task_streams(self._store, session_id)
        out: list[UIEvent] = []
        # Inherited history first, so a fork reads as one conversation. Full
        # replay only: the prefix is immutable past on another stream, so a
        # reconnect (after > 0) already has it and re-sending seq-less frames
        # would duplicate content the client cannot dedup. Stamped with the
        # child's own root stream so the whole transcript is one `_task`.
        own_task = streams[0].task_id if streams else None
        if after is None and own_task is not None:
            out.extend(self._inherited_prefix(session_id, own_task))

        include_subtasks = after is None
        for stream in streams:
            for env in self._events_after(stream.task_id, after):
                frames = self._translate(env, None)
                for event in frames:
                    event.data.setdefault("_task", stream.task_id)
                out.extend(frames)
                if include_subtasks and getattr(env, "type", "") in SPAWN_TYPES:
                    subtask_id = getattr(env.payload, "subtask_id", None)
                    if subtask_id:
                        out.extend(self._replay_subtask(subtask_id, stream.task_id))
        return out

    def _inherited_prefix(self, session_id: str, own_task: str) -> list[UIEvent]:
        """A fork's shared history: the parent stream up to the fork anchor.

        Empty for an ordinary session (no `source_task_id`). The frames are
        stamped with the fork's **own** root stream (`own_task`) so the whole
        child transcript reads as one continuous `_task`, marked `_inherited`
        so the renderer can dim them, and carry **no seq**: they are past
        history on another session's stream, so they must never advance this
        session's SSE cursor — exactly the discipline subtask frames already
        keep. The bound is **exclusive** of `branched_at_seq`: a fork replaces
        the turn the anchor opens, so the anchored message and everything after
        it belong to the path not taken. (This is the same cut the old
        in-session `branchView` made with `key >= branchedAtSeq`.)

        Read straight from the source task's event log, which survives the
        parent session's deletion — the lineage columns are not foreign keys to
        it, and `delete_session` leaves envelopes intact — so a child still
        shows its history after its parent is gone.
        """
        session = sessions.get_session(self._store, session_id)
        if session is None or not session.source_task_id:
            return []
        bound = session.branched_at_seq
        out: list[UIEvent] = []
        for env in self._events_after(session.source_task_id, None):
            seq = getattr(env, "seq", None)
            if bound is not None and isinstance(seq, int) and seq >= bound:
                break
            for event in self._translate(env, None):
                event.seq = None
                event.data["_task"] = own_task
                event.data.setdefault("_inherited", True)
                out.append(event)
        return out

    def _replay_subtask(self, subtask_id: str, root_task_id: str) -> list[UIEvent]:
        """One subtask's stream, spliced in right after its `subtask_started`.

        Rendering order, not a detail: the tool rows of a subtask belong under
        its own card, and a client that receives them after the parent's next
        message has nowhere to put them."""
        out: list[UIEvent] = []
        for env in self._events_after(subtask_id, None):
            for event in self._translate(env, subtask_id):
                event.data.setdefault("_task", root_task_id)
                out.append(event)
        return out

    def _events_after(self, task_id: str, after_seq: Optional[int]) -> list[Any]:
        try:
            return self._client.events_after(task_id, after_seq=after_seq)
        except Exception:  # noqa: BLE001 - an unknown stream replays as empty
            logger.debug("no events for task %s", task_id, exc_info=True)
            return []

    def raw_events(self, task_id: str, after_seq: Optional[int]) -> list[Any]:
        """Untranslated envelopes, for the trace surface only."""
        return self._events_after(task_id, after_seq)


def sse_frame(event: UIEvent) -> str:
    """One UI event as SSE wire bytes.

    Hand-written rather than taken from a library for two reasons the format
    depends on: the field separator is `": "` exactly, and a frame whose `seq`
    is `None` carries **no `id:` line**. With an id, the client's resume cursor
    would advance past envelopes it never received, and a reconnect would skip
    them forever — silent, permanent loss. Omitting it makes that a property of
    the format instead of a class of bug.
    """
    head = f"id: {event.seq}\n" if event.seq is not None else ""
    body = json.dumps(event.data, ensure_ascii=False)
    return f"{head}event: {event.type}\ndata: {body}\n\n"
