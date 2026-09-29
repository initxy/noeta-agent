"""SQLite plumbing for `app.db`: one connection factory, one schema bootstrap,
one lock that serializes access to the shared connection.

The connection is shared across threads (`check_same_thread=False`) because
the engine drives turns on worker threads while requests arrive on the event
loop; WAL plus a busy timeout is what makes that survive concurrent readers.
Autocommit (`isolation_level=None`) keeps transaction boundaries explicit
instead of implicit-and-surprising.

Migrations are a plain ordered list applied inside one transaction each, with
the applied versions recorded in `schema_version`. `bootstrap` is idempotent:
running it against an up-to-date database does nothing.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

logger = logging.getLogger(__name__)

# One migration: a version and the statements that take the schema to it.
# Statements are executed one at a time on purpose — `executescript` issues an
# implicit COMMIT and would silently break the surrounding transaction.
Migration = tuple[int, tuple[str, ...]]

_SCHEMA_VERSION_DDL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at REAL NOT NULL
)
"""

# --- migration 1: the product tables -------------------------------------
#
# Timestamps are REAL unix epoch seconds throughout: one representation, no
# parsing, and comparable in SQL. `version` is the monotonic per-row counter
# the optimistic-mutation protocol resolves last-writer-wins by; every UPDATE
# in projects.py / sessions.py carries `version = version + 1` in the same
# statement, so it cannot be bumped out of step with the change it describes.
#
# The CHECK constraints duplicate validation the Python layer already does.
# They are the backstop, not the gate: a column whose vocabulary is fixed by
# the wire contract should not be able to hold anything else even if a future
# caller forgets.

_PROJECTS_DDL = """
CREATE TABLE projects (
    id             TEXT    PRIMARY KEY,
    name           TEXT    NOT NULL,
    -- Absolute and realpath-normalized. UNIQUE gives the implicit index that
    -- makes the by-directory lookup an exact-match index probe: it is on the
    -- hot path because the execution tier is keyed on `workspace_dir` and
    -- resolved inside `seed_start`.
    directory      TEXT    NOT NULL UNIQUE,
    tier           TEXT    NOT NULL CHECK (tier IN ('local', 'sandbox')),
    persona        TEXT    NOT NULL DEFAULT '',
    default_model  TEXT    NOT NULL DEFAULT '',
    default_effort TEXT    NOT NULL DEFAULT '',
    memory_enabled INTEGER NOT NULL DEFAULT 0,
    version        INTEGER NOT NULL DEFAULT 1,
    created_at     REAL    NOT NULL,
    updated_at     REAL    NOT NULL
)
"""

# Credentials live here and nowhere else. `headers` and `env` hold secret
# VALUES; every read path an API handler can reach returns a `ConnectorView`,
# which has no field to leak them through (projects.py).
_MCP_CONNECTORS_DDL = """
CREATE TABLE mcp_connectors (
    project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    alias       TEXT    NOT NULL,
    transport   TEXT    NOT NULL CHECK (transport IN ('http', 'stdio')),
    url         TEXT    NOT NULL DEFAULT '',
    argv        TEXT    NOT NULL DEFAULT '[]',
    headers     TEXT    NOT NULL DEFAULT '{}',
    env         TEXT    NOT NULL DEFAULT '{}',
    tool_subset TEXT    NOT NULL DEFAULT '[]',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  REAL    NOT NULL,
    updated_at  REAL    NOT NULL,
    -- Leading `project_id` makes this composite key the per-project index too.
    PRIMARY KEY (project_id, alias)
)
"""

# `status` is the wire contract's session vocabulary, persisted here; the
# status MACHINE lives with the event hub and calls in. `last_seq` is an
# activity high-water mark (the highest seq seen on ANY of this session's
# streams), never a replay cursor — each task stream counts `seq` from 0
# independently, so a session-wide cursor would be meaningless.
#
# The lineage columns (`parent_session_id`, `source_task_id`, `branched_at_seq`)
# are added by migration 2, not here: migration 1 has shipped and is never
# edited. See `_SESSIONS_LINEAGE_DDL` for what they mean and why one is a
# foreign key and one deliberately is not.
_SESSIONS_DDL = """
CREATE TABLE sessions (
    id              TEXT    PRIMARY KEY,
    project_id      TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT    NOT NULL DEFAULT '',
    title_generated INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'idle'
                            CHECK (status IN ('idle', 'running', 'waiting')),
    pinned          INTEGER NOT NULL DEFAULT 0,
    archived        INTEGER NOT NULL DEFAULT 0,
    last_seq        INTEGER NOT NULL DEFAULT -1,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      REAL    NOT NULL,
    updated_at      REAL    NOT NULL
)
"""

_SESSIONS_BY_PROJECT_DDL = """
CREATE INDEX sessions_by_project ON sessions (project_id, created_at DESC)
"""

# A session owns one OR MORE task streams: `fork` appends a sibling stream to
# the same session rather than minting a new session. `task_id` is the primary
# key, which is both the uniqueness rule (an engine task belongs to exactly one
# session) and the reverse index the memory-root and container-id resolvers
# probe from engine threads.
_SESSION_TASK_STREAMS_DDL = """
CREATE TABLE session_task_streams (
    task_id         TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('root', 'branch')),
    source_task_id  TEXT,
    branched_at_seq INTEGER,
    created_at      REAL NOT NULL
)
"""

_TASK_STREAMS_BY_SESSION_DDL = """
CREATE INDEX task_streams_by_session ON session_task_streams (session_id, created_at)
"""

# --- migration 2: session lineage (fork becomes a child session) ---------
#
# `fork` no longer appends a sibling stream to the same session; it mints a NEW
# session (a child) and binds the forked task as that child's own `root`
# stream. These three columns, all NULL on an ordinary session, record the
# parentage. `fork` is their only writer.
#
# - `parent_session_id` is the sidebar-nesting link, and a foreign key with
#   ON DELETE SET NULL: deleting a parent de-nests its children rather than
#   cascading into them.
# - `source_task_id` is the parent *stream* the child descends from, and is
#   deliberately NOT a foreign key. The parent session row can be deleted while
#   its event log survives (`delete_session` leaves envelopes intact), and the
#   child replays its inherited history from that log — a foreign key would
#   forbid the row from outliving the parent it points at.
# - `branched_at_seq` bounds the inherited prefix (frames at or before it) and
#   drives the "forked at message N" copy.
#
# SQLite allows ADD COLUMN with a REFERENCES clause only when the column's
# default is NULL, which every nullable column here is.
_SESSIONS_LINEAGE_DDL = (
    "ALTER TABLE sessions ADD COLUMN parent_session_id TEXT "
    "REFERENCES sessions(id) ON DELETE SET NULL",
    "ALTER TABLE sessions ADD COLUMN source_task_id TEXT",
    "ALTER TABLE sessions ADD COLUMN branched_at_seq INTEGER",
)

# The sidebar reads children by parent; the index keeps that a probe rather
# than a scan. Partial (the column is NULL on every unforked session, which is
# almost all of them), so it costs nothing on the common row.
_SESSIONS_BY_PARENT_DDL = """
CREATE INDEX sessions_by_parent ON sessions (parent_session_id)
WHERE parent_session_id IS NOT NULL
"""

_MIGRATIONS: tuple[Migration, ...] = (
    (
        1,
        (
            _PROJECTS_DDL,
            _MCP_CONNECTORS_DDL,
            _SESSIONS_DDL,
            _SESSIONS_BY_PROJECT_DDL,
            _SESSION_TASK_STREAMS_DDL,
            _TASK_STREAMS_BY_SESSION_DDL,
        ),
    ),
    (
        2,
        (
            *_SESSIONS_LINEAGE_DDL,
            _SESSIONS_BY_PARENT_DDL,
        ),
    ),
)


# ---------------------------------------------------------------------------
# Serializing the shared connection
# ---------------------------------------------------------------------------

# One process runs one `app.db` and opens exactly one connection to it, so a
# process-wide lock and a per-connection lock are the same thing here — and a
# per-connection registry cannot be built anyway: `sqlite3.Connection` is
# neither weak-referenceable nor attributable, so keying one would leak an
# entry per connection for the life of the process.
#
# The lock is not about corruption (SQLite is serialized internally). It is
# about the two things sharing ONE connection across threads actually breaks:
#
# - `BEGIN IMMEDIATE` while another thread's transaction is open raises
#   "cannot start a transaction within a transaction" — the connection has one
#   transaction, not one per thread;
# - a read issued between another thread's INSERT and its COMMIT sees that
#   thread's uncommitted rows, because it is the same connection.
#
# Reads take the lock for the second reason. Every operation is a handful of
# indexed statements, so the contention this trades away is not real.
_ACCESS_LOCK = threading.RLock()


@contextmanager
def reading(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Serialized read access. No transaction: SELECTs autocommit."""
    with _ACCESS_LOCK:
        yield conn


def patch_row(
    conn: sqlite3.Connection,
    *,
    table: str,
    id_column: str,
    row_id: str,
    columns: str,
    assignments: list[str],
    values: list[object],
) -> sqlite3.Row | None:
    """Apply a version-bumping patch and return the fresh row, or None.

    The shared shape behind every optimistic-mutation UPDATE (projects.py /
    sessions.py): each caller builds `assignments` (SQL fragments like
    ``"name = ?"`` or ``"last_seq = MAX(last_seq, ?)"``) and the matching
    `values`; this owns the invariant tail that must not vary per site —
    ``version = version + 1, updated_at = ?`` in the same statement (so the
    counter cannot bump out of step with the change it describes), the
    rowcount-zero -> None guard, and the re-SELECT of `columns`.

    An **empty** patch is the caller's problem, not this function's: no
    assignments means there is nothing to write and therefore no version bump,
    and the caller returns its own getter so an empty patch never makes another
    client's cached row look stale. Callers guard that before calling.
    """
    with writing(conn) as tx:
        cursor = tx.execute(
            f"UPDATE {table} SET {', '.join(assignments)}, "
            f"version = version + 1, updated_at = ? WHERE {id_column} = ?",
            (*values, time.time(), row_id),
        )
        if cursor.rowcount == 0:
            return None
        return tx.execute(
            f"SELECT {columns} FROM {table} WHERE {id_column} = ?", (row_id,)
        ).fetchone()


@contextmanager
def writing(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Serialized write access inside one `BEGIN IMMEDIATE` transaction.

    IMMEDIATE rather than DEFERRED so the write lock is taken up front and a
    busy database fails at the top instead of half way through. The block is
    all-or-nothing: any exception rolls back, so a multi-statement write can
    never leave a half-written row for the next reader."""
    with _ACCESS_LOCK:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


# ---------------------------------------------------------------------------
# Connection and schema
# ---------------------------------------------------------------------------


def connect(db_path: Path) -> sqlite3.Connection:
    """Open (creating the file and its parent directory) the app database."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False, isolation_level=None)
    # Dict-like rows: callers read columns by name, so appending a column
    # never shifts a positional index out from under them.
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    # Load-bearing, not hygiene: deleting a project relies on ON DELETE CASCADE
    # to take its sessions, task streams and connectors with it. SQLite
    # enforces foreign keys per connection, and defaults to OFF.
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    """The highest applied migration; 0 once bootstrapped and still empty.

    Requires the `schema_version` table to exist, so call it after `bootstrap`
    (which creates the table first thing and is the only entry point). On a
    connection that has never been bootstrapped it raises rather than reporting
    a version it cannot know."""
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def bootstrap(conn: sqlite3.Connection) -> int:
    """Bring the schema up to date and return the version it now sits at."""
    conn.execute(_SCHEMA_VERSION_DDL)
    current = schema_version(conn)
    for version, statements in _MIGRATIONS:
        if version <= current:
            continue
        with writing(conn) as tx:
            for statement in statements:
                tx.execute(statement)
            tx.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                (version, time.time()),
            )
        logger.info("app.db migrated to schema version %d", version)
        current = version
    return current
