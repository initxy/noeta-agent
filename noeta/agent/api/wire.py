"""Request bodies and response serializers for `/api/v1`.

One module so the wire shape is readable in one place. Two conventions, both
chosen to match what the frontend's `app/types/wire.ts` already declares:

- **timestamps are ISO-8601 UTC strings** on rows the UI renders (projects,
  sessions, task streams), because they are displayed and sorted, never
  arithmetic;
- **`mtime` is epoch seconds as a number** on the file surface, because it is
  the optimistic-lock token a save round-trips, and formatting it would make
  the comparison depend on the formatter.

Pydantic models here are *request* bodies only. Responses are plain dicts built
by the serializers below: a response model would re-validate rows that came
straight out of the store's own frozen dataclasses, and would silently drop a
field added there.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field

from noeta.agent.host import files as files_module
from noeta.agent.store import projects, sessions


def iso(timestamp: float) -> str:
    """Epoch seconds → an ISO-8601 UTC string with a `Z` suffix."""
    return (
        datetime.fromtimestamp(timestamp, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


class CreateProject(BaseModel):
    name: str = ""
    directory: str
    tier: str = "local"
    #: Create the directory when it is not there yet. Off by default: a typo
    #: in a path should read as "no such directory", not silently mint one.
    create_directory: bool = False


class UpdateProject(BaseModel):
    name: Optional[str] = None
    tier: Optional[str] = None
    persona: Optional[str] = None
    default_model: Optional[str] = None
    default_effort: Optional[str] = None
    memory_enabled: Optional[bool] = None


class AgentConfigBody(BaseModel):
    persona: Optional[str] = None
    default_model: Optional[str] = None
    default_effort: Optional[str] = None
    memory_enabled: Optional[bool] = None


class ConnectorBody(BaseModel):
    """A connector as it is written. The only direction credentials travel."""

    alias: str
    transport: str = "http"
    url: str = ""
    argv: list[str] = Field(default_factory=list)
    headers: dict[str, str] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    tool_subset: list[str] = Field(default_factory=list)
    enabled: bool = True


class ConnectorPatch(BaseModel):
    transport: Optional[str] = None
    url: Optional[str] = None
    argv: Optional[list[str]] = None
    headers: Optional[dict[str, str]] = None
    env: Optional[dict[str, str]] = None
    tool_subset: Optional[list[str]] = None
    enabled: Optional[bool] = None


def project_row(project: projects.Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "directory": project.directory,
        "tier": project.tier,
        "persona": project.persona,
        "default_model": project.default_model,
        "default_effort": project.default_effort,
        "memory_enabled": project.memory_enabled,
        "version": project.version,
        "created_at": iso(project.created_at),
        "updated_at": iso(project.updated_at),
    }


def agent_config(project: projects.Project) -> dict[str, Any]:
    return {
        "persona": project.persona,
        "default_model": project.default_model,
        "default_effort": project.default_effort,
        "memory_enabled": project.memory_enabled,
    }


def connector_row(connector: projects.ConnectorView) -> dict[str, Any]:
    """A connector as every read path sees it.

    There is no scrubbing step here because there is nothing to scrub: the
    store hands out a type that cannot carry a credential value, so a handler
    cannot leak one by forgetting."""
    return {
        "project_id": connector.project_id,
        "alias": connector.alias,
        "transport": connector.transport,
        "url": connector.url,
        "argv": list(connector.argv),
        "header_names": list(connector.header_names),
        "env_names": list(connector.env_names),
        "tool_subset": list(connector.tool_subset),
        "enabled": connector.enabled,
        "created_at": iso(connector.created_at),
        "updated_at": iso(connector.updated_at),
    }


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


class CreateSession(BaseModel):
    title: str = ""


class UpdateSession(BaseModel):
    title: Optional[str] = None
    pinned: Optional[bool] = None
    archived: Optional[bool] = None


class ImageInput(BaseModel):
    """One attachment. Exactly two fields reach the wire; the bytes go into
    the ContentStore and only their hash travels the event stream."""

    media_type: str
    data_base64: str


class SendMessage(BaseModel):
    text: str = ""
    images: list[ImageInput] = Field(default_factory=list)
    model: Optional[str] = None
    effort: Optional[str] = None
    skills: list[str] = Field(default_factory=list)
    #: Which stream to append to. Omitted means the session's current one,
    #: which is what every unforked session has.
    task_id: Optional[str] = None


class AnswerBody(BaseModel):
    question_id: str
    answers: dict[str, Any] = Field(default_factory=dict)
    task_id: Optional[str] = None


class InterruptBody(BaseModel):
    task_id: Optional[str] = None


class ForkBody(BaseModel):
    task_id: str
    message_seq: int


class RewindBody(BaseModel):
    #: Required, unlike the optional `task_id` the append verbs take: `rewind`
    #: re-bases a specific stream in place, and a multi-stream session must not
    #: fall back to "the newest stream" for a destructive undo. The UI always
    #: sends the stream the anchored bubble belongs to.
    task_id: str
    message_seq: int


def session_row(session: sessions.Session) -> dict[str, Any]:
    return {
        "id": session.id,
        "project_id": session.project_id,
        "title": session.title,
        "title_generated": session.title_generated,
        "status": session.status,
        "pinned": session.pinned,
        "archived": session.archived,
        "version": session.version,
        "created_at": iso(session.created_at),
        "updated_at": iso(session.updated_at),
        # Lineage: set on a fork, null on every ordinary session. The sidebar
        # nests a child under `parent_session_id`; `branched_at_seq` drives the
        # "forked at message N" copy. `source_task_id` stays server-side (the
        # hub splices inherited history from it) and is not on the wire.
        "parent_session_id": session.parent_session_id,
        "branched_at_seq": session.branched_at_seq,
    }


def task_stream_row(stream: sessions.TaskStream) -> dict[str, Any]:
    return {
        "task_id": stream.task_id,
        "kind": stream.kind,
        "source_task_id": stream.source_task_id,
        "branched_at_seq": stream.branched_at_seq,
        "created_at": iso(stream.created_at),
    }


def session_detail(
    session: sessions.Session, streams: list[sessions.TaskStream]
) -> dict[str, Any]:
    """The row plus the streams it owns.

    A session owns **one or more** task streams — `fork` appends siblings — so
    the detail lists them and the client drives the `?task_id=` filter from
    this array. A session that has never been messaged lists none."""
    detail = session_row(session)
    detail["task_streams"] = [task_stream_row(s) for s in streams]
    return detail


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------


def file_row(entry: files_module.FileEntry) -> dict[str, Any]:
    return {"path": entry.path, "size": entry.size, "mtime": entry.mtime}
