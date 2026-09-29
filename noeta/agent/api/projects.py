"""Projects: the directory, the agent configuration, and the MCP connectors.

A project is one directory on the user's machine plus everything the agent
brings to the sessions held against it. All of a project's sessions share that
directory as their workspace root, which is stated here because it is the fact
the create form has to show: two live sessions can write the same file.

**Changing `tier` only affects sessions created afterwards.** The tier is
welded into the task at `seed_start` and every later turn fold-resolves it from
there, so an existing session keeps the tier it was born with. The endpoint
does not pretend otherwise, and neither should the UI.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from noeta.agent.api import wire
from noeta.agent.api.deps import db_of, require_project
from noeta.agent.api.errors import APIError, ContractRoute, not_found
from noeta.agent.store import projects
from noeta.agent.store.errors import InvalidDirectoryError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["projects"], route_class=ContractRoute)


@router.get("/projects")
async def list_projects(request: Request) -> Any:
    conn = db_of(request)
    rows = await run_in_threadpool(projects.list_projects, conn)
    return {"projects": [wire.project_row(p) for p in rows]}


@router.post("/projects", status_code=201)
async def create_project(request: Request, body: wire.CreateProject) -> Any:
    """201 with the new project. 422 on a non-absolute or missing directory,
    409 when the directory already belongs to one.

    `create_directory` is opt-in because the failure modes are asymmetric: a
    typo that creates `~/Documnets/app` is a directory the user will never find
    again, while a typo that 422s is one they fix in the form. A project whose
    directory does not exist is refused rather than stored, because it is a
    project that cannot run a single turn — the workspace root would not be
    there when the first message tried to seed against it."""
    conn = db_of(request)
    directory = body.directory.strip()
    absolute = bool(directory) and Path(directory).is_absolute()
    if absolute and not await run_in_threadpool(Path(directory).is_dir):
        if not body.create_directory:
            raise InvalidDirectoryError(f"no such directory: {directory}")
        # Only ever after the absoluteness check the store also makes: a
        # relative path here would create a directory under the server's
        # working directory, which is never what was meant.
        await run_in_threadpool(_mkdir, directory)
    project = await run_in_threadpool(
        projects.create_project,
        conn,
        name=body.name.strip() or Path(directory).name,
        directory=directory,
        tier=body.tier,
    )
    return wire.project_row(project)


def _mkdir(directory: str) -> None:
    try:
        Path(directory).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise InvalidDirectoryError(f"could not create {directory}: {exc}") from exc


@router.get("/projects/{project_id}")
async def get_project(request: Request, project_id: str) -> Any:
    conn = db_of(request)
    return wire.project_row(await run_in_threadpool(require_project, conn, project_id))


@router.patch("/projects/{project_id}")
async def update_project(
    request: Request, project_id: str, body: wire.UpdateProject
) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    updated = await run_in_threadpool(
        lambda: projects.update_project(
            conn,
            project_id,
            **body.model_dump(exclude_none=True),
        )
    )
    return wire.project_row(updated or require_project(conn, project_id))


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(request: Request, project_id: str) -> Response:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    await run_in_threadpool(projects.delete_project, conn, project_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Agent configuration
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/agent-config")
async def get_agent_config(request: Request, project_id: str) -> Any:
    conn = db_of(request)
    return wire.agent_config(await run_in_threadpool(require_project, conn, project_id))


@router.put("/projects/{project_id}/agent-config")
async def put_agent_config(
    request: Request, project_id: str, body: wire.AgentConfigBody
) -> Any:
    """The persona, default model + effort and memory toggle, as one document.

    A PUT rather than a PATCH because the settings tab edits the whole form:
    an omitted field means "leave it", which is what `exclude_none` encodes,
    and clearing a value is sending an empty string."""
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    updated = await run_in_threadpool(
        lambda: projects.update_project(
            conn, project_id, **body.model_dump(exclude_none=True)
        )
    )
    return wire.agent_config(updated or require_project(conn, project_id))


# ---------------------------------------------------------------------------
# MCP connectors
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/connectors")
async def list_connectors(request: Request, project_id: str) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    rows = await run_in_threadpool(projects.list_connectors, conn, project_id)
    return {"connectors": [wire.connector_row(c) for c in rows]}


@router.post("/projects/{project_id}/connectors", status_code=201)
async def create_connector(
    request: Request, project_id: str, body: wire.ConnectorBody
) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    connector = await run_in_threadpool(
        lambda: projects.create_connector(
            conn,
            project_id,
            body.alias,
            transport=body.transport,
            url=body.url,
            argv=tuple(body.argv),
            headers=body.headers,
            env=body.env,
            tool_subset=tuple(body.tool_subset),
            enabled=body.enabled,
        )
    )
    return wire.connector_row(connector)


@router.patch("/projects/{project_id}/connectors/{alias}")
async def update_connector(
    request: Request, project_id: str, alias: str, body: wire.ConnectorPatch
) -> Any:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    patch = body.model_dump(exclude_none=True)
    for key in ("argv", "tool_subset"):
        if key in patch:
            patch[key] = tuple(patch[key])
    updated = await run_in_threadpool(
        lambda: projects.update_connector(conn, project_id, alias, **patch)
    )
    if updated is None:
        raise _no_connector(alias)
    return wire.connector_row(updated)


@router.delete("/projects/{project_id}/connectors/{alias}", status_code=204)
async def delete_connector(request: Request, project_id: str, alias: str) -> Response:
    conn = db_of(request)
    await run_in_threadpool(require_project, conn, project_id)
    removed = await run_in_threadpool(
        projects.delete_connector, conn, project_id, alias
    )
    if not removed:
        raise _no_connector(alias)
    return Response(status_code=204)


def _no_connector(alias: str) -> APIError:
    return not_found("connector", alias)
