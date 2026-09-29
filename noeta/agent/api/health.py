"""Liveness: is the backend up, what is it talking to, and can it sandbox.

`{status, version, provider, sandbox_available, data_dir}` — the whole payload,
always every field. The SPA types this response with required fields, so an
endpoint that omits one hands the client a value TypeScript promised was there.

`provider` is the *resolved* provider, so a credential-free machine can see at
a glance that it is running against the offline mock rather than silently
failing to reach a gateway. `version` identifies the build the browser tab is
actually talking to.

`sandbox_available` is a real Docker probe, and it is the one thing here that
could go wrong: a machine with no Docker is a **supported configuration** — it
simply cannot run the sandbox tier — so the probe must never make this endpoint
hang or fail. It runs off the event loop, under its own timeout, and its result
is cached for a while: `/health` is polled, and a subprocess spawn per poll is a
cost carrying no new information.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
import time
from typing import Any, Optional

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from noeta.agent.api.errors import ContractRoute
from noeta.agent.config import VERSION

logger = logging.getLogger(__name__)

router = APIRouter(tags=["health"], route_class=ContractRoute)

#: How long a probe result stands. Docker does not come and go during a
#: session, and the value is advisory — it reports what the machine can do, it
#: does not gate the per-project tier the user chose.
PROBE_TTL_S = 30.0

#: Bounds the subprocess. `docker version` talks to the daemon, and an
#: unreachable daemon (a stopped Docker Desktop, a dead socket) is exactly the
#: case that would otherwise hang.
PROBE_TIMEOUT_S = 2.0

#: Bounds the whole await, thread-pool scheduling included, so a saturated pool
#: cannot make `/health` slow either.
PROBE_DEADLINE_S = 4.0

_cache: Optional[tuple[float, bool]] = None


def _probe_docker() -> bool:
    """Whether a Docker daemon answers. Blocking; call it off the loop."""
    exe = shutil.which("docker")
    if exe is None:
        return False
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [exe, "version", "--format", "{{.Server.Version}}"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and bool(result.stdout.strip())


def docker_available(*, ttl: float = PROBE_TTL_S) -> bool:
    """The cached probe. Blocking on a miss."""
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[0] < ttl:
        return _cache[1]
    available = _probe_docker()
    _cache = (now, available)
    return available


def reset_probe_cache() -> None:
    """Forget the cached verdict."""
    global _cache
    _cache = None


async def sandbox_available() -> bool:
    """The probe, with a hard deadline and a safe answer on every failure.

    `False` is the honest degradation: the sandbox tier needs a container, and
    if we cannot even ask whether Docker is there within the deadline, we
    cannot promise one."""
    try:
        return await asyncio.wait_for(
            run_in_threadpool(docker_available), PROBE_DEADLINE_S
        )
    except (TimeoutError, asyncio.TimeoutError):
        logger.warning("the docker probe timed out; reporting no sandbox")
        return False
    except Exception:  # noqa: BLE001 - liveness must not fail over a probe
        logger.warning("the docker probe failed; reporting no sandbox", exc_info=True)
        return False


@router.get("/health")
async def health(request: Request) -> Any:
    settings = request.app.state.settings
    runtime = getattr(request.app.state, "runtime", None)
    return {
        "status": "ok",
        "version": VERSION,
        # From the runtime when it is up, because that is the provider actually
        # bound to the client; from settings before then, which is what it
        # will resolve to.
        "provider": runtime.provider_name if runtime else settings.effective_provider,
        "sandbox_available": await sandbox_available(),
        "data_dir": str(settings.data_path),
    }
