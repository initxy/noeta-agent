# The noeta-agent workbench (`python -m noeta.agent`)

The official Noeta product is a **single-user, local-first agent workbench**: a
FastAPI backend plus a React/TypeScript SPA, shipped as one process you run on
your own machine. You create a **project** against a real directory, hold
**sessions** against it, and the agent reads and writes that directory — inside
a container or directly, per project. There are no accounts, no login, no
sharing and nothing to deploy.

The decisions behind it live in [`docs/adr/`](../adr/index.md); the wire it
speaks is frozen in [the wire contract](wire-contract.md); the
vocabulary is [`CONTEXT.md`](../../CONTEXT.md).

## Boot

The **only** entry point is `python -m noeta.agent` — zero arguments, all
configuration through `./.env` and environment variables (see
[Configuration](configuration.md)). It serves the REST + SSE API under
`/api/v1/*` and the built SPA on one port (default 8000). From a checkout the
Makefile wraps the common flows:

```bash
make install   # first time: uv sync + frontend deps
make run       # build the SPA + python -m noeta.agent  → http://127.0.0.1:8000
make dev       # hot reload: backend on 8000 + vite dev server on 5273 (proxied)
make check     # the local CI gate
```

### Boot modes

- **Zero-credential (default).** Everything empty: the deterministic **mock
  provider** (a scripted demo — a clarifying question, a skill hook, a file
  written, an answer), SQLite storage, no Docker. Fully offline, and what the
  test suite and CI run. There is **no login screen** in any mode.
- **Real gateway.** `LLM_BASE_URL` + `LLM_API_KEY` pointing at any
  OpenAI-Responses-compatible gateway (`/responses` is appended); the model menu
  is `models.json`; an optional secondary gateway serves models tagged
  `"gateway": "secondary"`. See
  [Configure a provider](../how-to/configure-provider.md).
- **Sandbox tier.** No switch to flip: a project whose `tier` is `sandbox` gets
  a Docker container from the stock
  [AIO Sandbox image](https://github.com/agent-infra/sandbox), plus the live
  Preview and Terminal panels. `GET /health` reports whether the machine can do
  it at all.

A deep link (`/project/x/session/y`) survives a hard refresh: any non-file,
non-API path resolves to the SPA entry point, because the URL is authoritative
in this product.

## Architecture

One process, one deployable unit, seams as interfaces rather than services.

```text
web/ (React SPA)   ──  /api/v1 REST + one SSE stream per session
        │
noeta.agent.api    routers: health, meta, content, projects, sessions,
        │          events (SSE), files (+ artifacts, preview), trace
noeta.agent.host   the engine host: the single SDK Client and the turn-driving
        │          AgentHost, the envelope→UI translator, the event hub and
        │          status machine, provider assembly, the tier policy, memory
        │          roots, the Docker sandbox provider + idle reaper, the
        │          preview gateway
noeta.agent.store  application SQLite: projects, sessions, task streams,
        │          MCP connectors
     noeta.sdk     the only crossing into the engine
```

Four structural decisions carry most of the weight:

- **A session owns one or more task streams.** `fork` appends a *sibling*
  stream to the same session, so every UI frame is tagged with `_task` and the
  SSE endpoint takes a `?task_id=` filter. Collapsing a session onto one task
  id would have to be undone the moment branches shipped.
- **The wire is translated, not raw.** A deterministic, stateless pure function
  (`host/translator.py`) turns `EventEnvelope`s into a flat UI-event vocabulary;
  replay and live share it, so the stream cannot drift from the log. Replay is
  **re-derivation** through a `since_seq` cursor — there is no stored UI
  projection. Token deltas ride the stream as ephemeral frames with no SSE id,
  never persisted and never replayed. Raw envelopes appear only on the trace
  surface.
- **Execution is a per-project tier.** One `Client` serves both; the only thing
  that switches is `HostConfig.sandbox_policy`, keyed on the project directory.
  Tools are registered always, the system prompt is tier-agnostic, and the file
  surface is not gated on a tier. See
  [execution-tier-per-project](../adr/execution-tier-per-project.md).
- **There is no auth and no permission prompt.** Permissions are bypassed
  (`bypassPermissions`, and no turn-driving call ever passes a per-turn
  override, which would re-arm every gate). What bounds the agent is the tier
  the project chose plus the single-root write wall.

### Storage

Two SQLite files under `DATA_DIR`, never mixed: `app.db` (this product's
projects / sessions / task streams / connectors, migrated by an ordered list
recorded in `schema_version`) and `noeta.db` (the engine's EventLog +
ContentStore + Dispatcher, owned by the SDK's storage adapters). The EventLog
stays the single source of truth; `app.db` is an index.

### Concurrency

The engine runs `AGENT_NUM_WORKERS` resident worker threads, so different
sessions' turns progress at once while turns within one session stay serialized.
**Read paths never share the drive queue**: replay, raw events, content reads and
the file surface all run on the async thread pool, because an active turn can
hold a worker for minutes and parking reads behind it would hang every session's
SSE, including finished ones.

## Sandbox tier details

- **One container per project**, named `noeta-sbx-<project_id>` — all of a
  project's sessions share its directory, so a per-session container would bind
  the same directory into several and let them fight over it.
- **Two-stage idle reclamation.** `docker stop` returns memory and CPU while the
  container, its write layer and its port mappings survive (a resume re-attaches
  in seconds); `docker rm` reclaims disk and is **irreversible**, because a
  container's spec only exists at the `docker run` moment. The idle criterion is
  "no session of this project is running or waiting".
- **Isolation is process + mounted FS**, not a full jail: the container sees
  what is mounted in, and a write to a mounted path lands on the host
  filesystem directly.
- **Live panels on a separate origin.** The container fronts noVNC, a web
  terminal and code-server on one port; the preview gateway republishes a slice
  of it under an unguessable token on its own port, and answers discovery with a
  `panels` map the client only joins an origin to (each of those three paths
  carries a quirk — an absolute websockify path, a trailing slash that must be
  absent, one that must be present — and rebuilding them client-side is three
  chances to get one wrong). The panel dock surfaces Preview and Terminal. That
  origin is deliberately blank — no API, no SPA, nothing of ours — because those
  iframes need `allow-same-origin`. A bind failure costs the panels, never the
  conversation.
- **Shutdown is not optional.** An interactive session rests suspended forever
  and never reaches a root terminal, so containers are reaped by the ordered
  `Client.shutdown()` (workers → observers → OTLP → containers). A process that
  skips it leaks one container per live project.

## The frontend

`web/src` is layered, and the layering is a **gate**, not a comment
(`npm run layering`, part of `make check`):

```text
web/src/
├── app/          framework-agnostic: API client, SSE reader, wire types,
│                 the fold, the draft grammar, the artifact engine
└── react-app/
    ├── kernel/   providers, platform, notification store
    ├── infra/    query client, shared caches
    ├── design-system/
    ├── domains/  session/ project/ panels/ settings/ trace/
    └── shell/    routes, sidebar, workbench, command palette, notifications
```

`app/**` may not import React or anything under `react-app/`; the design system
may not import kernel, infra, domains or shell; a domain may not import a
sibling domain (the shell is the only layer allowed to compose them); no cycles.

Routes are the authority on what is on screen: `/`,
`/project/:projectId/session/:sessionId`, `/project/:projectId/settings/:tab`
(General / Agent / Connections / Memory / Advanced), and `/trace/:sessionId`.
The **only** process-global state is the workbench — retained tabs, the split,
the focused pane — because a URL cannot express it; it lives in `sessionStorage`
so it survives a reload and dies with the browser tab.

## Honest limits

- **The `local` tier has no isolation and no approval gate.** Writes are fenced
  to the project directory; `shell_run` is not.
- **A session's tier is fixed at its first turn**; changing the project's tier
  affects only new sessions.
- **Sessions of one project share one directory with no locking.** `rewind`
  ("undo last turn") therefore restores files with an explicit warning and only
  on a root session, and artifact saves are optimistically locked.
- **Single user, single process, one machine**, with no auth of any kind.
- Several capability toggles are configuration without readers — see the note in
  [Configuration](configuration.md#agent-capabilities).

The full list is in [Limitations](../operations/limitations.md).

## See also

- [HTTP API reference](http-api.md) — every route
- [The wire contract](wire-contract.md) — normative
- [Configuration](configuration.md) — every `.env` key
- [Use the workbench](../how-to/use-the-workbench.md) — the UI walkthrough
