"""Agent memory roots: one pool per project, and a quarantine for the rest.

`HostConfig.memory_root_resolver(task_id) -> Path | None` is the one hook the
whole memory stack resolves through — the engine build, auto-recall, the
memory tools and `Client.memory_root` all take the same chain. This module
supplies it, keyed on the **project**:

    DATA_DIR/memories/<project_id>/      one pool, shared by every session
    DATA_DIR/memories/_quarantine/       everything that cannot be resolved

Keying on the project rather than the session is what makes memory worth
having: sessions in a project are the same body of work, so a memory written
in one has to be recallable in the next.

## The quarantine is the point, not a leftover

The resolver **never returns `None`**, and that is a decision rather than an
accident. `None` means "no answer" to the runtime, which then falls through to
`HostConfig.memory_dir`, `global_memory_dir` and finally `~/.noeta/memories` —
every one of which is a *shared* pool. So the one case that most needs to be
safe, a task whose project cannot be resolved, would be routed into the pool
every project can read. A resolution failure must yield **no recall**, never
another project's recall: better no memory than the wrong memory.

Engines are cached per resolved root, so the quarantine is also structurally
isolated rather than merely empty by convention.

## The seeding window

A new session's root task id is minted *inside* `seed_start`, and — verified
against 0.5.1, correcting the host guide, which says a mapping registered
between `seed_start` and the dispatch is early enough — **the resolver is
already called during `seed_start` itself**, three times, synchronously on the
thread that called it. A resolver that only reads the durable task->session
index would therefore quarantine the very first engine of every new session,
and that engine is cached under the quarantine root.

`seeding(project_id)` closes the window: the turn driver holds it around the
seed call, and because the resolver runs on that same thread the pending
project is a **thread-local**, not a process-wide slot. Two requests seeding
two sessions concurrently cannot see each other's project, which is the exact
race the equivalent process-wide slot in the design this replaces had to be
reasoned about with four hand-written lock-free invariants.

The window itself lives in `host/seeding.py` rather than here, because the
container-id resolver needs the identical answer at the identical moment and
two windows opened by two `with` statements is one `with` away from
disagreeing.

The durable binding written between the seed and the dispatch
(`sessions.add_task_stream`) is what answers every *later* call, on worker
threads and after a restart, so the thread-local is a window and not a cache.

Contract, as the runtime states it: cheap (one primary-key probe), total
(never raises, always answers) and deterministic per task id.
"""
from __future__ import annotations

import logging
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from noeta.agent.host.seeding import SEEDING
from noeta.agent.store import sessions

logger = logging.getLogger(__name__)

# The pool for tasks whose project cannot be resolved. The leading underscore
# keeps it out of the project-id namespace: ids are uuid4 hex, so no project
# can ever claim this directory.
QUARANTINE_NAME = "_quarantine"

# A project id must be usable as a single path segment. Ids are uuid4 hex, so
# this never rejects a real one — it exists so that a corrupted or
# hand-edited row cannot turn a memory root into a path traversal.
_SAFE_SEGMENT = re.compile(r"\A[A-Za-z0-9_-]{1,128}\Z")


class MemoryRoots:
    """Task id -> the memory pool that task may read and write.

    One instance per process, wired as `HostConfig.memory_root_resolver`."""

    def __init__(self, store: sqlite3.Connection, memories_path: Path) -> None:
        self._store = store
        self._root = memories_path

    # -- roots ---------------------------------------------------------------

    @property
    def quarantine_root(self) -> Path:
        return self._root / QUARANTINE_NAME

    def root_for_project(self, project_id: str) -> Path:
        """The pool of one project, or the quarantine for an unusable id."""
        if not project_id or not _SAFE_SEGMENT.match(project_id):
            logger.warning("unusable project id for a memory root: %r", project_id)
            return self.quarantine_root
        return self._root / project_id

    # -- the seeding window --------------------------------------------------

    @contextmanager
    def seeding(self, project_id: str) -> Iterator[None]:
        """Name the project of the turn being seeded on this thread.

        Held around `seed_start` / `seed_send_goal` so *every* resolver that
        runs inside the seed can answer for a task id that does not exist in
        the store yet — the memory root here, and the container id in
        `host/sandbox.py`. One window, so the two cannot disagree."""
        with SEEDING.project(project_id):
            yield

    # -- the resolver ---------------------------------------------------------

    def resolve(self, task_id: str | None) -> Path:
        """`HostConfig.memory_root_resolver`. Total: always a real path.

        Order: the durable task->session->project index first, so a resumed
        task after a restart resolves the same pool it wrote to; then the
        thread-local seeding window, which is the only thing that knows a task
        id minted moments ago; then the quarantine."""
        binding = None
        if task_id:
            try:
                binding = sessions.find_task_binding(self._store, task_id)
            except Exception:  # noqa: BLE001 - total beats loud on this path
                # Raising would fail the turn over a memory lookup. Falling
                # through costs at worst this turn's recall.
                logger.exception("memory root lookup failed for task %s", task_id)
        if binding is not None:
            return self.root_for_project(binding.project_id)

        pending = SEEDING.current()
        if pending:
            return self.root_for_project(pending)

        # A subtask id is unknown to the reverse index by construction (only
        # root and branch streams are bound), and so is any task from a
        # deleted project. Both land here, which is the safe answer.
        logger.debug("no project for task %r; using the memory quarantine", task_id)
        return self.quarantine_root
