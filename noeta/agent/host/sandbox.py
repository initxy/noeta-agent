"""Composing the sandbox execution tier: provider, spec, adapters, reaper.

Four pieces built in four other modules, and this is the one place that knows
they belong together:

- `sandbox_provider.LocalDockerSandboxProvider` — who runs `docker`;
- the two SDK adapters (`sdk_sandbox_exec_env` / `sdk_browser_backend`) — the
  container wire the engine's fs / shell / browser tools ride on;
- `reaper.SandboxIdleReaper` — the two-level idle reclamation;
- the store, which answers both "whose task is this" questions.

## Building the provider is free; using it is not

Nothing here talks to Docker. `LocalDockerSandboxProvider.__init__` opens no
socket and spawns no subprocess, so the composition root can wire it
unconditionally and a machine with no Docker still boots — which is the
first-run promise. The daemon is reached at `allocate`, and `allocate` happens
only for a project whose tier is `sandbox` (`tiers.TierPolicy`).

That means a `sandbox` project on a Docker-less machine **fails its turn
loudly** rather than silently running local. That is the intended trade: the
tier is a safety boundary the user chose, and answering "isolated" with "not
isolated" is the one failure mode worth a hard error. `/health`'s
`sandbox_available` is what keeps the UI from offering the tier in the first
place.

## The adapter imports are deferred

`agent_sandbox` and the two concrete AIO adapter modules are imported inside
the factories, not at module import. A machine that never provisions a
container never pays for them, and the composition root stays importable even
if that optional wire is broken — the same discipline the SDK applies to its
own default factories.
"""
from __future__ import annotations

import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Optional

from noeta.agent.config import Settings
from noeta.agent.host.reaper import SandboxIdleReaper
from noeta.agent.host.reaper import SessionActivity as ReaperActivity
from noeta.agent.host.sandbox_provider import LocalDockerSandboxProvider
from noeta.agent.host.seeding import SEEDING
from noeta.agent.store import projects, sessions
from noeta.sdk import SandboxSpec

logger = logging.getLogger(__name__)

__all__ = [
    "SandboxTier",
    "build_sandbox_tier",
    "container_id_resolver",
    "workspace_dir_resolver",
]


def container_id_resolver(
    store: sqlite3.Connection,
) -> Callable[[str], Optional[str]]:
    """`LocalDockerSandboxProvider(resolve_container_id=…)` over the store.

    Under D2 the container's natural key is the **project**: every session of a
    project shares one directory, so sharing one container is the placement
    that follows, and the preview surface and the idle reaper both address it
    that way.

    Two sources, in this order, and the second one is not an optimisation:

    1. the durable `task -> session -> project` row, which answers every turn
       after the first and every turn after a restart;
    2. the **seeding window** (`host/seeding.py`), because provisioning happens
       inside `seed_start` and the binding row is written between the seed and
       the dispatch. Without it the very first allocate of every session misses
       — and since every later turn `attach`es to the durable container name it
       minted, the session keeps a container of its own forever. The symptom is
       not an error: it is two sessions of one project silently not sharing a
       container, and a preview panel 404-ing on a session that is visibly
       running in one.

    Total: a miss is `None`, which degrades to a per-task container rather than
    raising on an engine thread."""

    def resolve(root_task_id: str) -> Optional[str]:
        try:
            binding = sessions.find_task_binding(store, root_task_id)
        except Exception:  # noqa: BLE001 - one container, never the turn
            logger.warning(
                "container id lookup failed for %s", root_task_id, exc_info=True
            )
            binding = None
        if binding is not None:
            return binding.project_id
        return SEEDING.current()

    return resolve


def workspace_dir_resolver(
    store: sqlite3.Connection,
) -> Callable[[str], Optional[str]]:
    """`LocalDockerSandboxProvider(resolve_workspace_dir=…)` over the store.

    The reverse of `container_id_resolver`: `container_id` (which under D2 **is**
    the project id) → that project's directory on disk, the source of the one
    `rw` workspace mount.

    It exists for exactly one path: `attach` finding its container `absent`
    because the idle reaper removed it. Rebuilding needs the workspace mount, and
    `attach` holds only the durable ref — so the directory has to come from here.
    A `None` answer means the store has no such project (a genuinely foreign ref,
    or a since-deleted project), and `attach` keeps its hard error rather than
    rebuilding against a directory it cannot name.

    Total: any lookup failure degrades to `None`, so a store hiccup turns into
    "cannot rebuild, raise" rather than an exception on the engine thread."""

    def resolve(container_id: str) -> Optional[str]:
        try:
            project = projects.get_project(store, container_id)
        except Exception:  # noqa: BLE001 - a rebuild hint, never the turn
            logger.warning(
                "workspace lookup failed for %s", container_id, exc_info=True
            )
            return None
        return project.directory if project is not None else None

    return resolve


def _activity_reader(
    store: sqlite3.Connection,
) -> Callable[[], list[ReaperActivity]]:
    """The reaper's store seam, read fresh on every sweep.

    Status and `updated_at` come from the database rather than any in-memory
    map, so they survive a process restart — which is exactly the case where a
    leaked container would otherwise never be reclaimed."""

    def read() -> list[ReaperActivity]:
        return [
            ReaperActivity(
                container_id=row.project_id,
                status=row.status,
                updated_at=row.updated_at,
                has_task_stream=row.has_task_stream,
            )
            for row in sessions.sandbox_activity(store)
        ]

    return read


def exec_env_factory(handle: Any, preamble: Any = None) -> Any:
    """`HostConfig.sandbox_backend_factory`, deferred-import."""
    from noeta.agent.host.sdk_sandbox_exec_env import sdk_exec_env_factory

    return sdk_exec_env_factory(handle, preamble)


def browser_factory(handle: Any) -> Any:
    """`HostConfig.sandbox_browser_factory`, deferred-import."""
    from noeta.agent.host.sdk_browser_backend import sdk_browser_factory

    return sdk_browser_factory(handle)


def sandbox_spec(settings: Settings) -> SandboxSpec:
    """The deployment-fixed half of the container shape.

    Mounts are deliberately empty: the SDK's `SandboxExecEnvManager` appends
    the per-session workspace mount itself, and adding it here would bind the
    project directory twice."""
    resources = {
        key: value
        for key, value in (
            ("memory", settings.sandbox_memory),
            ("cpus", settings.sandbox_cpus),
        )
        if value
    }
    return SandboxSpec(image=settings.effective_sandbox_image, resources=resources)


@dataclass
class SandboxTier:
    """Everything the sandbox tier contributes to the runtime."""

    provider: LocalDockerSandboxProvider
    spec: SandboxSpec
    reaper: SandboxIdleReaper

    def start(self) -> None:
        # A no-op returning False when both idle levels are disabled, so the
        # caller never has to guard the call.
        self.reaper.start()

    def close(self) -> None:
        self.reaper.stop()


def build_sandbox_tier(
    settings: Settings, store: sqlite3.Connection
) -> SandboxTier:
    """Wire the tier. Opens nothing — see the module docstring."""
    provider = LocalDockerSandboxProvider(
        image=settings.effective_sandbox_image,
        api_key_env=settings.sandbox_api_key_env,
        memory=settings.sandbox_memory or None,
        cpus=settings.sandbox_cpus or None,
        resolve_container_id=container_id_resolver(store),
        resolve_workspace_dir=workspace_dir_resolver(store),
    )
    reaper = SandboxIdleReaper.from_hours(
        provider=provider,
        activity=_activity_reader(store),
        stop_hours=settings.sandbox_idle_stop_hours,
        remove_hours=settings.sandbox_idle_remove_hours,
        check_interval_hours=settings.sandbox_idle_check_interval_hours,
    )
    return SandboxTier(provider=provider, spec=sandbox_spec(settings), reaper=reaper)
