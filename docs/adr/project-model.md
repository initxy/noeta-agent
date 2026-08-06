# A Project is one real directory on the user's machine, and every session of that project shares it

## Context

The product is a single-user, local-first workbench. The scoping unit it
inherited — the **Space** — was a unit of *collaboration*: membership, roles,
sharing, and a pile of space-scoped resources (skills, knowledge, templates).
With multi-user deleted, none of that vocabulary describes anything; what
remains is the one thing a person on their own machine actually organizes work
by, which is **a directory they already have**.

Something still has to be scoped, though. An agent brings a persona, a default
model, MCP connectors, a memory pool and an execution environment to a
conversation, and those cannot hang off individual sessions without being
retyped every time. The question this record answers is what that container is,
and — the part with real consequences — whether sessions inside it get their own
workspace or share one.

## Decision

A **Project** is one directory on the user's machine, plus the sessions held
against it and the configuration the agent brings to them: persona, default
model and reasoning effort, execution tier, MCP connectors, memory toggle.

- **The directory is real and pre-existing.** It is stored absolute and
  normalized, and it is `UNIQUE` across projects. Creating a project against a
  directory that is not there is refused (422); creating one is opt-in
  (`create_directory`), because a typo that silently mints `~/Documnets/app` is
  a directory the user never finds again, while a typo that fails is one they
  fix in the form.
- **All sessions of a project share that directory as their workspace root.**
  There is no per-session scratch directory and no copy. A session is a
  conversation about the project, not a private sandbox.
- **Every derived placement keys on the project, not the session**: agent memory
  (`DATA_DIR/memories/<project_id>/`), the sandbox container
  (`noeta-sbx-<project_id>`), and MCP connector aliases.
- **Deleting is asymmetric with creating.** Deleting a project removes its rows
  — sessions, task streams, connectors, by `ON DELETE CASCADE` — and **never
  touches the directory**. Deleting a session removes neither the directory nor
  anything in it, because the directory belongs to the project and sibling
  sessions are still using it.
- **Nothing locks.** Two live sessions of one project can write the same file at
  the same time, and the product does not prevent it.

## Rationale

- **The user's model is "work on *this* project".** They point the agent at a
  repository they already have; the value of the local tier is precisely that it
  operates on their real files. A per-session scratch directory would make every
  new session start from nothing, make the local tier pointless, and turn
  "continue this work tomorrow" into "copy the files across".
- **Shared state is what makes a second session useful.** Memory keyed to the
  project is recallable in the next session; a container keyed to the project is
  warm for the next session; a connector configured once serves all of them. Key
  any of those on the session and each one silently becomes single-use.
- **The directory is also the only key available at the moment it is needed.**
  The execution tier is resolved by a runtime callback that receives
  `workspace_dir` and a root task id that does not yet exist anywhere
  (see [execution-tier-per-project](execution-tier-per-project.md)). A project
  identified by its directory answers that question with one indexed probe;
  `UNIQUE` on the column is what makes it an exact-match lookup rather than a
  scan, and what makes "two projects over one directory" impossible rather than
  merely discouraged.
- **Not locking is cheaper than locking badly.** The conflicts are real but
  narrow: one person, a handful of sessions, and an agent that reads before it
  writes. A lock manager over a directory the user is also editing in their own
  editor would either be advisory (and therefore a lie) or would block the user
  out of their own files. The honest answer is to accept the conflict and pay
  for it where it actually shows up — at save time.

## Alternatives considered

1. **A per-session workspace directory** (what the deleted platform did: one
   directory per session under `DATA_DIR/workspaces/`). Rejected: it makes the
   `local` tier meaningless — the agent would be editing a scratch copy of
   nothing — and it turns continuity into a copy operation. The old product got
   away with it because the agent's whole world was the sandbox; this one's
   world is the user's disk.
2. **Copy-on-write per session** (clone the directory in, merge back out).
   Rejected: the merge is the whole problem, moved later and made worse. A
   three-way merge over arbitrary binary and text files, with no reviewer, is a
   feature nobody asked for and nobody would trust.
3. **File locking or a session-exclusive project** ("only one live session per
   project"). Rejected: the second is a hard limit on the main reason to have
   sessions at all (a long-running task in one, a question in another), and the
   first cannot see the user's own editor, so it protects against the least
   likely writer.
4. **Project as a pure label with no directory** (workspace picked per session).
   Rejected: it re-introduces per-session workspaces with extra steps, and the
   tier lookup loses its key.
5. **Keeping Space and adding a directory to it.** Rejected: Space's meaning is
   membership. Keeping the word while deleting everything it meant is how a
   vocabulary rots — and `CONTEXT.md` already flagged that "Workspace" was taken
   by the library, which is why the replacement is `Project` rather than
   `Workspace`.
6. **Keying memory and the container on the session** (the shape the deleted
   product had). Rejected: memory that dies with the conversation is not
   long-term memory, and a container per session over one bind-mounted directory
   means N containers fighting over the same files with N cold starts.

## Consequences

- **Concurrent sessions can conflict on disk, and this is accepted.** Two
  consequences are downstream of exactly that, and neither is optional:
  - **`rewind` is exposed with guardrails, not withheld.** The engine has it,
    and it restores workspace files — which under a shared directory means
    rewinding session A reverts what session B wrote. Rather than withhold the
    verb, the product exposes it as "undo last turn" and states that risk: an
    explicit file-rollback warning at the confirm step, offered on the latest
    committed user message of a **root** session only (fork children excluded
    for v1), and refused while a turn is in flight. `fork` remains the "edit
    that message and try again, keep the original" path — it shares the
    workspace without writing the source stream and restores nothing.
  - **Artifact conflict handling shipped with the first editable artifact**
    rather than being deferred. The editor's save is optimistically locked on
    the `mtime` it read, and a mismatch is a `409` the UI answers with "reload
    theirs / overwrite with mine". Under a shared directory, a silently failing
    save is not an edge case — the other writer is the agent, mid-turn.
- **The container is a project resource with a project's lifetime.** The idle
  reaper's criterion is "no session of this project is running or waiting", so
  one busy session keeps the whole project's container alive; and **session
  deletion must not release the container**, because a sibling session may still
  be in it. Deleting the *project* is what releases it.
- **A resolution failure must not leak across projects.** The memory-root
  resolver never answers "no root" — that would fall through to a shared pool —
  so an unresolvable task lands in `memories/_quarantine`. Better no memory than
  another project's memory.
- **The project-creation UI has to state the sharing rule.** A user who thinks
  sessions are isolated will eventually be surprised by a file, and the moment to
  say so is when they create the project, not when they lose work.
- **A second project on the same directory is a `409`**, not a merge and not a
  silent alias.
