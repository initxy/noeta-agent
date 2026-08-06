"""`GET /content/{hash}` — one content-addressed blob, by hash.

The chat bubble renders an attachment by handing this URL to an `<img src>`:
image bytes never travel the event stream, only `{hash, media_type}`, and the
browser caches them by hash for free because the hash *is* the cache key.

`Content-Type` is **sniffed from the bytes**, never echoed from a caller. The
ContentStore has no metadata read interface, so there is nothing authoritative
to echo — and a client-supplied type would let one request decide how another's
bytes are interpreted.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.deps import host_of
from noeta.agent.api.errors import APIError, ContractRoute
from noeta.agent.host import files as files_module

router = APIRouter(tags=["content"], route_class=ContractRoute)

#: A content hash is 64 hex characters. Anything else is a 404 rather than a
#: 400: the store is content-addressed, so a malformed hash and an unknown one
#: are the same answer — there is nothing there.
_HASH = re.compile(r"\A[0-9a-f]{64}\Z")


@router.get("/content/{content_hash}")
async def get_content(request: Request, content_hash: str) -> Response:
    if not _HASH.match(content_hash):
        raise APIError(404, "unknown_content", "no such content")
    host = host_of(request)
    # Off the event loop: a blob read is disk I/O, and it must never queue
    # behind a drive worker — an active turn would otherwise stall every image
    # in every open conversation.
    body = await run_in_threadpool(host.client.get_content, content_hash)
    if body is None:
        raise APIError(404, "unknown_content", "no such content")
    return Response(
        content=body,
        media_type=files_module.sniff_content_type(body),
        # Immutable by construction: the hash names these exact bytes forever.
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
