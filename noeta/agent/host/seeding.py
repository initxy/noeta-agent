"""Which project is being seeded on **this** thread.

`seed_start` mints a new task id *inside* the call, and — verified against
0.5.1 — the host's resolvers run during that call, synchronously, on the thread
that made it. Anything keyed on "which project does this task belong to"
therefore has a window in which the durable `task -> session -> project` row
does not exist yet, because it is written between the seed and the dispatch.

Two resolvers live in that window and they must not disagree:

- **the memory root** (`host/memory.py`). Missing it sends a new session's
  first engine to the quarantine, and the engine is *cached* under whatever
  root it resolved — so the miss lasts for the process, not for the call.
- **the container id** (`host/sandbox.py`). Missing it names the container
  after the root task instead of the project, and since every later turn
  `attach`es to that durable name, the session keeps a container of its own for
  its whole life. Two sessions of one project then never share a container,
  which is D2's derived placement quietly not happening — visible as a preview
  panel that 404s on a session that is demonstrably running in one.

**Thread-local, never a process-wide slot.** Two requests seeding two sessions
concurrently must not see each other's project, and a nested seed (a memory
consolidation run triggered from a turn boundary) must restore its caller's
value rather than clear it.

It is a *window*, not a cache: the durable binding answers every later call, on
worker threads and after a restart.
"""
from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Optional


class SeedingWindow:
    """The project of the turn being seeded on the calling thread."""

    def __init__(self) -> None:
        self._local = threading.local()

    @contextmanager
    def project(self, project_id: str) -> Iterator[None]:
        previous = getattr(self._local, "project_id", None)
        self._local.project_id = project_id
        try:
            yield
        finally:
            self._local.project_id = previous

    def current(self) -> Optional[str]:
        """The project being seeded here, or `None` outside a window."""
        value = getattr(self._local, "project_id", None)
        return value if isinstance(value, str) and value else None


#: One per process, because the *thread* is the scope that matters and a
#: per-instance window would have to be threaded to the sandbox provider, which
#: is built before the host that opens it.
SEEDING = SeedingWindow()
