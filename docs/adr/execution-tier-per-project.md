# The execution tier is a per-project choice carried by `sandbox_policy` keyed on the workspace directory, and it is welded into a session at its first turn

## Context

Where the agent's file and shell tools actually run — this machine, or a
container — used to be a **process-wide switch**. That switch was read at
`Client` construction and gated three unrelated things at once: whether
`read` / `write` / `edit` / `shell_run` were registered at all, whether the
workspace file surface answered, and whether a container-runtime paragraph was
appended to the system prompt.

A local-first workbench cannot answer that question once for the whole process.
The same person wants their own repository edited directly (no container, no
cold start, the files are already theirs) and an untrusted scratch project's
commands contained. The choice belongs to the project.

The runtime offers exactly one seam for it:
`HostConfig.sandbox_policy(root_task_id, workspace_dir) -> bool`, consulted once
per root task, where `True` provisions a container for that task and `False`
routes its tools to the local path. Everything below follows from taking that
seam seriously — including what it can and cannot know at the moment it is
asked.

## Decision

**The execution tier (`local` | `sandbox`) is a property of the Project, and
`sandbox_policy` is the whole of the mechanism.** One `Client` serves both
tiers.

- **The policy keys on `workspace_dir`, not on the task.** `root_task_id` is
  minted *inside* `seed_start` and reaches no database before the callback
  fires, on the seeding thread, synchronously. `workspace_dir` is the absolute
  path passed to `seed_start(workspace_dir=…)`, which is exactly the project
  directory — one indexed probe on the `projects.directory` UNIQUE column.
- **The policy is total.** No workspace, an unusable path, a directory no
  project claims, or a store that raises all answer `local` — the tier that
  needs no infrastructure. It runs on the request thread inside `seed_start`, so
  raising there would fail a whole turn over a tier lookup.
- **The fs and shell tools are registered always.** A `local` project runs the
  same compiled agent as a `sandbox` one: same tool set, same stable prefix,
  same KV cache. Only the execution environment behind the tools differs.
- **The system prompt is tier-agnostic.** What the model needs to know about
  running inside a container is written per project into `AGENT.md` in the
  project directory, because that file is per project and the prompt is not.
- **The file surface is not gated on the tier.** A `local` project has files
  too; they are simply the user's own. Reads and writes go through the host-side
  directory in both tiers.
- **The tier is welded at session start.** The runtime records the policy's
  answer in `TaskHostBound` at `seed_start`, and every later turn fold-resolves
  it instead of asking again. **Changing a project's tier therefore affects only
  sessions created afterwards**, and the UI says so rather than implying the
  switch is retroactive.
- **Permissions are bypassed in both tiers**, so the tier is the *only* thing
  that changes between them. There is no approval prompt anywhere in the
  product.
- **Docker availability is advisory, not a gate.** `/health.sandbox_available` is
  a live, cached, off-loop `docker version` probe that the UI uses to hide a tier
  the machine cannot run. It does not override a project's stored tier.

## Rationale

- **The directory is the only key that exists when the question is asked.** This
  is not a preference; it was verified against the runtime. Any design keyed on
  the root task id needs a mapping registered before `seed_start` returns, and
  there is no such moment.
- **Determinism across resume is a hard requirement, and the weld is what
  provides it.** A policy re-read live would let a task that started in a
  container resume outside one after the user flipped a setting — the same
  conversation, half its files written in two different worlds. Because the
  answer is durable, the product does not have to keep the store and the running
  task in agreement; it only has to be honest that the switch is not
  retroactive.
- **Tools are compiled into agent identity once, at boot, so a per-project
  property cannot reach them.** That is a fact about the runtime, and the three
  structural consequences above are what it forces. Registering tools
  conditionally would mean one `Client` per tier — two engines, two caches, and
  a stable prefix that differs by deployment.
- **A tier-agnostic prompt is also a better prompt.** Container facts cost
  context on every request for every project, including the ones that will never
  see a container; `AGENT.md` charges them only to the projects that need them,
  and is re-rendered from the project row on every turn, so a tier change shows
  up in the next message.
- **Gating the file surface on the tier was always a category error.** It looked
  right when the container was the agent's whole world. Once execution is a
  per-project choice, "does this session have files" and "does this session have
  a container" are simply different questions.
- **Totality beats loudness in a callback the engine owns.** The failure mode of
  a wrong `False` is "this turn ran locally"; the failure mode of an exception is
  "this turn did not run".

## Alternatives considered

1. **Keep the global switch** (`SANDBOX_ENABLED`). Rejected: it cannot express
   the product's central choice, and it conflated three decisions that have
   nothing to do with each other. It is retired, and `extra="ignore"` means a
   stale `.env` carrying it simply boots.
2. **One `Client` per tier.** Rejected: two engines, two worker pools, two
   caches and two stable prefixes, to vary one callback's return value. The
   runtime already offers the per-task seam.
3. **Read the tier live on every turn instead of welding it.** Rejected: it
   breaks the runtime's own contract for the callback (deterministic for a given
   session) and produces conversations whose files live in two places. The cost
   of the weld — a per-session tier that cannot be changed — is smaller and can
   be explained.
4. **Make the tier a session property rather than a project one.** Rejected: the
   key available to the policy is the directory, and all sessions of a project
   share it. Two tiers over one directory means a container bind-mounting a
   directory another session is editing directly, with no way to tell them apart
   at the seam.
5. **Register `shell_run` only for `sandbox` projects** ("local means no shell").
   Rejected: it re-creates the identity problem (tools are compiled once), and a
   local coding agent without a shell cannot run the user's tests, which is most
   of the value.
6. **Refuse to run a `sandbox` project when Docker is missing.** Rejected in
   favor of the runtime's own behavior: with no provider wired, `sandbox_policy`
   is never consulted and the task runs local. Failing the turn would strand a
   project on a machine that changed; the honest mitigation is the health probe
   plus a UI that hides the tier — see the consequence below, which is the sharp
   edge of this choice.
7. **A per-call permission prompt as the safety story for `local`.** Rejected as
   a non-goal of the product: there is no approval UI, and a turn parked on an
   unanswerable approval is a hung conversation. The safety story is the tier
   choice itself, stated plainly, plus the write wall.

## Consequences

- **`local` runs the agent on the user's machine with no isolation and no
  approval gate.** Writes are fenced to the project directory by the runtime's
  single-root wall (`write_roots` is deliberately left unset — an
  out-of-workspace write simply fails, which is the honest answer when there is
  no approval UI to ask for a grant); **`shell_run` is not fenced**. This is an
  explicit decision and is stated in the project-creation UI, in `README.md` and
  in `.env.example`.
- **A `sandbox` project on a machine with no Docker silently runs local.**
  `sandbox_policy` is never consulted when no provider is wired. The health
  probe and the UI exist because of this, and it is the one place where the
  stored tier and the actual execution can disagree.
- **A session's tier is fixed for its life.** The tier control belongs on the
  project, worded as affecting new sessions.
- **The container is keyed on the project** (see
  [project-model](project-model.md)), so the two decisions have to be read
  together: the tier says *whether* there is a container, the project model says
  *which* one and *whose*.
- **`AGENT.md` is a workaround and is documented as one.** It exists because
  there is no per-project `AgentDefinition` seam; when the SDK grows one, the
  file goes away. It is written idempotently, never overwrites a file it did not
  write (it carries a generated-by marker), and never blocks a turn.
