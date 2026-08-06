"""Projects and their MCP connectors.

A Project is one directory on disk plus the configuration the agent brings to
it. The directory is the identity that matters: it is the workspace root every
session in the project shares, the key the execution tier is resolved by, and
therefore **unique** — a second project on the same directory is a conflict,
not a duplicate (see `CONTEXT.md` for the Project/Session vocabulary).

Credentials live in this module's tables and nowhere else. That is enforced by
the return types rather than by discipline: everything an API handler can
reach returns `ConnectorView`, which has `header_names` / `env_names` and no
field capable of carrying a value. The one function that returns the secrets is
`resolve_connector`, named after the single caller that needs them — the MCP
resolver, which hands a connect spec to the SDK and never to the wire.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from noeta.agent.store import db
from noeta.agent.store.errors import (
    DuplicateAliasError,
    DuplicateDirectoryError,
    InvalidDirectoryError,
    UnknownProjectError,
)

# The execution tiers, in the wire contract's vocabulary. `local` is the
# default everywhere: a project must opt in to the container, never inherit it.
TIERS = ("local", "sandbox")

TRANSPORTS = ("http", "stdio")

# The composite token an MCP alias is addressed by outside its project.
# `mcp_server_resolver` is a single global callback that receives only a token,
# so the token has to carry the scope; the project id is that scope. The
# resolved spec always carries the CLEAN alias — the token never reaches the
# model, which sees `mcp__<alias>__<tool>`.
_TOKEN_SEPARATOR = ":"

_PROJECT_COLUMNS = """
    id, name, directory, tier, persona, default_model, default_effort,
    memory_enabled, version, created_at, updated_at
"""

_CONNECTOR_COLUMNS = """
    project_id, alias, transport, url, argv, headers, env, tool_subset,
    enabled, created_at, updated_at
"""


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    # Absolute and realpath-normalized, so it compares equal to any other
    # spelling of the same directory.
    directory: str
    tier: str
    persona: str
    default_model: str
    default_effort: str
    memory_enabled: bool
    # Bumped on every update. Monotonic per row, which is what lets an
    # optimistic client resolve last-writer-wins by version rather than by
    # arrival order.
    version: int
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class ConnectorView:
    """A connector as every API read path sees it: credential NAMES only.

    There is deliberately no `headers` / `env` field. A handler cannot leak a
    secret it was never handed, so the scrubbing cannot be forgotten at a call
    site — which is the failure mode a `scrub=True` flag would still allow."""

    project_id: str
    alias: str
    transport: str
    url: str
    argv: tuple[str, ...]
    header_names: tuple[str, ...]
    env_names: tuple[str, ...]
    tool_subset: tuple[str, ...]
    enabled: bool
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class Connector:
    """A connector WITH its credentials, for the MCP resolver only.

    Never serialize this. `view()` is the projection everything else takes."""

    project_id: str
    alias: str
    transport: str
    url: str
    argv: tuple[str, ...]
    headers: Mapping[str, str]
    env: Mapping[str, str]
    # Empty means "every tool the server offers"; a non-empty subset is the
    # allowlist.
    tool_subset: tuple[str, ...]
    enabled: bool
    created_at: float
    updated_at: float

    def view(self) -> ConnectorView:
        return ConnectorView(
            project_id=self.project_id,
            alias=self.alias,
            transport=self.transport,
            url=self.url,
            argv=self.argv,
            header_names=tuple(sorted(self.headers)),
            env_names=tuple(sorted(self.env)),
            tool_subset=self.tool_subset,
            enabled=self.enabled,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


# ---------------------------------------------------------------------------
# Directory normalization
# ---------------------------------------------------------------------------


def normalize_directory(directory: str | Path) -> str:
    """The canonical spelling of a project directory, or raise.

    `~` is expanded first, so `~/work` is a valid answer to "which directory";
    anything still relative afterwards is rejected rather than resolved against
    whatever the process's working directory happens to be. `realpath` then
    collapses symlinks and `..`, which is what makes two spellings of one
    directory collide on the UNIQUE index instead of quietly becoming two
    projects sharing a workspace.

    The directory need not exist: a project may be created against a directory
    the API is about to make."""
    text = str(directory).strip()
    if not text:
        raise InvalidDirectoryError("a project directory cannot be empty")
    expanded = os.path.expanduser(text)
    if not os.path.isabs(expanded):
        raise InvalidDirectoryError(f"a project directory must be absolute: {text}")
    return os.path.realpath(expanded)


def _probe_directory(directory: str | Path) -> str | None:
    """`normalize_directory` for lookups: total, never raising.

    The by-directory read is the execution-tier decision, called inside
    `seed_start` on every turn. It answers "no project" for anything it cannot
    normalize, because a miss degrades to the safe default while an exception
    on a hot engine path does not."""
    try:
        return normalize_directory(directory)
    except (InvalidDirectoryError, OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


def _project(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        name=row["name"],
        directory=row["directory"],
        tier=row["tier"],
        persona=row["persona"],
        default_model=row["default_model"],
        default_effort=row["default_effort"],
        memory_enabled=bool(row["memory_enabled"]),
        version=int(row["version"]),
        created_at=float(row["created_at"]),
        updated_at=float(row["updated_at"]),
    )


def _require_tier(tier: str) -> str:
    if tier not in TIERS:
        raise ValueError(f"unknown execution tier: {tier!r}")
    return tier


def create_project(
    conn: sqlite3.Connection,
    *,
    name: str,
    directory: str | Path,
    tier: str = "local",
    persona: str = "",
    default_model: str = "",
    default_effort: str = "",
    memory_enabled: bool = False,
) -> Project:
    """Create a project. Raises on a relative or already-claimed directory.

    The conflict is detected by the UNIQUE index rather than by a preceding
    SELECT, so two concurrent creations of the same directory cannot both pass
    a check and then both insert."""
    normalized = normalize_directory(directory)
    _require_tier(tier)
    now = time.time()
    project_id = uuid.uuid4().hex
    with db.writing(conn) as tx:
        try:
            tx.execute(
                f"INSERT INTO projects ({_PROJECT_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (
                    project_id,
                    name,
                    normalized,
                    tier,
                    persona,
                    default_model,
                    default_effort,
                    int(memory_enabled),
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise DuplicateDirectoryError(normalized) from exc
        row = tx.execute(
            f"SELECT {_PROJECT_COLUMNS} FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
    return _project(row)


def get_project(conn: sqlite3.Connection, project_id: str) -> Project | None:
    with db.reading(conn) as tx:
        row = tx.execute(
            f"SELECT {_PROJECT_COLUMNS} FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
    return _project(row) if row else None


def list_projects(conn: sqlite3.Connection) -> list[Project]:
    """Newest first, with the id as a tiebreak so the order is total even when
    two projects share a timestamp."""
    with db.reading(conn) as tx:
        rows = tx.execute(
            f"SELECT {_PROJECT_COLUMNS} FROM projects "
            "ORDER BY created_at DESC, id DESC"
        ).fetchall()
    return [_project(row) for row in rows]


def find_project_by_directory(
    conn: sqlite3.Connection, directory: str | Path
) -> Project | None:
    """The project owning a directory, by exact match on the normalized path.

    Cheap (one index probe on the UNIQUE column), total (any unusable input is
    a miss, not an exception) and deterministic (both sides go through the same
    `realpath` normalization). It has to be all three: the execution tier is
    keyed on `workspace_dir` because the root task id does not exist yet at the
    moment the policy is asked, and the policy is asked inside `seed_start`."""
    normalized = _probe_directory(directory)
    if normalized is None:
        return None
    with db.reading(conn) as tx:
        row = tx.execute(
            f"SELECT {_PROJECT_COLUMNS} FROM projects WHERE directory = ?",
            (normalized,),
        ).fetchone()
    return _project(row) if row else None


def update_project(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    name: str | None = None,
    tier: str | None = None,
    persona: str | None = None,
    default_model: str | None = None,
    default_effort: str | None = None,
    memory_enabled: bool | None = None,
) -> Project | None:
    """Patch a project and bump its version. `None` means "leave alone".

    The directory is not patchable: it is the project's identity, the workspace
    root of every session already held against it, and the key the tier of
    every live task was resolved by. Changing it would silently re-point all
    three.

    Changing `tier` affects sessions created afterwards only — the tier is
    welded into `TaskHostBound` at `seed_start`, and every later turn resolves
    it from there."""
    if tier is not None:
        _require_tier(tier)
    assignments: list[str] = []
    values: list[object] = []
    for column, value in (
        ("name", name),
        ("tier", tier),
        ("persona", persona),
        ("default_model", default_model),
        ("default_effort", default_effort),
        ("memory_enabled", None if memory_enabled is None else int(memory_enabled)),
    ):
        if value is not None:
            assignments.append(f"{column} = ?")
            values.append(value)
    if not assignments:
        # Nothing to change: no write, and therefore no version bump. A caller
        # polling with an empty patch must not make every other client's
        # cached row look stale.
        return get_project(conn, project_id)

    row = db.patch_row(
        conn,
        table="projects",
        id_column="id",
        row_id=project_id,
        columns=_PROJECT_COLUMNS,
        assignments=assignments,
        values=values,
    )
    return _project(row) if row else None


def delete_project(conn: sqlite3.Connection, project_id: str) -> bool:
    """Delete a project and everything held against it.

    Its sessions, their task streams and its connectors go with it through
    `ON DELETE CASCADE`. The engine's event log is deliberately untouched: the
    conversations stay readable through the trace surface, which is the same
    split session deletion has."""
    with db.writing(conn) as tx:
        cursor = tx.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    return cursor.rowcount > 0


def project_exists(conn: sqlite3.Connection, project_id: str) -> bool:
    with db.reading(conn) as tx:
        row = tx.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# MCP connectors
# ---------------------------------------------------------------------------


def _dump_map(value: Mapping[str, str] | None) -> str:
    return json.dumps(dict(value or {}), sort_keys=True, ensure_ascii=False)


def _dump_seq(value: Iterable[str] | None) -> str:
    return json.dumps(list(value or ()), ensure_ascii=False)


def _connector(row: sqlite3.Row) -> Connector:
    return Connector(
        project_id=row["project_id"],
        alias=row["alias"],
        transport=row["transport"],
        url=row["url"],
        argv=tuple(json.loads(row["argv"])),
        headers=dict(json.loads(row["headers"])),
        env=dict(json.loads(row["env"])),
        tool_subset=tuple(json.loads(row["tool_subset"])),
        enabled=bool(row["enabled"]),
        created_at=float(row["created_at"]),
        updated_at=float(row["updated_at"]),
    )


def _validate_connector(transport: str, url: str, argv: Iterable[str]) -> None:
    if transport not in TRANSPORTS:
        raise ValueError(f"unknown MCP transport: {transport!r}")
    if transport == "http" and not url:
        raise ValueError("an http connector needs a url")
    if transport == "stdio" and not list(argv):
        raise ValueError("a stdio connector needs an argv")


def create_connector(
    conn: sqlite3.Connection,
    project_id: str,
    alias: str,
    *,
    transport: str,
    url: str = "",
    argv: Iterable[str] = (),
    headers: Mapping[str, str] | None = None,
    env: Mapping[str, str] | None = None,
    tool_subset: Iterable[str] = (),
    enabled: bool = True,
) -> ConnectorView:
    """Add a connector to a project. Returns the scrubbed view.

    `tool_subset` empty means every tool the server offers; a non-empty one is
    an allowlist."""
    # Materialized before validation: an iterable argument is allowed to be a
    # generator, and validating one would consume it before it is stored.
    argv = tuple(argv)
    tool_subset = tuple(tool_subset)
    _validate_connector(transport, url, argv)
    if not alias:
        raise ValueError("a connector needs an alias")
    now = time.time()
    with db.writing(conn) as tx:
        if not tx.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_id,)
        ).fetchone():
            raise UnknownProjectError(project_id)
        try:
            tx.execute(
                f"INSERT INTO mcp_connectors ({_CONNECTOR_COLUMNS}) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    project_id,
                    alias,
                    transport,
                    url,
                    _dump_seq(argv),
                    _dump_map(headers),
                    _dump_map(env),
                    _dump_seq(tool_subset),
                    int(enabled),
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise DuplicateAliasError(project_id, alias) from exc
        row = tx.execute(
            f"SELECT {_CONNECTOR_COLUMNS} FROM mcp_connectors "
            "WHERE project_id = ? AND alias = ?",
            (project_id, alias),
        ).fetchone()
    return _connector(row).view()


def list_connectors(conn: sqlite3.Connection, project_id: str) -> list[ConnectorView]:
    """Every connector of a project, scrubbed, in alias order."""
    with db.reading(conn) as tx:
        rows = tx.execute(
            f"SELECT {_CONNECTOR_COLUMNS} FROM mcp_connectors "
            "WHERE project_id = ? ORDER BY alias",
            (project_id,),
        ).fetchall()
    return [_connector(row).view() for row in rows]


def get_connector(
    conn: sqlite3.Connection, project_id: str, alias: str
) -> ConnectorView | None:
    """One connector, scrubbed."""
    raw = resolve_connector(conn, project_id, alias)
    return raw.view() if raw else None


def update_connector(
    conn: sqlite3.Connection,
    project_id: str,
    alias: str,
    *,
    transport: str | None = None,
    url: str | None = None,
    argv: Iterable[str] | None = None,
    headers: Mapping[str, str] | None = None,
    env: Mapping[str, str] | None = None,
    tool_subset: Iterable[str] | None = None,
    enabled: bool | None = None,
) -> ConnectorView | None:
    """Patch a connector; `None` means "leave alone".

    `headers` and `env` replace wholesale rather than merging — a merge can
    only ever add a credential, so there would be no way to remove one."""
    with db.writing(conn) as tx:
        row = tx.execute(
            f"SELECT {_CONNECTOR_COLUMNS} FROM mcp_connectors "
            "WHERE project_id = ? AND alias = ?",
            (project_id, alias),
        ).fetchone()
        if row is None:
            return None
        current = _connector(row)
        merged_transport = transport if transport is not None else current.transport
        merged_url = url if url is not None else current.url
        merged_argv = tuple(argv) if argv is not None else current.argv
        _validate_connector(merged_transport, merged_url, merged_argv)
        tx.execute(
            "UPDATE mcp_connectors SET transport = ?, url = ?, argv = ?, "
            "headers = ?, env = ?, tool_subset = ?, enabled = ?, updated_at = ? "
            "WHERE project_id = ? AND alias = ?",
            (
                merged_transport,
                merged_url,
                _dump_seq(merged_argv),
                _dump_map(headers if headers is not None else current.headers),
                _dump_map(env if env is not None else current.env),
                _dump_seq(tool_subset if tool_subset is not None else current.tool_subset),
                int(enabled if enabled is not None else current.enabled),
                time.time(),
                project_id,
                alias,
            ),
        )
        fresh = tx.execute(
            f"SELECT {_CONNECTOR_COLUMNS} FROM mcp_connectors "
            "WHERE project_id = ? AND alias = ?",
            (project_id, alias),
        ).fetchone()
    return _connector(fresh).view()


def delete_connector(conn: sqlite3.Connection, project_id: str, alias: str) -> bool:
    with db.writing(conn) as tx:
        cursor = tx.execute(
            "DELETE FROM mcp_connectors WHERE project_id = ? AND alias = ?",
            (project_id, alias),
        )
    return cursor.rowcount > 0


def resolve_connector(
    conn: sqlite3.Connection, project_id: str, alias: str
) -> Connector | None:
    """A connector WITH its credentials. For the MCP resolver, not the wire."""
    with db.reading(conn) as tx:
        row = tx.execute(
            f"SELECT {_CONNECTOR_COLUMNS} FROM mcp_connectors "
            "WHERE project_id = ? AND alias = ?",
            (project_id, alias),
        ).fetchone()
    return _connector(row) if row else None


def connector_token(project_id: str, alias: str) -> str:
    """The scoped token an alias is addressed by outside its project."""
    return f"{project_id}{_TOKEN_SEPARATOR}{alias}"


def enabled_connector_tokens(
    conn: sqlite3.Connection, project_id: str
) -> tuple[str, ...]:
    """The sorted tokens of a project's ENABLED connectors.

    Computed once per turn at seed time, which is what makes a config edit
    apply from the next turn rather than mid-turn. A project with no store
    rows yields `()`, which is byte-identical to a deployment with no MCP at
    all — degrading to "no MCP" is the required failure mode, never a sunk
    turn."""
    with db.reading(conn) as tx:
        rows = tx.execute(
            "SELECT alias FROM mcp_connectors "
            "WHERE project_id = ? AND enabled = 1 ORDER BY alias",
            (project_id,),
        ).fetchall()
    return tuple(connector_token(project_id, row["alias"]) for row in rows)


def resolve_connector_token(conn: sqlite3.Connection, token: str) -> Connector | None:
    """A scoped token back to its connector, or `None`.

    Total by design: malformed, unknown, disabled and wrong-scope tokens all
    answer `None` rather than raising. The resolver is a callback the engine
    invokes while assembling a turn, and one bad token must skip one server
    instead of sinking the turn. The alias is split on the FIRST separator, so
    an alias containing one survives the round trip."""
    project_id, separator, alias = token.partition(_TOKEN_SEPARATOR)
    if not separator or not project_id or not alias:
        return None
    connector = resolve_connector(conn, project_id, alias)
    if connector is None or not connector.enabled:
        return None
    return connector
