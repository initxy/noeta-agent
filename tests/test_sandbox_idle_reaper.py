"""The two-stage sandbox idle reaper.

Drives `SandboxIdleReaper.sweep` directly — no thread, no interval wait — with a
recording provider, and the thread lifecycle separately. What is pinned is the
policy: which level a container lands in, that `waiting` and `running` are never
reclaimed however overdue, that the two levels are independently disableable,
and that one failure never costs the rest of the sweep.

The D2 fold is pinned here too: the container is keyed on the *project*, so the
criterion is "no session of this project is running or waiting" — one busy
session keeps the whole project's container alive, and a session that never
seeded a task stream contributes nothing at all.
"""
from __future__ import annotations

import threading
import time

import pytest

from noeta.agent.host.reaper import (
    MIN_CHECK_INTERVAL_S,
    SandboxIdleReaper,
    SessionActivity,
    fold_activity,
)

NOW = 1_700_000_000.0
HOUR = 3600.0

STOP_AFTER_S = 1.0 * HOUR
REMOVE_AFTER_S = 24.0 * HOUR


class RecordingProvider:
    """Records which level each container landed in."""

    def __init__(self) -> None:
        self.stopped: list[str] = []
        self.released: list[str] = []

    def stop_idle(self, container_id: str) -> bool:
        self.stopped.append(container_id)
        return True

    def force_release(self, container_id: str) -> None:
        self.released.append(container_id)


def _session(
    container_id: str,
    *,
    status: str = "idle",
    hours_ago: float = 0.0,
    has_task_stream: bool = True,
) -> SessionActivity:
    return SessionActivity(
        container_id=container_id,
        status=status,
        updated_at=NOW - hours_ago * HOUR,
        has_task_stream=has_task_stream,
    )


def _reaper(
    *rows: SessionActivity,
    provider: RecordingProvider | None = None,
    stop_after_s: float = STOP_AFTER_S,
    remove_after_s: float = REMOVE_AFTER_S,
) -> tuple[SandboxIdleReaper, RecordingProvider]:
    provider = provider if provider is not None else RecordingProvider()
    reaper = SandboxIdleReaper(
        provider=provider,
        activity=lambda: rows,
        stop_after_s=stop_after_s,
        remove_after_s=remove_after_s,
        interval_s=MIN_CHECK_INTERVAL_S,
        now=lambda: NOW,
    )
    return reaper, provider


# --------------------------------------------------------------------------
# 52 — the two levels, and the partition between them
# --------------------------------------------------------------------------


def test_an_idle_container_past_the_stop_threshold_is_stopped_not_removed() -> None:
    """Level 1 keeps the body, the write layer, the mounts and the port
    mapping, so resume is a `docker start` rather than a rebuild."""
    reaper, provider = _reaper(_session("p1", hours_ago=2.0))

    reaper.sweep()

    assert provider.stopped == ["p1"]
    assert provider.released == []


def test_an_idle_container_past_the_remove_threshold_is_removed_not_stopped() -> None:
    """Level 2 is checked FIRST, so a very old container is removed outright
    instead of being stopped now and removed a day later."""
    reaper, provider = _reaper(_session("p1", hours_ago=30.0))

    reaper.sweep()

    assert provider.released == ["p1"]
    assert provider.stopped == []


def test_a_recently_idle_container_is_left_alone() -> None:
    reaper, provider = _reaper(_session("p1", hours_ago=0.5))

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == []


def test_one_sweep_partitions_a_mixed_batch() -> None:
    reaper, provider = _reaper(
        _session("to-stop", hours_ago=3.0),
        _session("to-remove", hours_ago=48.0),
        _session("too-fresh", hours_ago=0.2),
        _session("busy", status="running", hours_ago=48.0),
    )

    reaper.sweep()

    assert provider.stopped == ["to-stop"]
    assert provider.released == ["to-remove"]


# --------------------------------------------------------------------------
# 53 — waiting and running are never reclaimed
# --------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["waiting", "running"])
def test_a_busy_session_is_never_reclaimed_however_overdue(status: str) -> None:
    """`waiting` means a question is pending and the user may answer at any
    moment; `running` includes a task parked on a subtask barrier. Reclaiming
    either would make the next interaction wait for a container to boot."""
    reaper, provider = _reaper(_session("p1", status=status, hours_ago=99.0))

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == []


def test_one_busy_session_keeps_the_whole_project_container_alive() -> None:
    """The D2 consequence: all sessions of a project share one container, so
    the criterion is a fold across them, not a per-session decision."""
    reaper, provider = _reaper(
        _session("p1", status="idle", hours_ago=99.0),
        _session("p1", status="waiting", hours_ago=0.1),
    )

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == []


def test_idleness_is_measured_from_the_projects_newest_session() -> None:
    """An old session must not drag the project's container down while a
    sibling session was active minutes ago."""
    reaper, provider = _reaper(
        _session("p1", hours_ago=99.0),
        _session("p1", hours_ago=0.1),
    )

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == []


# --------------------------------------------------------------------------
# 54 — a session that never started a container is never scanned
# --------------------------------------------------------------------------


def test_a_session_with_no_task_stream_is_ignored_entirely() -> None:
    """A session the user opened and never wrote in has no engine task and
    therefore no container. Reaping it would issue docker calls against a name
    that has never existed, every single tick."""
    reaper, provider = _reaper(
        _session("p1", hours_ago=99.0, has_task_stream=False),
    )

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == []


def test_a_task_less_session_neither_makes_a_project_busy_nor_keeps_it_warm() -> None:
    """It contributes to neither half of the fold: it cannot hold a container
    open by being `running`, and its `updated_at` cannot reset the idle clock."""
    reaper, provider = _reaper(
        _session("p1", status="running", hours_ago=0.1, has_task_stream=False),
        _session("p1", status="idle", hours_ago=2.0),
    )

    reaper.sweep()

    assert provider.stopped == ["p1"]


def test_fold_activity_drops_task_less_and_unkeyed_rows() -> None:
    folded = fold_activity(
        [
            _session("p1", hours_ago=2.0),
            _session("p1", status="running", hours_ago=1.0),
            _session("p2", hours_ago=5.0, has_task_stream=False),
            _session("", hours_ago=5.0),
        ]
    )

    assert [row.container_id for row in folded] == ["p1"]
    assert folded[0].busy is True
    assert folded[0].updated_at == NOW - 1.0 * HOUR


# --------------------------------------------------------------------------
# 55 — either level can be disabled with a 0 threshold
# --------------------------------------------------------------------------


def test_disabling_stop_leaves_only_the_long_ttl_removal() -> None:
    reaper, provider = _reaper(
        _session("recent", hours_ago=3.0),
        _session("ancient", hours_ago=48.0),
        stop_after_s=0.0,
    )

    reaper.sweep()

    assert provider.stopped == []
    assert provider.released == ["ancient"]


def test_disabling_remove_keeps_every_container_recoverable() -> None:
    """With removal off, even a 999-hour container is only ever stopped — so
    `attach` can always bring it back."""
    reaper, provider = _reaper(_session("p1", hours_ago=999.0), remove_after_s=0.0)

    reaper.sweep()

    assert provider.stopped == ["p1"]
    assert provider.released == []


def test_both_levels_disabled_means_no_thread_at_all() -> None:
    reaper, provider = _reaper(
        _session("p1", hours_ago=999.0), stop_after_s=0.0, remove_after_s=0.0
    )

    assert reaper.enabled is False
    assert reaper.start() is False
    reaper.sweep()
    assert provider.stopped == []
    assert provider.released == []


# --------------------------------------------------------------------------
# 56 — failures are contained
# --------------------------------------------------------------------------


def test_one_container_failing_does_not_block_the_others() -> None:
    class FlakyProvider(RecordingProvider):
        def stop_idle(self, container_id: str) -> bool:
            if container_id == "boom":
                raise RuntimeError("docker is having a day")
            return super().stop_idle(container_id)

    provider = FlakyProvider()
    reaper, _ = _reaper(
        _session("boom", hours_ago=2.0),
        _session("fine", hours_ago=2.0),
        provider=provider,
    )

    reaper.sweep()

    assert provider.stopped == ["fine"]


def test_no_provider_is_a_safe_no_op() -> None:
    reaper = SandboxIdleReaper(
        provider=None,
        activity=lambda: [_session("p1", hours_ago=99.0)],
        stop_after_s=STOP_AFTER_S,
        remove_after_s=REMOVE_AFTER_S,
        interval_s=MIN_CHECK_INTERVAL_S,
        now=lambda: NOW,
    )

    reaper.sweep()  # passing without raising is the assertion


def test_an_already_stopped_container_is_not_counted_as_a_reclamation() -> None:
    """`stop_idle` answering False is what keeps the reaper from logging a stop
    that did not happen — and it must not disturb the rest of the sweep."""

    class AlreadyStopped(RecordingProvider):
        def stop_idle(self, container_id: str) -> bool:
            super().stop_idle(container_id)
            return False

    provider = AlreadyStopped()
    reaper, _ = _reaper(
        _session("p1", hours_ago=2.0),
        _session("p2", hours_ago=2.0),
        provider=provider,
    )

    reaper.sweep()

    assert provider.stopped == ["p1", "p2"]


# --------------------------------------------------------------------------
# The thread itself
# --------------------------------------------------------------------------


def test_the_interval_has_a_one_minute_floor() -> None:
    """A tiny configuration must not make the thread busy-spin over the store."""
    reaper = SandboxIdleReaper(
        provider=RecordingProvider(),
        activity=list,
        stop_after_s=STOP_AFTER_S,
        remove_after_s=REMOVE_AFTER_S,
        interval_s=0.001,
    )

    assert reaper.interval_s == MIN_CHECK_INTERVAL_S


def test_from_hours_converts_all_three_thresholds() -> None:
    reaper = SandboxIdleReaper.from_hours(
        provider=RecordingProvider(),
        activity=list,
        stop_hours=1.0,
        remove_hours=24.0,
        check_interval_hours=0.5,
    )

    assert reaper.enabled is True
    assert reaper.interval_s == 0.5 * HOUR


def test_start_and_stop_run_a_daemon_thread_that_shuts_down_promptly() -> None:
    """The loop waits on an event rather than sleeping, so `stop()` returns at
    once instead of after up to a full interval — which is what keeps process
    shutdown from hanging for a minute."""
    reaper = SandboxIdleReaper(
        provider=RecordingProvider(),
        activity=list,
        stop_after_s=STOP_AFTER_S,
        remove_after_s=REMOVE_AFTER_S,
        interval_s=MIN_CHECK_INTERVAL_S,
    )
    before = {thread.name for thread in threading.enumerate()}

    assert reaper.start() is True
    assert "sandbox-idle-reaper" in {t.name for t in threading.enumerate()} - before

    started = time.monotonic()
    reaper.stop()

    assert time.monotonic() - started < 5.0
    assert "sandbox-idle-reaper" not in {t.name for t in threading.enumerate()} - before


def test_a_failing_tick_is_swallowed_so_the_patrol_survives_it() -> None:
    """`tick` is the loop body. The store read happens on the patrol thread, so
    a transient failure there must cost one tick and not the reaper."""
    calls: list[int] = []

    def activity() -> list[SessionActivity]:
        calls.append(1)
        raise RuntimeError("store is down")

    reaper = SandboxIdleReaper(
        provider=RecordingProvider(),
        activity=activity,
        stop_after_s=STOP_AFTER_S,
        remove_after_s=REMOVE_AFTER_S,
        interval_s=MIN_CHECK_INTERVAL_S,
    )

    reaper.tick()
    reaper.tick()

    # Raised twice, escaped neither time.
    assert calls == [1, 1]
    # And the unguarded sweep really would have raised, so the guard is the
    # thing being tested rather than an activity that never fails.
    with pytest.raises(RuntimeError):
        reaper.sweep()
