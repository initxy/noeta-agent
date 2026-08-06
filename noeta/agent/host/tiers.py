"""The execution tier: which projects run their tools inside a container.

One `Client` serves both tiers. The only thing that switches is
`HostConfig.sandbox_policy`, a callback the runtime consults once per root
task; `False` routes that task's file and shell tools to the local path, `True`
provisions a container for it.

**This is the whole of the tier mechanism, and that is deliberate** (see
`docs/adr/` once Phase 6 rewrites it; until then the reasoning lives here).
The design this replaces had a single process-wide switch that gated three
unrelated things at Client construction: whether `read` / `write` / `edit` /
`shell_run` were registered at all, whether the file surface answered, and
whether the container-runtime paragraph was appended to the system prompt.
Tools are compiled into the agent's identity once, at boot, so a per-project
property could not reach any of them. Three consequences fall out and all
three are load-bearing:

1. **The fs and shell tools are registered always.** A `local` project runs
   exactly the same compiled agent as a `sandbox` one — same tool set, same
   stable prefix, same KV cache — and only the execution environment behind
   those tools differs.
2. **The system prompt is tier-agnostic.** Anything the model needs to know
   about running inside a container is written per project into `AGENT.md`
   (see `workspace.py`), because that file is per project and the prompt is
   not.
3. **The file surface is not gated on a tier.** A `local` project has files
   too; they are simply the user's own.

## Why the policy keys on the directory and not the task

The signature is `(root_task_id, workspace_dir) -> bool`, but the root task id
is minted *inside* `seed_start` and reaches no database before the policy is
asked — verified: the callback fires synchronously on the seeding thread,
before `seed_start` returns. So the only usable key is `workspace_dir`, which
is the absolute path passed to `seed_start(workspace_dir=…)`, which is exactly
the Project directory.

The contract the runtime states for this callback is **cheap, total and
deterministic for a given session**, and the implementation below meets each:
cheap is one exact-match probe on the `projects.directory` UNIQUE index; total
means no workspace, an unusable path, a directory no project claims, or a
store that raises all answer `False` — the tier that needs nothing; and
deterministic is guaranteed by the runtime rather than by us, because the
answer is welded into `TaskHostBound` at `seed_start` and every later turn
fold-resolves it instead of asking again (verified: the policy fires once, on
`seed_start`, and never on `seed_send_goal`).

**Which makes changing a project's tier affect only sessions created
afterwards.** An existing session keeps the tier it was born with, forever.
That is not a limitation to work around — it is what makes the answer
deterministic across a resume — but it *is* product-visible, so the UI has to
say it rather than implying the switch is retroactive.
"""
from __future__ import annotations

import logging
import sqlite3

from noeta.agent.store import projects

logger = logging.getLogger(__name__)

# The tier vocabulary, matching the `projects.tier` column's CHECK constraint.
LOCAL = "local"
SANDBOX = "sandbox"


class TierPolicy:
    """Project directory -> execution tier, as `HostConfig.sandbox_policy`.

    Holds the app database connection; every read goes through the store's
    serialized access, so this is safe to call from the engine threads that
    actually invoke it."""

    def __init__(self, store: sqlite3.Connection) -> None:
        self._store = store

    def tier_for_directory(self, workspace_dir: str | None) -> str:
        """The tier a workspace directory runs at. `local` when unknown.

        Total: an empty, unusable or unclaimed directory is `local`, and so is
        a store that raises. The safe answer is the one that needs no
        infrastructure — an unexpected `sandbox` would try to start a container
        for a project nobody configured one for."""
        if not workspace_dir:
            return LOCAL
        try:
            project = projects.find_project_by_directory(self._store, workspace_dir)
        except Exception:  # noqa: BLE001 - see the docstring: total beats loud
            # This runs inside `seed_start` on the request thread. Raising here
            # fails the whole turn over a tier lookup, which is a strictly
            # worse outcome than running that turn on the local path.
            logger.exception("tier lookup failed for %s; defaulting to local", workspace_dir)
            return LOCAL
        return project.tier if project is not None else LOCAL

    def wants_container(self, root_task_id: str, workspace_dir: str | None) -> bool:
        """`HostConfig.sandbox_policy`: provision a container for this root task?

        `root_task_id` is part of the runtime's signature and is deliberately
        unused — at the moment of the call it names a task that exists nowhere
        but inside the seed, so there is nothing to look it up in. See the
        module docstring."""
        del root_task_id  # not knowable yet; the directory is the key
        return self.tier_for_directory(workspace_dir) == SANDBOX
