"""Self-managed persistence (`app.db`): the product's own index — projects,
sessions, and the configuration attached to them.

The engine's event log lives in its own database (`noeta.db`) behind the SDK
storage adapters. The two are never mixed: every state change still flows
through the SDK's Client verbs, and the EventLog stays the single source of
truth. What lands here is an index over it, never a copy of it.

The index is not optional. The public SDK surface returns only
`(task_id, last_seq, last_event_time)` per stream — no status, no parent, no
workspace, and no fold to derive them from — so a host that groups turns into
a user-visible Session owns that concept itself.

The surface is plain functions taking the shared connection as their first
argument, so a caller holds nothing but `app.state.db`:

    from noeta.agent.store import projects, sessions

    project = projects.create_project(conn, name="site", directory="/srv/site")
    session = sessions.create_session(conn, project.id)

Every function serializes on one lock and every multi-statement write runs in
one transaction — see `db.writing` for why that is a requirement rather than
caution.
"""
from __future__ import annotations

from noeta.agent.store.errors import (
    DuplicateAliasError,
    DuplicateDirectoryError,
    DuplicateTaskStreamError,
    InvalidDirectoryError,
    StoreError,
    UnknownProjectError,
    UnknownSessionError,
)
from noeta.agent.store.projects import Connector, ConnectorView, Project
from noeta.agent.store.sessions import Session, TaskBinding, TaskStream

__all__ = [
    "Connector",
    "ConnectorView",
    "DuplicateAliasError",
    "DuplicateDirectoryError",
    "DuplicateTaskStreamError",
    "InvalidDirectoryError",
    "Project",
    "Session",
    "StoreError",
    "TaskBinding",
    "TaskStream",
    "UnknownProjectError",
    "UnknownSessionError",
]
