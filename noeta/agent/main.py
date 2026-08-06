"""The application factory.

`create_app(settings)` builds the whole product: the `/api/v1` surface, the
built SPA, and the lifespan that owns every process-lived resource.

There is deliberately **no module-level `app`**: importing this module must
not construct Settings, because that would read the developer's `.env` and
contaminate anything that merely imports the app. The entry point
(`python -m noeta.agent`) builds it explicitly; tests inject their own
Settings.
"""
from __future__ import annotations

import logging
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles

from noeta.agent.api.errors import error_response
from noeta.agent.api.router import router as api_router
from noeta.agent.api.runtime import install_runtime
from noeta.agent.config import APP_DIR, PACKAGE_DIR, Settings, get_settings
from noeta.agent.store import db

logger = logging.getLogger(__name__)

API_PREFIX = "/api/v1"

_NO_FRONTEND_MESSAGE = """\
noeta-agent is running, but the web UI has not been built.

Run `make web` (or `npm run build` in web/) and reload this page.
The API is already live — try {prefix}/health.
"""


def _is_api_path(path: str) -> bool:
    """Whether a path belongs to the API surface.

    The SPA fallback must never answer for it: an unknown API path has to 404
    as JSON, or a typo in a fetch URL silently returns `index.html` with
    status 200 and the client parses HTML as data."""
    return path.lstrip("/").startswith("api/")


class SPAStaticFiles(StaticFiles):
    """Static hosting with an index.html fallback for client-side routes.

    The URL is authoritative in this product, so `/project/x/session/y` must
    survive a hard refresh — which means any non-file path resolves to the
    SPA entry point. Two exceptions stay 404: the API surface, and anything
    that is not a GET-able page (StaticFiles' own non-404 errors)."""

    async def get_response(self, path: str, scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            # StaticFiles raises Starlette's HTTPException, not FastAPI's
            # subclass — catching the wrong one silently disables the
            # fallback and every deep link 404s.
            if exc.status_code == 404 and not _is_api_path(path):
                return await super().get_response("index.html", scope)
            if exc.status_code == 404:
                # An unrouted API path. FastAPI's own 404 body is
                # `{"detail": "Not Found"}`, which is not the contract's error
                # envelope (§5.6) — every handler-raised error already is, and
                # a client that special-cases one shape for "no route" and
                # another for everything else has two parsers for one API.
                return error_response(
                    404, "unknown_endpoint", f"no API endpoint at /{path.lstrip('/')}"
                )
            raise


def _frontend_dist() -> Path | None:
    """Locate the built SPA: the bundle inside the package tree first
    (`noeta/agent/static`, the wheel layout), then the repo-checkout dev build
    (`web/dist`).

    The order matters. The repo candidate is derived from this module's
    location, which assumes an editable install; in a wheel it degenerates to
    `site-packages`, where `web/dist` does not exist and the package-relative
    bundle is the only real answer."""
    for candidate in (PACKAGE_DIR / "static", APP_DIR / "web" / "dist"):
        if (candidate / "index.html").is_file():
            return candidate
    return None


def _configure_logging(settings: Settings) -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_for_boot()
    _configure_logging(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Everything with a process lifetime is acquired here and released in
        # the finally block. The engine Client hangs off the same seam: its
        # shutdown order is what stops a live session leaking its container.
        settings.ensure_data_dirs()
        conn: sqlite3.Connection = db.connect(settings.app_db_path)
        version = db.bootstrap(conn)
        app.state.db = conn
        logger.info(
            "noeta-agent up on http://%s:%s — provider=%s data=%s schema=v%d",
            settings.host,
            settings.port,
            settings.effective_provider,
            settings.data_path,
            version,
        )
        try:
            yield
        finally:
            conn.close()

    app = FastAPI(title="noeta-agent", lifespan=lifespan)
    # Available before the lifespan runs so a bare TestClient can read it.
    app.state.settings = settings

    # Only when asked for: the packaged app serves the SPA same-origin and
    # needs none of this. No credentials — the product has no auth.
    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(api_router, prefix=API_PREFIX)
    # The engine half. It wraps the lifespan above rather than living inside
    # it, which is what keeps the ordering honest: the store still opens first
    # and closes last, and the host closes before it. A test that needs a
    # scripted provider calls `install_runtime` again and replaces this plan.
    install_runtime(app, settings)

    dist = _frontend_dist()
    if dist is not None:
        # Mounted last, and it matches every path — so it is the fallback
        # after the API routes above, and a route registered *after*
        # create_app returns would never be reached. Endpoints belong in
        # api/router.py.
        app.mount("/", SPAStaticFiles(directory=str(dist), html=True), name="spa")
        logger.info("serving frontend from %s", dist)
    else:
        # Booting must not require a built frontend — the backend is usable
        # on its own, and the browser gets told what to run.
        @app.get("/{spa_path:path}", include_in_schema=False)
        async def _frontend_missing(spa_path: str) -> Response:
            if _is_api_path(spa_path):
                # The same envelope the mounted-SPA branch answers with: which
                # of the two is serving is not something a client can see.
                return error_response(
                    404, "unknown_endpoint", f"no API endpoint at /{spa_path}"
                )
            return PlainTextResponse(_NO_FRONTEND_MESSAGE.format(prefix=API_PREFIX))

        logger.warning("no built frontend found; serving the build hint instead")

    return app
