"""Artifact resolution: the client guesses, the server decides.

The client derives artifact candidates from the transcript — a
provenance-weighted scan over tool metadata, tool output and assistant prose.
That scan is a *guess* by construction: it reads text, and text lies. This
endpoint is the other half, and the two halves are not symmetric.

**Two-stage trust is mandatory here, not optional.** Our files can live inside
a container, so the client cannot stat anything and can only ever propose. The
server overwrites `exists`, `size`, `updatedAt` and `preview` from the file
surface, and **nothing is collectible before that round trip** — no panel tab,
no sidebar row. A candidate the scan invented out of a paragraph fails `exists`
here and disappears, which is precisely why the scan is allowed to be greedy.

`preview` is recomputed rather than trusted for the same reason: the extension
table is the server's, so the client's guess only ever decides what spinner to
show for one paint.

Two shapes here are the client's, not this module's, and both are deliberate:

- the request carries **paths only**. A URL has nothing on disk to stat and its
  scheme check is an answer the client already holds, so round-tripping it
  would be a request for information the caller already has;
- a row is keyed by the **path the client sent**, echoed back verbatim. The
  client folds the response into its candidate list by that string, so
  answering with the normalized path would silently drop every candidate that
  needed normalizing — the container-absolute ones, which are most of them.

The batch is **capped**. The scan runs over a whole transcript and re-fires
whenever the derived set changes, so an uncapped batch would let a long
conversation turn one panel refresh into thousands of `stat` calls.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.deps import db_of, workspace_root
from noeta.agent.api.errors import ContractRoute
from noeta.agent.host import files as files_module

logger = logging.getLogger(__name__)

router = APIRouter(tags=["artifacts"], route_class=ContractRoute)

#: How many candidates one request may carry, matching the cap the client
#: applies before it asks. Extras are dropped rather than failing the batch: a
#: transcript that grew past the cap must degrade to "the first N are
#: verified", never to "the artifact panel stopped working".
RESOLVE_CAP = 80

#: The previews worth a panel tab. `text` and `external` are openable but never
#: collectible — a `.ts` is source, not an artifact.
COLLECTIBLE_PREVIEWS = frozenset(
    {"markdown", "sheet", "slides", "document", "image", "pdf", "html"}
)


class ResolveRequest(BaseModel):
    """Workspace paths as the client derived them, unnormalized."""

    paths: list[str]


def _resolve_one(raw: str, root: str) -> dict[str, Any]:
    row: dict[str, Any] = {
        # Echoed verbatim: this is the client's fold key.
        "path": raw,
        "exists": False,
        "size": None,
        "updatedAt": None,
        "preview": files_module.preview_for_path(raw),
    }
    rel = files_module.normalize_candidate(raw, root)
    if not rel:
        return row
    row["preview"] = files_module.preview_for_path(rel)
    try:
        resolved = files_module.resolve_within(root, rel)
    except files_module.InvalidPathError:
        # A traversal attempt or a symlink out of the workspace is reported as
        # "not there" rather than as a 400. It is one candidate out of a batch
        # of guesses, and the honest answer to "is this an artifact of yours"
        # is no.
        return row
    stat = files_module.stat_file(resolved)
    if not stat.exists:
        return row
    row["exists"] = True
    row["size"] = stat.size
    # A **string**, and opaque to the client: it is compared for change, never
    # parsed. The read endpoint's numeric `mtime` is what a save locks against;
    # keeping the two in different types is what stops one being used as the
    # other, which would let a stat from an unrelated moment act as an
    # optimistic lock.
    row["updatedAt"] = str(stat.mtime)
    return row


def _resolve(paths: list[str], root: str) -> list[dict[str, Any]]:
    return [_resolve_one(path, root) for path in paths]


@router.post("/sessions/{session_id}/artifacts/resolve")
async def resolve_artifacts(
    request: Request, session_id: str, body: ResolveRequest
) -> Any:
    """Verify a capped batch of derived candidates against the file surface.

    Returns one row per accepted path, in request order:

    ```
    {path, exists, size, updatedAt, preview}
    ```

    The whole batch runs on the thread pool in one hop: a `stat` per candidate
    is cheap, and an active turn can hold a serial engine worker for minutes,
    so a read path that shared that queue would make the panel hang behind the
    model.
    """
    conn = db_of(request)
    root = await run_in_threadpool(workspace_root, conn, session_id)
    rows = await run_in_threadpool(_resolve, body.paths[:RESOLVE_CAP], root)
    return {"artifacts": rows}


def collectible(row: dict[str, Any]) -> bool:
    """Whether a resolved row earns a panel tab. The server's half of the rule
    the client also applies; kept here so the vocabulary has one definition."""
    return bool(row.get("exists")) and row.get("preview") in COLLECTIBLE_PREVIEWS


def conflict_body(code: str, message: str, current_mtime: Optional[float]) -> dict[str, Any]:
    """The 409 envelope, carrying the file's current mtime.

    `current_mtime` is an **optional** addition to the standard error envelope,
    and the client is written to work without it. It is here because it saves
    the "overwrite theirs" path a round trip: the client already knows what it
    wants to write, and this is the only thing it was missing."""
    error: dict[str, Any] = {"code": code, "message": message}
    if current_mtime is not None:
        error["current_mtime"] = current_mtime
    return {"error": error}
