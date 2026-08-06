"""The two-stage sandbox idle reaper.

A daemon thread that hands memory, CPU and eventually disk back to the host
when a project's container has been sitting idle. Two levels, and the
difference between them is not a tuning knob:

- **Level 1 — stop** (default 1h). `docker stop`. The processes die and the
  host gets its memory and CPU back — the entire point of reclamation — while
  the container body, its write layer, its mounts and its port mappings all
  survive. Resume is `attach` + `docker start`: seconds, with in-container
  state intact.
- **Level 2 — remove** (default 24h). Reclaims disk by discarding the write
  layer. Resume after it is a `_rebuild` in the provider, not a `docker start`:
  the container is re-run from its recoverable shape (name + workspace mount), so
  the `/workspace` files survive but installed packages, `/tmp` and processes do
  not. That heavier resume is why the levels are ordered by cost — **level 1 must
  not remove** when a cheap stop still restores in-container state intact.

Level 2 is checked **first** in each sweep, so a very old container is removed
rather than stopped-then-removed-a-day-later.

## What is reapable, under D2

The container's natural key is the project, not the session (see
`sandbox_provider.py`), so the criterion is a fold across the project's
sessions: reap only when **no session of this project is running or waiting**,
and the newest activity across them is past the threshold. `waiting` (a
question is pending) and `running` (including a subtask barrier) are *never*
reaped however overdue — otherwise answering a question would first wait for a
container to come back up. A session that owns no task stream never started a
container and contributes nothing at all.

That fold lives here rather than in the store because it *is* the policy. The
store's job is the flat read model (`SessionActivity` per session); this module
turns it into a per-container decision.

## Robustness, which is the whole reason this is a separate module

Every level is idempotent — an incomplete refcount after a process restart, or
a container the project-deletion path already removed, are both safe. A failure
on one container never blocks the others, and a failed sweep never kills the
thread: the next tick simply retries.

The poll interval has a one-minute floor so a tiny configuration cannot make
the thread busy-spin, and a threshold of `<= 0` disables its level. Both levels
disabled means no thread at all — `start()` returns `False` and nothing runs.
"""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Protocol

__all__ = [
    "MIN_CHECK_INTERVAL_S",
    "ContainerActivity",
    "IdleSandboxProvider",
    "SandboxIdleReaper",
    "SessionActivity",
    "fold_activity",
]

_log = logging.getLogger(__name__)

#: The poll-interval floor. A configuration of a few seconds would otherwise
#: have the thread scanning the store continuously for no benefit.
MIN_CHECK_INTERVAL_S = 60.0

#: Statuses that keep a project's container alive no matter how old it is.
#: `waiting` means a question is pending and the user may answer at any moment;
#: `running` includes a task parked on a subtask barrier, which is not idle.
_BUSY_STATUSES = frozenset({"running", "waiting"})


class IdleSandboxProvider(Protocol):
    """The slice of the sandbox provider this module drives.

    Deliberately narrow: the reaper has no business allocating, attaching or
    reference-counting. `LocalDockerSandboxProvider` satisfies it."""

    def stop_idle(self, container_id: str) -> bool: ...

    def force_release(self, container_id: str) -> None: ...


@dataclass(frozen=True)
class SessionActivity:
    """One session's contribution to its project's reap decision.

    The flat read model the store hands over, one row per session:

    - `container_id` — the project id, because that is what the container is
      named after.
    - `status` — the session status vocabulary (`idle` / `running` /
      `waiting`).
    - `updated_at` — unix seconds; the reaper measures idleness against the
      newest one in the project.
    - `has_task_stream` — whether this session ever seeded an engine task. A
      session the user opened and never wrote in has no container behind it and
      must not drag the project's idle clock forward."""

    container_id: str
    status: str
    updated_at: float
    has_task_stream: bool = True


@dataclass(frozen=True)
class ContainerActivity:
    """The fold of one project's sessions: is it busy, and how long idle."""

    container_id: str
    busy: bool
    updated_at: float


def fold_activity(rows: Iterable[SessionActivity]) -> list[ContainerActivity]:
    """Fold per-session rows into one decision per container.

    Sessions with no task stream are dropped entirely — they never started a
    container, so they neither make a project busy nor keep its clock warm. A
    project every one of whose sessions is task-less produces no row at all."""
    busy: dict[str, bool] = {}
    latest: dict[str, float] = {}
    for row in rows:
        if not row.has_task_stream or not row.container_id:
            continue
        busy[row.container_id] = busy.get(row.container_id, False) or (
            row.status in _BUSY_STATUSES
        )
        latest[row.container_id] = max(
            latest.get(row.container_id, row.updated_at), row.updated_at
        )
    return [
        ContainerActivity(
            container_id=container_id,
            busy=busy[container_id],
            updated_at=latest[container_id],
        )
        for container_id in latest
    ]


class SandboxIdleReaper:
    """The daemon patrol over `activity()`, driving a provider's two levels.

    `activity` is the store seam: a callable returning one `SessionActivity`
    per session that could have a container behind it. It is called fresh on
    every sweep — status and `updated_at` come from the store rather than any
    in-memory map, so they stay accurate across a process restart.

    `provider` may be `None` (no sandbox tier configured anywhere), in which
    case every sweep is a clean no-op."""

    def __init__(
        self,
        *,
        provider: IdleSandboxProvider | None,
        activity: Callable[[], Iterable[SessionActivity]],
        stop_after_s: float,
        remove_after_s: float,
        interval_s: float,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._provider = provider
        self._activity = activity
        self._stop_after_s = stop_after_s
        self._remove_after_s = remove_after_s
        self._interval_s = max(interval_s, MIN_CHECK_INTERVAL_S)
        self._now = now
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    @classmethod
    def from_hours(
        cls,
        *,
        provider: IdleSandboxProvider | None,
        activity: Callable[[], Iterable[SessionActivity]],
        stop_hours: float,
        remove_hours: float,
        check_interval_hours: float,
        now: Callable[[], float] = time.time,
    ) -> "SandboxIdleReaper":
        """Build one from the hour-denominated settings keys.

        The unit conversion lives here so no caller has to remember which of
        the three keys is hours and which is seconds."""
        return cls(
            provider=provider,
            activity=activity,
            stop_after_s=stop_hours * 3600.0,
            remove_after_s=remove_hours * 3600.0,
            interval_s=check_interval_hours * 3600.0,
            now=now,
        )

    @property
    def enabled(self) -> bool:
        """Whether either level is on. Both off means there is nothing to run."""
        return self._stop_after_s > 0 or self._remove_after_s > 0

    @property
    def interval_s(self) -> float:
        """The effective poll interval, after the one-minute floor."""
        return self._interval_s

    # -- thread lifecycle -------------------------------------------------- #

    def start(self) -> bool:
        """Start the patrol thread; returns whether one is now running.

        A no-op — and `False` — when both levels are disabled, so the caller
        never has to guard the call. Starting twice is also a no-op."""
        if not self.enabled or self._thread is not None:
            return self._thread is not None
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name="sandbox-idle-reaper", daemon=True
        )
        self._thread.start()
        _log.info(
            "sandbox idle reaper started: stop=%.1fh remove=%.1fh interval=%.1fh",
            self._stop_after_s / 3600.0,
            self._remove_after_s / 3600.0,
            self._interval_s / 3600.0,
        )
        return True

    def stop(self, *, timeout: float = 5.0) -> None:
        """Signal the thread and wait briefly for it. Idempotent.

        The thread waits on the stop event rather than sleeping, so signalling
        wakes it immediately instead of after up to a full interval."""
        self._stop_event.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def _loop(self) -> None:
        # `Event.wait` returns True once the event is set, so this both paces
        # the patrol and makes shutdown immediate. The first sweep runs after
        # one interval, not at start: nothing is idle the moment the process
        # boots, and a sweep during startup would race the store's own setup.
        while not self._stop_event.wait(self._interval_s):
            self.tick()

    def tick(self) -> None:
        """One guarded sweep — exactly what the patrol thread runs per interval.

        The guard lives here rather than inline in the loop so that "a failure
        never kills the thread" is a property of a callable thing. The store
        read happens on the patrol thread, and a transient failure there must
        cost one tick, not the reaper."""
        try:
            self.sweep()
        except Exception:  # noqa: BLE001 - a bad tick must never kill the thread
            _log.debug("sandbox idle reaper tick failed", exc_info=True)

    # -- one sweep --------------------------------------------------------- #

    def sweep(self) -> None:
        """Run one reclamation pass. Safe to call directly, and tests do.

        Level 2 is checked before level 1 so a container past the long TTL is
        removed outright instead of being stopped now and removed a day later.
        Each container is guarded on its own: one provider failure must not
        cost the rest of the sweep."""
        provider = self._provider
        if provider is None:
            return
        now = self._now()
        for container in fold_activity(self._activity()):
            if container.busy:
                # A running or waiting session anywhere in this project keeps
                # the whole container alive.
                continue
            idle_s = now - container.updated_at
            try:
                if self._remove_after_s > 0 and idle_s > self._remove_after_s:
                    provider.force_release(container.container_id)
                    _log.info(
                        "removed long-idle sandbox: container=%s idle_for=%.0fm",
                        container.container_id,
                        idle_s / 60.0,
                    )
                elif self._stop_after_s > 0 and idle_s > self._stop_after_s:
                    # An already-stopped container answers False, which is what
                    # keeps this from logging a reclamation that did not happen.
                    if provider.stop_idle(container.container_id):
                        _log.info(
                            "stopped idle sandbox: container=%s idle_for=%.0fm",
                            container.container_id,
                            idle_s / 60.0,
                        )
            except Exception:  # noqa: BLE001 - best effort, never blocks the others
                _log.debug(
                    "sandbox reap failed (continuing): %s",
                    container.container_id,
                    exc_info=True,
                )
