"""The workspace file surface for one session: list, read, write.

All of a project's sessions share the project directory, so "this session's
files" is the project's directory — which is exactly the mental model the
product wants: you are working on *this project*, and both tiers write into
the same tree.

Reads and writes both go through the host-side directory rather than the
container: faster, works when the container is stopped, and works for a `local`
project, which has no container at all. The file surface is therefore **not**
gated on the execution tier. `host/files.write_text` carries the full reasoning
for the write half, including what it costs.

Because that shared directory is real, the write path is optimistically locked
from the first day it exists: a second session — or this session's own agent,
mid-turn — can rewrite a file under an open editor, and answering that with a
silent overwrite loses work.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from noeta.agent.api import artifacts, preview, wire
from noeta.agent.api.deps import db_of, workspace_root
from noeta.agent.api.errors import APIError, ContractRoute
from noeta.agent.host import files as files_module

logger = logging.getLogger(__name__)

router = APIRouter(tags=["files"], route_class=ContractRoute)


class WriteFile(BaseModel):
    """A save. `base_mtime` is the `mtime` the client last read.

    Optional on purpose: a first write to a file that is not there, and a
    client that is not tracking versions, are both legitimate and neither can
    be a conflict."""

    path: str
    content: str
    base_mtime: Optional[float] = None


@router.get("/sessions/{session_id}/files")
async def list_files(request: Request, session_id: str) -> Any:
    """Every visible file in the project directory, sorted.

    A directory that is gone lists as empty rather than erroring: a project
    whose folder was moved is a recoverable situation, and a 500 in the file
    panel makes it look like the session is broken."""
    conn = db_of(request)
    root = await run_in_threadpool(workspace_root, conn, session_id)
    entries = await run_in_threadpool(files_module.list_files, root)
    return {"files": [wire.file_row(e) for e in entries]}


@router.get("/sessions/{session_id}/files/content")
async def read_file(
    request: Request,
    session_id: str,
    path: str = Query(...),
    mode: str = Query("text"),
) -> Any:
    """One file, as text or as exact bytes.

    `text` clips at 200 KB and reports `truncated`; `raw` returns the bytes
    with a **sniffed** content type, which is what an image or PDF preview
    needs. 400 on a path that does not resolve inside the workspace, 404 when
    it does but nothing is there.

    Both modes report `mtime` from the same `stat` that read the file — it is
    the base for the next save, and recovering it by running the whole listing
    a second time is an N+1 over the project tree to answer one field."""
    conn = db_of(request)
    root = await run_in_threadpool(workspace_root, conn, session_id)
    resolved = files_module.resolve_within(root, path)
    if not await run_in_threadpool(resolved.is_file):
        raise APIError(404, "unknown_file", f"no such file: {path}")

    if mode == "raw":
        body = await run_in_threadpool(resolved.read_bytes)
        media_type = files_module.sniff_content_type(body)
        return Response(
            content=body,
            media_type=media_type,
            headers=files_module.raw_headers(path, media_type),
        )
    if mode != "text":
        raise APIError(400, "invalid_mode", f"mode must be text or raw, got {mode!r}")

    read = await run_in_threadpool(files_module.read_text, resolved, rel=path)
    return {
        "path": read.path,
        "content": read.content,
        "truncated": read.truncated,
        "mtime": read.mtime,
    }


@router.put("/sessions/{session_id}/files/content")
async def write_file(request: Request, session_id: str, body: WriteFile) -> Any:
    """Save a text file, optimistically locked. **409 on an mtime mismatch.**

    The 409 is the whole point of the endpoint's shape. Its recovery is a
    re-read, and the envelope carries `current_mtime` so the "overwrite theirs"
    half of that choice costs no extra round trip — the reference
    implementation this replaces returned the conflict and had no client that
    handled it, so an externally-rewritten file silently failed to save.

    **The success body is exactly what a subsequent GET would return**
    (`{path, content, truncated, mtime}`, clipped identically). The client
    writes it straight into its content cache, so a shape that omitted the
    bytes would leave the editor holding an empty file, and one that skipped
    the clip would put 5 MB into a cache whose reader expects 200 KB.

    Every write goes through `resolve_within`, so `..`, an absolute path, the
    empty string and a symlink pointing out of the workspace are all 400 before
    any byte is touched."""
    conn = db_of(request)
    root = await run_in_threadpool(workspace_root, conn, session_id)
    resolved = files_module.resolve_within(root, body.path)

    encoded = len(body.content.encode("utf-8"))
    if encoded > files_module.MAX_WRITE_BYTES:
        raise APIError(
            422,
            "file_too_large",
            f"{body.path} is {encoded} bytes; the write cap is "
            f"{files_module.MAX_WRITE_BYTES}",
        )

    try:
        await run_in_threadpool(
            files_module.write_text,
            resolved,
            rel=body.path,
            content=body.content,
            base_mtime=body.base_mtime,
        )
    except files_module.FileConflictError as exc:
        return JSONResponse(
            status_code=409,
            content=artifacts.conflict_body(
                "file_conflict", str(exc), exc.current_mtime
            ),
        )
    except OSError as exc:
        raise APIError(400, "write_failed", f"could not write {body.path}: {exc}") from exc

    read = await run_in_threadpool(files_module.read_text, resolved, rel=body.path)
    return {
        "path": read.path,
        "content": read.content,
        "truncated": read.truncated,
        "mtime": read.mtime,
    }


def workspace_path(root: str, rel: str) -> Optional[Path]:
    """The resolved path for a workspace-relative name, or `None` if missing."""
    resolved = files_module.resolve_within(root, rel)
    return resolved if resolved.exists() else None


# The artifact-resolve and preview-discovery endpoints are sub-resources of
# this same workspace surface, so they are composed in here rather than
# registered separately. One `include_router` in `api/router.py` still reaches
# all three.
router.include_router(artifacts.router)
router.include_router(preview.router)
