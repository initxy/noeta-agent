"""Sessions and the task streams they own.

A Session is the application-layer unit of conversation — what the sidebar
lists, resumes and deletes. It owns **one or more** task streams, which is why
there is no `task_id` column on the session row: `fork` appends a *sibling*
stream to the same session, so the relation is one-to-many from the first day
that verb exists. Collapsing it onto a single id would have to be undone the
moment branching ships (see `CONTEXT.md` for the vocabulary).

A session is created with zero task streams. The first message seeds the first
one, and `session_task_streams` is where that binding is recorded — in both
directions: forward for the session detail response, and backward for the
memory-root and container-id resolvers, which are handed a task id on an
engine thread and have to answer "whose is it".
"""
from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass

from noeta.agent.store import db
from noeta.agent.store.errors import (
    DuplicateTaskStreamError,
    UnknownProjectError,
    UnknownSessionError,
)

# The wire contract's session status vocabulary, in full. The store persists
# it; the machine that decides transitions lives with the event hub, because
# only the envelope stream knows them.
SESSION_STATUSES = ("idle", "running", "waiting")

# `root` is the stream the first message seeds; `branch` is what `fork` mints
# beside it. Both are streams of the same session.
TASK_STREAM_KINDS = ("root", "branch")

# What `last_seq` reads before anything has been observed. -1 rather than 0
# because 0 is a real seq — the first envelope of every stream — and
# `since_seq=0` is a full replay.
NO_SEQ = -1

_SESSION_COLUMNS = """
    id, project_id, title, title_generated, status, pinned, archived,
    last_seq, version, created_at, updated_at,
    parent_session_id, source_task_id, branched_at_seq
"""

_TASK_STREAM_COLUMNS = """
    task_id, session_id, kind, source_task_id, branched_at_seq, created_at
"""


@dataclass(frozen=True)
class Session:
    id: str
    project_id: str
    title: str
    # Set once, at the first turn boundary, by the title-generation thread.
    # Persisted so a second turn boundary cannot trigger a second LLM call.
    title_generated: bool
    status: str
    pinned: bool
    archived: bool
    # The highest seq observed on ANY of this session's streams: an activity
    # high-water mark, not a replay cursor. Each stream counts `seq` from 0
    # independently, so a session-wide cursor would be meaningless — the SSE
    # resume cursor is per stream and comes from the client.
    last_seq: int
    # Bumped on every update, including the ones engine threads make. Monotonic
    # per row, which is what lets an optimistic client resolve last-writer-wins
    # by version rather than by arrival order.
    version: int
    created_at: float
    updated_at: float
    # Lineage, set only by `fork` and NULL on every ordinary session. A fork is
    # a *child* session, not a sibling stream: `parent_session_id` is the
    # sidebar-nesting link (nulled if the parent is deleted), `source_task_id`
    # is the parent stream whose history the child inherits (kept even after the
    # parent row is gone, since the event log outlives it), and `branched_at_seq`
    # is the user-message seq the fork was taken at — the bound on the inherited
    # prefix and the "forked at message N" copy.
    parent_session_id: str | None = None
    source_task_id: str | None = None
    branched_at_seq: int | None = None


@dataclass(frozen=True)
class TaskStream:
    task_id: str
    session_id: str
    kind: str
    # Set on a branch: the stream it was forked from, and the user message it
    # was forked at. Both `None` on a root.
    source_task_id: str | None
    branched_at_seq: int | None
    created_at: float


@dataclass(frozen=True)
class SessionActivity:
    """One session's contribution to its project's sandbox-reap decision.

    Keyed on the project because that is what a container is named after
    (see `host/sandbox_provider.py`): all sessions of a project share one
    container, so the decision is a fold across them."""

    project_id: str
    status: str
    updated_at: float
    has_task_stream: bool


@dataclass(frozen=True)
class TaskBinding:
    """The reverse index: which session and project an engine task belongs to.

    Returned as one object because both callers want both fields — the memory
    root keys on the project id, the container name keys on the project, and
    neither has anything but a task id to start from."""

    task_id: str
    session_id: str
    project_id: str


def _session(row: sqlite3.Row) -> Session:
    return Session(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"],
        title_generated=bool(row["title_generated"]),
        status=row["status"],
        pinned=bool(row["pinned"]),
        archived=bool(row["archived"]),
        last_seq=int(row["last_seq"]),
        version=int(row["version"]),
        created_at=float(row["created_at"]),
        updated_at=float(row["updated_at"]),
        parent_session_id=row["parent_session_id"],
        source_task_id=row["source_task_id"],
        branched_at_seq=(
            None if row["branched_at_seq"] is None else int(row["branched_at_seq"])
        ),
    )


def _task_stream(row: sqlite3.Row) -> TaskStream:
    return TaskStream(
        task_id=row["task_id"],
        session_id=row["session_id"],
        kind=row["kind"],
        source_task_id=row["source_task_id"],
        branched_at_seq=(
            None if row["branched_at_seq"] is None else int(row["branched_at_seq"])
        ),
        created_at=float(row["created_at"]),
    )


def _require_status(status: str) -> str:
    if status not in SESSION_STATUSES:
        raise ValueError(f"unknown session status: {status!r}")
    return status


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def create_session(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    title: str = "",
    parent_session_id: str | None = None,
    source_task_id: str | None = None,
    branched_at_seq: int | None = None,
) -> Session:
    """Create a session with ZERO task streams.

    The engine task is minted by the first message, not here — a session the
    user opened and never wrote in must not cost a task, a workspace binding
    or a container.

    The lineage arguments are set only by `fork`, which creates a child session
    and then binds the forked task as its root stream. They travel together: a
    child carries all three, an ordinary session none. `parent_session_id` is
    not validated to exist here — the caller (`host.fork`) has already resolved
    the parent, and a stale id is harmless (it only de-nests the row)."""
    now = time.time()
    session_id = uuid.uuid4().hex
    with db.writing(conn) as tx:
        if not tx.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_id,)
        ).fetchone():
            raise UnknownProjectError(project_id)
        tx.execute(
            f"INSERT INTO sessions ({_SESSION_COLUMNS}) "
            "VALUES (?, ?, ?, 0, 'idle', 0, 0, ?, 1, ?, ?, ?, ?, ?)",
            (
                session_id,
                project_id,
                title,
                NO_SEQ,
                now,
                now,
                parent_session_id,
                source_task_id,
                branched_at_seq,
            ),
        )
        row = tx.execute(
            f"SELECT {_SESSION_COLUMNS} FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
    return _session(row)


def get_session(conn: sqlite3.Connection, session_id: str) -> Session | None:
    with db.reading(conn) as tx:
        row = tx.execute(
            f"SELECT {_SESSION_COLUMNS} FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
    return _session(row) if row else None


def list_sessions(
    conn: sqlite3.Connection, project_id: str, *, include_archived: bool = True
) -> list[Session]:
    """A project's sessions, newest first, with the id as a total tiebreak.

    Pinning is not an ordering here: pinned-first is a sidebar decision, and
    baking it in would leave the API unable to render any other view."""
    clause = "" if include_archived else " AND archived = 0"
    with db.reading(conn) as tx:
        rows = tx.execute(
            f"SELECT {_SESSION_COLUMNS} FROM sessions WHERE project_id = ?{clause} "
            "ORDER BY created_at DESC, id DESC",
            (project_id,),
        ).fetchall()
    return [_session(row) for row in rows]


def update_session(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    title: str | None = None,
    title_generated: bool | None = None,
    pinned: bool | None = None,
    archived: bool | None = None,
) -> Session | None:
    """Patch the user-owned fields of a session and bump its version.

    `status` and `last_seq` are deliberately absent: they are derived from the
    envelope stream, and `advance_session` is the one door they come through."""
    assignments: list[str] = []
    values: list[object] = []
    for column, value in (
        ("title", title),
        ("title_generated", None if title_generated is None else int(title_generated)),
        ("pinned", None if pinned is None else int(pinned)),
        ("archived", None if archived is None else int(archived)),
    ):
        if value is not None:
            assignments.append(f"{column} = ?")
            values.append(value)
    if not assignments:
        # Nothing to change: no write, and therefore no version bump. An empty
        # patch must not make every other client's cached row look stale.
        return get_session(conn, session_id)

    row = db.patch_row(
        conn,
        table="sessions",
        id_column="id",
        row_id=session_id,
        columns=_SESSION_COLUMNS,
        assignments=assignments,
        values=values,
    )
    return _session(row) if row else None


def advance_session(
    conn: sqlite3.Connection,
    session_id: str,
    *,
    status: str | None = None,
    last_seq: int | None = None,
) -> Session | None:
    """Record what the envelope stream just said about a session.

    Called from engine worker threads — the post-commit subscription fires
    there — while HTTP requests read the same row, which is the whole reason
    every statement in this module is serialized (see `db.writing`).

    `last_seq` only ever advances: `MAX(last_seq, ?)`. Envelopes are committed
    by workers with no ordering guarantee between them, so a late arrival must
    not rewind the high-water mark that tells the sidebar this session has new
    activity.

    Absorbing terminal state is NOT enforced here. It is per *task* and the
    store's status is per *session*, so the rule lives with the machine that
    knows which task an envelope came from; this function stores what it is
    told."""
    if status is not None:
        _require_status(status)
    assignments: list[str] = []
    values: list[object] = []
    if status is not None:
        assignments.append("status = ?")
        values.append(status)
    if last_seq is not None:
        assignments.append("last_seq = MAX(last_seq, ?)")
        values.append(int(last_seq))
    if not assignments:
        return get_session(conn, session_id)

    row = db.patch_row(
        conn,
        table="sessions",
        id_column="id",
        row_id=session_id,
        columns=_SESSION_COLUMNS,
        assignments=assignments,
        values=values,
    )
    return _session(row) if row else None


def delete_session(conn: sqlite3.Connection, session_id: str) -> bool:
    """Delete a session; its task-stream bindings cascade with it.

    The engine's event log is deliberately untouched — the raw envelopes stay
    readable through the trace surface after the session is gone."""
    with db.writing(conn) as tx:
        cursor = tx.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return cursor.rowcount > 0


# ---------------------------------------------------------------------------
# Task streams
# ---------------------------------------------------------------------------


def add_task_stream(
    conn: sqlite3.Connection,
    session_id: str,
    task_id: str,
    *,
    kind: str = "root",
    source_task_id: str | None = None,
    branched_at_seq: int | None = None,
) -> TaskStream:
    """Bind an engine task to a session, as a root stream or a branch.

    Atomic with the session's version bump: the session detail response lists
    its streams, so a client that read the session between the two writes would
    see a version it could not distinguish from the older state."""
    if kind not in TASK_STREAM_KINDS:
        raise ValueError(f"unknown task stream kind: {kind!r}")
    if kind == "branch" and not source_task_id:
        raise ValueError("a branch needs the task stream it was forked from")
    if kind == "root" and source_task_id:
        raise ValueError("a root stream has no source task")

    now = time.time()
    with db.writing(conn) as tx:
        if not tx.execute(
            "SELECT 1 FROM sessions WHERE id = ?", (session_id,)
        ).fetchone():
            raise UnknownSessionError(session_id)
        try:
            tx.execute(
                f"INSERT INTO session_task_streams ({_TASK_STREAM_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (task_id, session_id, kind, source_task_id, branched_at_seq, now),
            )
        except sqlite3.IntegrityError as exc:
            raise DuplicateTaskStreamError(task_id) from exc
        tx.execute(
            "UPDATE sessions SET version = version + 1, updated_at = ? WHERE id = ?",
            (now, session_id),
        )
        row = tx.execute(
            f"SELECT {_TASK_STREAM_COLUMNS} FROM session_task_streams "
            "WHERE task_id = ?",
            (task_id,),
        ).fetchone()
    return _task_stream(row)


def list_task_streams(conn: sqlite3.Connection, session_id: str) -> list[TaskStream]:
    """A session's streams, oldest first — the root, then its branches."""
    with db.reading(conn) as tx:
        rows = tx.execute(
            f"SELECT {_TASK_STREAM_COLUMNS} FROM session_task_streams "
            "WHERE session_id = ? ORDER BY created_at, task_id",
            (session_id,),
        ).fetchall()
    return [_task_stream(row) for row in rows]


def latest_task_stream(
    conn: sqlite3.Connection, session_id: str
) -> TaskStream | None:
    """The newest stream of a session, or `None` while it has none.

    What a message with no explicit `task_id` lands on: after a fork the client
    switches its filter to the branch, so the newest stream is the one the user
    is looking at."""
    with db.reading(conn) as tx:
        row = tx.execute(
            f"SELECT {_TASK_STREAM_COLUMNS} FROM session_task_streams "
            "WHERE session_id = ? ORDER BY created_at DESC, task_id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    return _task_stream(row) if row else None


def find_task_binding(conn: sqlite3.Connection, task_id: str) -> TaskBinding | None:
    """The reverse index: an engine task back to its session and project.

    Called from engine threads by the memory-root resolver and the container-id
    resolver, so it is total — an unknown task id is a miss, never an
    exception. A miss is what sends memory to the `_quarantine` pool, which is
    the point: better no recall than another project's.

    Only root and branch streams are bound here; a subtask id is unknown to
    this index by construction."""
    if not task_id:
        return None
    with db.reading(conn) as tx:
        row = tx.execute(
            "SELECT ts.task_id AS task_id, ts.session_id AS session_id, "
            "s.project_id AS project_id "
            "FROM session_task_streams ts JOIN sessions s ON s.id = ts.session_id "
            "WHERE ts.task_id = ?",
            (task_id,),
        ).fetchone()
    if row is None:
        return None
    return TaskBinding(
        task_id=row["task_id"],
        session_id=row["session_id"],
        project_id=row["project_id"],
    )


def sandbox_activity(conn: sqlite3.Connection) -> list[SessionActivity]:
    """One row per session of a `sandbox`-tier project — the reaper's read model.

    Flat on purpose: the *policy* (one busy session keeps the whole project's
    container alive; a session that never seeded a task stream contributes
    nothing) belongs with the reaper, and this is only the shape it folds. The
    tier filter is an optimisation — the reaper is total either way — but it
    keeps a machine with no sandbox project from folding every row it owns.
    """
    with db.reading(conn) as tx:
        rows = tx.execute(
            "SELECT s.project_id AS project_id, s.status AS status, "
            "s.updated_at AS updated_at, "
            "EXISTS(SELECT 1 FROM session_task_streams t "
            "       WHERE t.session_id = s.id) AS has_task_stream "
            "FROM sessions s JOIN projects p ON p.id = s.project_id "
            "WHERE p.tier = 'sandbox'"
        ).fetchall()
    return [
        SessionActivity(
            project_id=row["project_id"],
            status=row["status"],
            updated_at=float(row["updated_at"]),
            has_task_stream=bool(row["has_task_stream"]),
        )
        for row in rows
    ]
