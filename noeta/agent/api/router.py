"""The one `/api/v1` router.

`create_app` mounts this router and nothing else, so the prefix lives in
exactly one place and a new endpoint module is one `include_router` line here.

**Every route must be registered here.** The SPA is mounted last and matches
every path, so a route registered anywhere else is unreachable: it answers
`index.html` with status 200 and the client parses HTML as data.
"""
from __future__ import annotations

from fastapi import APIRouter

from noeta.agent.api import (
    content,
    events,
    files,
    health,
    meta,
    projects,
    sessions,
    trace,
)

router = APIRouter()

router.include_router(health.router)
router.include_router(meta.router)
router.include_router(content.router)
router.include_router(projects.router)
router.include_router(sessions.router)
router.include_router(events.router)
router.include_router(files.router)
router.include_router(trace.router)
