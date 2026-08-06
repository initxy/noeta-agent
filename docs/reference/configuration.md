# Configuration

`python -m noeta.agent` is configured through **`./.env`** (the process working
directory) plus environment variables — environment variables win over the
file, the file over built-in defaults. There are no CLI flags and no arguments.
Source of truth: `noeta/agent/config.py` (pydantic-settings);
[`.env.example`](../../.env.example) is the annotated starter copy.

**Every key is optional.** With everything left empty the workbench boots fully
offline: the deterministic mock LLM, SQLite storage, no Docker, no credentials
and no login screen.

**Unknown keys are ignored**, so a stale `.env` never breaks boot. In
particular there is no global sandbox switch any more — the execution tier is a
per-project property — so a leftover `SANDBOX_ENABLED=true` does nothing.

Relative paths (`DATA_DIR`, `PROJECTS_DIR`, `MODELS_CONFIG`) resolve against the
**process working directory**, not the package location.

## Server

| Key | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind interface. The product has no auth; binding it to a reachable interface exposes an unauthenticated agent that can run shell commands. |
| `PORT` | `8000` | Listen port. |
| `LOG_LEVEL` | `INFO` | Backend log level. |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins. Empty = **no CORS middleware at all**, which is the packaged case (the SPA is served same-origin). Only a separately-served frontend needs it; `make dev`'s vite proxy does not. |

## Paths and storage

| Key | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `data` | The writable data root (below). |
| `PROJECTS_DIR` | *(empty)* | Parent directory for "create a new project directory for me". Empty = `DATA_DIR/projects`. Existing directories you point a project at are untouched by this. |

`DATA_DIR` layout (created on boot):

```text
data/
├── app.db          # this product's DB: projects, sessions, task streams,
│                   # mcp_connectors, schema_version
├── noeta.db        # engine storage: EventLog + ContentStore + Dispatcher
├── memories/       # one long-term memory pool per PROJECT
│   ├── <project_id>/
│   └── _quarantine/   # tasks whose project cannot be resolved: no recall,
│                      # never another project's recall
├── workspaces/     # fallback workspace root only — a project's sessions use
│                   # the project's own directory
└── projects/       # PROJECTS_DIR default: where "create a directory for me"
                    # puts a new one
```

Both databases are SQLite files and are never mixed. Project directories live
wherever the user says; nothing under `DATA_DIR` holds their contents.

## LLM gateway

| Key | Default | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | `auto` | `auto` \| `openai` \| `mock`. **`auto` resolves to `openai` when `LLM_BASE_URL` and `LLM_API_KEY` are both set, otherwise to the offline `mock`** (a deterministic scripted provider — the zero-credential mode). `openai` without credentials **fails at boot**: asking for the gateway by name and not supplying it is a typo, not a fallback. |
| `LLM_BASE_URL` | *(empty)* | Primary gateway root — any **OpenAI-Responses-compatible** endpoint; the provider appends `/responses`. |
| `LLM_API_KEY` | *(empty)* | Primary gateway credential, sent as `Authorization: Bearer <key>`. |
| `SECONDARY_LLM_BASE_URL` | *(empty)* | Optional second gateway (same Responses protocol). |
| `SECONDARY_LLM_API_KEY` | *(empty)* | Its credential. Both must be set to count as configured; the secondary only stacks **on top of** an active primary — it never stands alone. |
| `MODELS_CONFIG` | `models.json` | Path to the model-menu file (below). |
| `LLM_REQUEST_TIMEOUT` | `300.0` | Per-request timeout (seconds). |
| `LLM_MAX_TOKENS` | `8192` | Output-token cap. |
| `TITLE_MODEL` | *(empty)* | Model for async session-title generation. Must be a **non-reasoning** model — the title call sends reasoning effort `"none"`. Empty = the default chat model. No titles are generated under the mock provider; the first line of the message is used instead. |

### `models.json`

Defines the model menu (`GET /api/v1/models`). Per entry: `id`, `label`,
`default` (one entry), `efforts` (reasoning-effort levels), `default_effort`,
plus backend-only fields that are **not serialized to the client**: `gateway`
(`"openai"` = primary, `"secondary"` = routed to the secondary gateway),
`context_window` / `max_output_tokens`, and the capability flags
`supports_vision` / `is_reasoning`.

Give a custom model its `context_window` / `max_output_tokens`: registering a
spec is what lets context compaction engage and sets the output-token ceiling.
Omit them and the model is still registered — with a conservative default and a
startup **warning** — so compaction never silently turns off; declare the real
values to make it accurate and silence the warning. Set `"supports_vision":
true` for a model that accepts image input, or such requests to it are rejected.
A missing or unparseable file degrades to a single fallback model with a warning
— the backend never crashes over model config.

## Sandbox execution tier

These configure the container used by projects whose tier is `sandbox`. There
is **no global on/off switch**: the tier is stored per project, and a machine
with no Docker simply cannot run that tier (`GET /health` reports
`sandbox_available: false` and the UI hides the choice).

| Key | Default | Purpose |
| --- | --- | --- |
| `SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:latest` | The stock AIO Sandbox image; build your own on top for extra in-container tooling. |
| `SANDBOX_MEMORY` | `2g` | Per-container memory cap. |
| `SANDBOX_CPUS` | `2` | Per-container CPU cap. |
| `SANDBOX_API_KEY_ENV` | `SANDBOX_API_KEY` | **Name** of the env var holding the container API key — read at provisioning, injected into the container and the ExecEnv auth, never recorded. Unset var = the container runs without auth (local use only). |
| `SANDBOX_PREVIEW_PORT` | `0` | Port for the live Browser / Terminal / Code panels. Deliberately a **separate origin** from the main port (those iframes run `allow-same-origin`, so the origin serving them must hold nothing of ours). `0` = ephemeral, discovered via `GET /api/v1/sessions/{id}/preview`; pin it when a firewall or tunnel needs a fixed port. |
| `SANDBOX_IDLE_STOP_HOURS` | `1.0` | Idle level 1: `docker stop` — memory and CPU return to the host; the container, its write layer and its port mappings survive, so resuming re-attaches in seconds. |
| `SANDBOX_IDLE_REMOVE_HOURS` | `24.0` | Idle level 2: `docker rm` — reclaims disk by discarding the write layer. Resuming afterward rebuilds the container from its shape (name + `/workspace` mount): `/workspace` files survive, installed packages / `/tmp` / processes do not. Keep it much longer than stop. |
| `SANDBOX_IDLE_CHECK_INTERVAL_HOURS` | `0.1` | Reaper poll interval. `0` on both idle keys = no reaper thread at all. |

One container is provisioned **per project**, named `noeta-sbx-<project_id>`,
because all of a project's sessions share its directory. The reaper's idle
criterion is therefore "no session of this project is running or waiting".

## Agent capabilities

| Key | Default | Purpose |
| --- | --- | --- |
| `MEMORY_TOOLS_ENABLED` | `false` | Intended to gate `memory_write/read/search/archive` + auto-recall. **No reader today** — see the note below. |
| `MEMORY_CONSOLIDATION` | `true` | Intended to gate background memory curation. **No reader today.** |
| `MEMORY_CONSOLIDATION_DEBOUNCE_HOURS` | `24.0` | Minimum hours between consolidation passes. **No reader today.** |
| `SUBAGENT_ENABLED` | `false` | Intended to gate subagent delegation. **No reader today.** |
| `AGENT_NUM_WORKERS` | `4` | Resident engine worker threads: turns of *different* sessions run concurrently; turns within one session stay serialized by the engine. Set `1` to degrade to a single worker. **Live.** |

> **Known gap, stated rather than hidden.** Four keys above, plus the
> per-project `memory_enabled` toggle, have **no readers today**:
>
> - the memory and subagent tools are mounted unconditionally by the agent
>   preset's activation tuple, so switching them per project needs a second
>   compiled recipe selected at seed time — real agent-identity work that has
>   not been done;
> - memory **consolidation** is a host-callable pass (`run_consolidation` on the
>   SDK surface) and this product never calls it, so the two consolidation keys
>   configure nothing. The consolidation *agent* is registered, so wiring the
>   trigger is the only missing half.
>
> Setting these keys changes nothing. They are kept rather than deleted because
> the toggles are a real intention; whoever picks up the agent-config surface
> next should either build them or delete the keys.

## Observability

| Key | Default | Purpose |
| --- | --- | --- |
| `OTLP_ENDPOINT` | *(empty)* | OTLP trace export: the **full** OTLP/HTTP traces URL (e.g. `http://localhost:4318/v1/traces`). Empty = off. Export is **opt-in through this key only** — the ambient OTel-standard `OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately **not** honored as an enable switch, so a shell or operator injecting it for other apps cannot silently start this process exporting. |
| `OTLP_HEADERS` | *(empty)* | Extra headers on every export request, OTel form `k=v,k2=v2` with percent-encoded values (`authorization=Bearer%20token`). Falls back to the ambient `OTEL_EXPORTER_OTLP_HEADERS` when unset — headers never enable anything by themselves, and apply only when `OTLP_ENDPOINT` is set. Malformed pairs are dropped. |

## See also

- [Product reference](noeta-agent.md) — architecture and boot modes
- [HTTP API reference](http-api.md) — every route
- [Configure a provider](../how-to/configure-provider.md) — the gateway walkthrough
