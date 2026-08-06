"""What handlers reach for: the process resources, and the two lookups that
turn a path parameter into a row or a 404.

Plain functions over `request.app.state` rather than FastAPI `Depends`: the
resources are process-lived singletons with no per-request setup, and a
dependency would add an injection layer whose only job is reading an attribute.
"""
from __future__ import annotations

import sqlite3

from fastapi import Request

from noeta.agent.api.errors import APIError, not_found
from noeta.agent.config import Settings
from noeta.agent.host.client import AgentHost
from noeta.agent.host.hub import EventHub
from noeta.agent.store import projects, sessions


def settings_of(request: Request) -> Settings:
    return request.app.state.settings


def db_of(request: Request) -> sqlite3.Connection:
    return request.app.state.db


def hub_of(request: Request) -> EventHub:
    """The event hub, or a 503 when the engine half was never installed.

    Not an assertion: the API surface is mounted by the application factory
    and the engine runtime by the lifespan, so a misconfigured boot has to
    answer *something* rather than raising `AttributeError` inside every
    handler."""
    hub = getattr(request.app.state, "hub", None)
    if hub is None:
        raise APIError(503, "engine_unavailable", "the engine host is not running")
    return hub


def host_of(request: Request) -> AgentHost:
    host = getattr(request.app.state, "host", None)
    if host is None:
        raise APIError(503, "engine_unavailable", "the engine host is not running")
    return host


def require_project(conn: sqlite3.Connection, project_id: str) -> projects.Project:
    project = projects.get_project(conn, project_id)
    if project is None:
        raise not_found("project", project_id)
    return project


def require_session(conn: sqlite3.Connection, session_id: str) -> sessions.Session:
    session = sessions.get_session(conn, session_id)
    if session is None:
        raise not_found("session", session_id)
    return session


def workspace_root(conn: sqlite3.Connection, session_id: str) -> str:
    """The project directory a session's file surface reads and writes.

    All sessions of a project share the project directory as their workspace
    root, so this resolves session -> project -> directory. Raises the same
    404s as the two `require_*` lookups it composes."""
    session = require_session(conn, session_id)
    return require_project(conn, session.project_id).directory
