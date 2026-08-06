# Noeta Agent

The **official Noeta product**: a single-user, local-first **agent workbench**.
A FastAPI backend that consumes `noeta-sdk` in-process, plus a
React/TypeScript SPA it serves — shipped as **one process** you run on your own
machine, against your own directories, with no accounts and no login.

This `CONTEXT.md` pins the vocabulary the **product** owns. The engine and
library terms it builds on (Task, Subtask, EventLog, ContextComposer, ExecEnv,
Skill, Memory, Options, Policy, …) live in the sibling `noeta` monorepo's
`CONTEXT.md` and are **not** repeated here; where a product term rides on a
library term, the entry names it and stops.

## Where the product sits

The runtime + SDK are two pure, in-process libraries with no HTTP:

- **noeta-runtime** — the pure engine: durable, event-sourced task execution
  (Engine / fold / scheduler), the builtin tools, providers, context assembly,
  policies. A transitive dependency; product code never imports it directly.
- **noeta-sdk** — the thin client facade and **the only public surface**:
  `query()` / `Client` / `Options` / `@tool`, the extension protocols, the
  storage adapters (`noeta.sdk.storage`), and the official agents in
  `noeta.presets`. The product imports **only** `noeta.sdk` / `noeta.presets`.

**noeta-agent** (this repo) is the layer that **owns the HTTP/SSE server** —
the only layer with a network surface. Product code lives under the
`noeta.agent.*` namespace (PEP 420: the `noeta.agent` identity layer's
spec/registry are published by noeta-runtime; this dist publishes the product's
`api` / `host` / `store` modules into the same namespace).

**Import boundary (enforced).** import-linter forbids `noeta.agent.*` from
reaching any runtime internal directly (`noeta.builtins` / `noeta.client` /
`noeta.context` / `noeta.core` / `noeta.execution` / `noeta.observers` /
`noeta.policies` / `noeta.protocols` / `noeta.read_models` / `noeta.runtime` /
`noeta.storage` / `noeta.testing` / `noeta.tools`) — it may import only
`noeta.sdk` / `noeta.presets` (contract in `pyproject.toml`, run by
`make check`). Reaching an internal *transitively through* `noeta.sdk` is the
intended path and is allowed. The **two documented exemptions** are the
sandbox-adapter modules `noeta.agent.host.sdk_sandbox_exec_env` (may import
`noeta.builtins.sandbox.impl.exec_env`) and
`noeta.agent.host.sdk_browser_backend` (may import
`noeta.builtins.sandbox.impl.browser`): they extend the concrete AIO adapters
kept **off** the public surface on purpose (the surface exposes only the
`ExecEnv` / `BrowserBackend` protocols and their factory types). The list may
only shrink, and an exemption is declared in the same change that adds its
adapter — never ahead of it.

## The entry point and the wire

There is **no operator CLI**. The only entrypoint is `python -m noeta.agent` —
zero-argument, env-only (`./.env` + environment variables; see
`noeta/agent/config.py`) — which boots the backend (FastAPI + uvicorn) and
serves the SPA build from `web/dist`. With every key empty it runs fully
offline against the mock provider: no credentials, no Docker, no login screen.

The frontend-backend wire is the **product contract**, and it is normative:
[`docs/reference/wire-contract.md`](docs/reference/wire-contract.md)
holds the UI-event vocabulary, the SSE framing and startup order, the REST
surface and the session status machine. In outline: a versioned REST surface
under `/api/v1/*` plus **one SSE stream per session**
(`GET /api/v1/sessions/{id}/events`) carrying **translated flat UI events**.
Replay is **re-derivation, not a stored projection**: a reconnect passes
`since_seq`, the backend re-reads the EventLog through the Client read surface
and re-runs the same translation. Ephemeral `delta` frames (token-streaming
previews with **no SSE id**) ride the same stream, are never persisted and never
replayed — the appended message event stays the only durable record. Raw
`EventEnvelope`s are served **only** on the trace surface
(`GET /api/v1/trace/sessions/{id}/raw-events`) — a diagnostics surface, not the
product contract.

## Vocabulary

All terms below are **application-layer only**. None exists below the
application layer: the engine knows only Tasks.

**Project**:
One directory on the user's machine, plus the sessions held against it and the
configuration the agent brings to them: persona, default model + reasoning
effort, **execution tier**, MCP connectors, memory toggle. The directory is
real, absolute, and unique across projects (a UNIQUE column, because it is also
the tier lookup's key). **All sessions of a project share that directory** as
their workspace root, so two live sessions can conflict on disk; there is no
locking, and that is an accepted consequence rather than an oversight.
Derived placements all key on the project: agent memory
(`DATA_DIR/memories/<project_id>`), the sandbox container name
(`noeta-sbx-<project_id>`), and MCP connectors.
_Avoid_: Space (deleted — there is no membership, no sharing, no owner),
Workspace (a library term: a task's file root), Folder.

**Session**:
The application-layer unit of conversation — what the sidebar lists, pins,
archives, resumes and deletes. Owns **one or more task streams** (see below):
it is created with none, the first message seeds the first, and every `fork`
appends a sibling. Its `status` is exactly `idle` / `running` / `waiting`,
derived from the envelope stream and persisted for the index.
**App-layer indexing only**: the row lives in `app.db`; every state change
still flows through `noeta.sdk` `Client` verbs and the EventLog stays the
single source of truth.
_Avoid_: Conversation, Thread; collapsing a Session onto one task id; using
Session for anything below the application layer (there it stays a non-concept
— see the flagged ambiguities).

**Task stream**:
One engine task belonging to a session, with its own `seq` space starting at 0.
Recorded in `session_task_streams` with `kind` (`root` | `branch`) and, for a
branch, the durable lineage (`source_task_id`, `branched_at_seq`) — durable
because the `branch_created` UI frame is synthetic and never replays. Every UI
frame carries `data._task`, and the SSE endpoint takes an optional `?task_id=`
filter.
_Avoid_: calling it a session; assuming one session = one task id.

**Turn**:
One user message and everything the agent does until it parks — the unit the
conversation renders around (one turn block owns the fold, the file strip and
the action bar). Bounded on the wire by `turn_started` and `turn_finished`,
whose `status` says how it ended: `awaiting_input` / `completed` / `cancelled` /
`failed` / `interrupted` / `turn_failed`. **`turn_failed` is resumable and
`failed` is not** — a provider fault parks the turn and the next ordinary
message resumes the same stream with full context.
_Avoid_: Message (a turn is many), Step (that is the engine's loop slice), Run.

**Branch**:
A sibling task stream inside **one** session, created by
`POST /sessions/{id}/fork` at a user message. Not a new session, and not a
rewind: both branches share the project directory and `fork` restores no files.
The client switches which branch it renders; the transcript is a pure
projection of one fold over every stream the session owns.
_Avoid_: Fork-as-new-session, Checkpoint.

**Rewind** ("undo last turn"):
`POST /sessions/{id}/rewind` at a user message re-bases **this** stream in
place — the message and everything after it become dead history — and
**restores workspace files** to their pre-turn state. Distinct from a branch,
which keeps both paths and touches no files. Because a project's sessions share
one directory, undo can revert another session's work, so it carries an
explicit rollback warning and is offered on the latest committed message of a
root session only (v1).

**UI event**:
One frame of the product wire vocabulary (`user_message`, `assistant_text`,
`thinking`, `recall`, `tool_call` / `tool_result`, `memory_op`,
`skill_activated`, `todo_update`, `subtask_started` / `subtask_finished`,
`question`, `question_answered`, `compaction`, `llm_retry`, `turn_started` /
`turn_finished`, `error`, plus the synthetic frames `delta`, `replay_done`,
`session_meta` and `branch_created`). Produced by the **translator** — a
deterministic, stateless, pure function over `EventEnvelope`s
(`noeta.agent.host.translator`) that imports no engine type; replay and live
share the same function, so the stream cannot drift from the log. A **durable**
frame carries a `seq` and replays; a **synthetic** frame carries `seq = null`,
no SSE `id:`, and never replays.
_Avoid_: calling raw `EventEnvelope`s UI events (raw envelopes are the trace
surface only); "projection" (implies a stored copy — replay is re-derivation).

**Execution tier**:
A per-project choice of where the agent's file and shell tools actually run:
`local` (this machine, no container) or `sandbox` (a Docker container with the
project directory bind-mounted). Implemented as `HostConfig.sandbox_policy`
keyed on `workspace_dir` — which *is* the project directory — because at the
moment the runtime asks, the root task id exists nowhere yet. Tools are
registered **always** and the system prompt is **tier-agnostic**; only the
execution environment behind the tools changes. The answer is welded into the
task at `seed_start`, so **changing a project's tier affects only sessions
created afterwards**.
_Avoid_: a global sandbox switch (`SANDBOX_ENABLED` is retired), "sandbox mode",
treating `local` as "no file surface" (a `local` project has files too).

**MCP connector**:
A per-project MCP server configuration: alias + transport (`http` | `stdio`) +
credentials + an enabled tool subset, stored in `app.db` and
**credential-scrubbed on every read** (a read path returns sorted
`header_names` / `env_names`, never values — the store hands out a type that
cannot carry one). A per-turn resolver hands the enabled connector specs into
the SDK host; connector tools appear to the model as `mcp__<alias>__<tool>`,
which is why an alias cannot be silently reused.
_Avoid_: global MCP registry (retired), plugin.

**Agent-config**:
The project's agent configuration: persona prompt, default model + reasoning
effort for new turns, and the memory toggle. Read and written as one document
through `GET/PUT /api/v1/projects/{id}/agent-config`; the same fields are also
patchable on the project row. The persona is materialized into the project
directory as `AGENT.md` at assembly (singular, so it cannot collide with the
SDK's own `AGENTS.md` instruction file) — a **workaround**, not a design goal:
agent definitions are compiled into identity once at `Client` construction, so
a per-project persona has no runtime seam to live in.
_Avoid_: Options (that is the SDK-level agent configuration), Settings (that is
server config).

**Artifact**:
A file in the project directory worth opening in the side panel — a report, a
sheet, a page the agent wrote. **The client guesses and the server decides**:
the client derives *candidates* from the transcript (a provenance-weighted
scan), and `POST /api/v1/sessions/{id}/artifacts/resolve` stats them through
the file surface and overwrites `exists` / `size` / `updatedAt` / `preview`.
Nothing is collectible before that round trip — `exists` is `boolean | null`
and a candidate carries no resolution fields at all, so "uncollectible before
resolve" is a type invariant. Editing is optimistically locked: a save carries
the `base_mtime` it read, and a mismatch is **409 `file_conflict`**.
_Avoid_: ContentRef-backed Artifact (that is the library term for a
tool-produced blob in the ContentStore), Attachment, Document.

**SandboxProvider** (product-owned side of the execution seam):
The seam that **provisions and reaps** a sandbox container — the "who runs
`docker`" layer, distinct from the library's `ExecEnv` (which *talks to* an
already-running container). Defined in the SDK (`noeta.sdk`), **implemented
here** as `LocalDockerSandboxProvider`, whose container's natural key is the
**project** (`noeta-sbx-<project_id>`), because all sessions of a project share
one directory and per-session containers would fight over it. `allocate` builds
a fresh container and returns a `SandboxHandle`; `stop_idle` reclaims memory and
CPU while keeping the container attachable; `force_release` reclaims disk and is
irreversible; `attach` reconnects to a recorded ref on resume. The product also
injects the `agent-sandbox`-SDK-backed adapters `SdkSandboxExecEnv` /
`SdkBrowserBackend` through `HostConfig.sandbox_backend_factory` /
`sandbox_browser_factory`. Provisioning + lifecycle belong to this **product**
layer; the mechanism (`ExecEnv`) belongs to the runtime; the binding (durable
`exec_env_ref`, reconnect) to the SDK.
_Avoid_: conflating the provider with the SDK-side `SandboxExecEnvManager`
(the manager drives the provider) or with `ExecEnv` construction; releasing a
container on **session** deletion (a sibling session may still be using it —
deleting the *project* is what releases it).

## Flagged ambiguities

**"Session"** below the application layer is a **non-concept**: the engine knows
only Tasks. Do not let session ids or session event schemas appear in library
identifiers you touch, and read every SDK parameter that looks like it wants a
session id as wanting a **task id**. The product wire *may* key on session ids
because the application owns that wire (its event vocabulary is the translated
UI events).

**"Workspace"** is a library term — a task's file root. In this product that
root is the **project directory**, shared by every session of the project; it is
not a per-session scratch space, and `DATA_DIR/workspaces/` is only the fallback
root for what has no project directory to live in.

**"Sandbox"** names the *container tier*, not a security boundary and not a
mode the whole process is in. Isolation is process + mounted-FS only, and on
the `local` tier there is none at all: file writes are fenced to the project
directory by the single-root wall, `shell_run` is not fenced by anything.

**"Artifact"** is overloaded across layers on purpose and must not be merged:
the library's Artifact is a ContentRef-addressed blob a tool produced; the
product's Artifact is a path in the project directory the panel can open.

**"Workflow"** is not an engine primitive and is not a product feature either —
the workflow surface was deleted with the multi-user platform. Never introduce
`WorkflowSpec` / `WorkflowRunner` / `WorkflowPolicy` into library code, and do
not re-derive a workflow feature from the `?task_id=` filter, which exists for
branches.
