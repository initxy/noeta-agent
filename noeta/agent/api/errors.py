"""The error envelope, and the one place exceptions become status codes.

```json
{"error": {"code": "not_forkable", "message": "…"}}
```

`code` is a stable machine-readable slug and `message` is human text that may
change; the HTTP status carries the class and `code` disambiguates within it.

Handlers do not build this. They raise — a store error, a host error, one of
the SDK's coded errors, or an `APIError` for a refusal that is genuinely the
API's own — and `ContractRoute` turns it into the envelope. That is what keeps
every handler in this package reading like the wire contract instead of like a
try/except ladder, and it is why the mapping below is a single table: a status
code decided twice eventually gets decided differently.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine, Optional

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from noeta.agent.host.client import (
    NoTaskStreamError,
    NotRewindableError,
    UnknownTaskStreamError,
)
from noeta.agent.host.files import InvalidPathError
from noeta.agent.models_config import ModelValidationError
from noeta.agent.store import errors as store_errors
from noeta.sdk import (
    CodedError,
    McpConfigError,
    ModelSelectorError,
    NotForkableError,
    NotResumableError,
    TaskAlreadyTerminalError,
    UnknownTaskError,
)

logger = logging.getLogger(__name__)


class APIError(Exception):
    """A refusal the API itself decides — the 409 on a busy session, a 404 for
    a resource that is not there, a 400 for an attachment that cannot be
    decoded. Everything else arrives as a typed exception from a layer below."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def error_body(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=error_body(code, message))


def not_found(what: str, ident: str) -> APIError:
    return APIError(404, f"unknown_{what}", f"no such {what}: {ident}")


#: exception type -> (status, code). Order matters only for subclasses, which
#: is why `CodedError` is handled after this table rather than in it.
_MAPPING: tuple[tuple[type[Exception], int, str], ...] = (
    # -- store ---------------------------------------------------------------
    (store_errors.InvalidDirectoryError, 422, "invalid_directory"),
    (store_errors.DuplicateDirectoryError, 409, "duplicate_directory"),
    (store_errors.UnknownProjectError, 404, "unknown_project"),
    (store_errors.UnknownSessionError, 404, "unknown_session"),
    (store_errors.DuplicateAliasError, 409, "duplicate_alias"),
    (store_errors.DuplicateTaskStreamError, 409, "duplicate_task_stream"),
    # -- host ----------------------------------------------------------------
    (UnknownTaskStreamError, 404, "unknown_task_stream"),
    # The engine refusing a lifecycle verb whose `task_id` names no stream it
    # has ever seen. Reachable only when the two storages disagree — the app
    # db still binds a stream the engine ledger no longer holds — and a
    # missing resource is a 404, the same answer `unknown_task_stream` gives
    # for the sibling case the store itself can see. Named here rather than
    # left to the `CodedError` fallback below, which would call it a 409.
    (UnknownTaskError, 404, "unknown_task"),
    (NoTaskStreamError, 409, "no_task_stream"),
    (NotRewindableError, 409, "not_rewindable"),
    (InvalidPathError, 400, "invalid_path"),
    (ModelValidationError, 422, "invalid_model"),
    # -- engine --------------------------------------------------------------
    # `fork` on a stream that cannot be branched, `send_goal` on a task that
    # was cancelled, a verb on an already-terminal task: all three are conflicts
    # with the conversation's state, not bad requests.
    (NotForkableError, 409, "not_forkable"),
    (NotResumableError, 409, "not_resumable"),
    (TaskAlreadyTerminalError, 409, "task_terminal"),
    (ModelSelectorError, 422, "model_not_allowed"),
    (McpConfigError, 422, "mcp_config"),
)


def to_error_response(exc: BaseException) -> Optional[JSONResponse]:
    """The contract envelope for a raised exception, or `None` to re-raise.

    `None` is the important half: an exception this table does not name is a
    bug, and swallowing it into a tidy 500 body would hide the traceback that
    says what broke.
    """
    if isinstance(exc, APIError):
        return error_response(exc.status_code, exc.code, exc.message)
    for exc_type, status, code in _MAPPING:
        if isinstance(exc, exc_type):
            return error_response(status, code, str(exc))
    if isinstance(exc, CodedError):
        # An engine error this build has not named. Its own `code` is already a
        # stable slug, so it reaches the client intact rather than as a 500 —
        # the SDK may add a coded refusal without a protocol bump.
        return error_response(409, exc.code or "conflict", str(exc))
    if isinstance(exc, store_errors.StoreError):
        return error_response(409, "store_conflict", str(exc))
    return None


class ContractRoute(APIRoute):
    """The route class every router in this package uses.

    Wrapping the handler rather than registering app-level exception handlers
    keeps the mapping with the endpoints it serves: `create_app` stays a
    composition root that knows nothing about which errors this surface can
    raise.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except Exception as exc:  # noqa: BLE001 - re-raised when unmapped
                response = to_error_response(exc)
                if response is None:
                    raise
                return response

        return handler
