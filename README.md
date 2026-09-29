# Noeta Agent — a local-first agent workbench

[![PyPI](https://img.shields.io/pypi/v/noeta-agent)](https://pypi.org/project/noeta-agent/)
[![Python versions](https://img.shields.io/pypi/pyversions/noeta-agent)](https://pypi.org/project/noeta-agent/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Built on Noeta](https://img.shields.io/badge/built%20on-Noeta-6366f1)](https://github.com/initxy/noeta)

> **An agent that works in your own directories.** One person, one machine, a
> list of projects, and a conversation surface dense enough to live in: turn
> control (stop, edit-and-retry into a branch), a side panel that opens what the
> agent wrote, an execution tier you pick per project, MCP connectors, and a raw
> event trace — all on top of a **durable, event-sourced runtime** with full
> replay. Runs fully offline with zero credentials, and speaks to any
> OpenAI-Responses-compatible gateway when you wire one in.

`noeta-agent` is the official product built on the
**[Noeta runtime + SDK](https://github.com/initxy/noeta)** (published separately
on PyPI as [`noeta-runtime`](https://pypi.org/project/noeta-runtime/) /
[`noeta-sdk`](https://pypi.org/project/noeta-sdk/)). It is a FastAPI backend
plus a React SPA shipped as **one process** you run yourself. There are no
accounts, no login screen, no sharing and no server to deploy: you create a
**project** against a real directory on your disk, hold **sessions** against it,
and the agent reads and writes that directory.

## Quickstart — zero credentials, 60 seconds

No API key, no Docker, no accounts. From a fresh checkout (Python 3.12+ with
[uv](https://docs.astral.sh/uv/), Node 20+):

```bash
git clone https://github.com/initxy/noeta-agent && cd noeta-agent
make install   # uv sync + frontend deps
make run       # build the SPA + boot the workbench on http://127.0.0.1:8000
```

Open <http://127.0.0.1:8000>, create a project against any directory, and send a
message. With no LLM configured the workbench runs the deterministic **mock
provider**: a scripted conversation that exercises the real machinery end to end
— a clarifying question, a file written into your directory, a written answer —
fully offline. Prefer explicit steps over `make`?

```bash
cd web && npm ci && npm run build && cd ..
uv sync
uv run python -m noeta.agent
```

## Connect a real model

The workbench talks to any **OpenAI-Responses-compatible gateway**. Configure it
in `./.env` (copy `.env.example`):

```dotenv
LLM_PROVIDER=auto            # auto = use the gateway when configured, else the offline mock
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-…
```

`LLM_BASE_URL` is the gateway root — the provider appends `/responses`. The
model menu lives in `./models.json` (ids, labels, reasoning-effort levels); an
optional second gateway (`SECONDARY_LLM_BASE_URL` / `SECONDARY_LLM_API_KEY`)
serves models tagged `"gateway": "secondary"` there. See the
[configuration reference](docs/reference/configuration.md) for every key.

## Execution tiers — and what `local` really means

Every project picks **where the agent's file and shell tools run**:

| Tier | Where tools run | What it needs |
| --- | --- | --- |
| `local` | **on this machine, directly** | nothing |
| `sandbox` | inside a Docker container with the project directory bind-mounted | a local Docker daemon + the stock [AIO Sandbox image](https://github.com/agent-infra/sandbox) |

> ### The `local` tier has no isolation. Read this before you use it.
>
> A `local` project runs the agent **on your machine, with no container and no
> per-call approval prompt**. There is no permission dialog anywhere in this
> product — permissions are bypassed by design, because there is no UI to answer
> them and a turn parked on an unanswerable approval is a hung conversation.
>
> - **File writes are fenced to the project directory.** `write` / `edit` /
>   `apply_patch` outside the workspace root simply fail — there is no approval
>   flow to grant an exception, so the wall is absolute.
> - **`shell_run` is not fenced.** A shell command runs with your user's
>   privileges and can touch anything you can touch, inside the project
>   directory or not.
>
> Choose `local` for your own code on your own machine. Choose `sandbox` when
> you want the agent's commands contained — the container sees only what is
> mounted into it (process + mounted-FS isolation, not a full jail).

**A project's tier is welded at session start.** The tier is resolved once, when
a session's first message seeds its task, and every later turn re-resolves it
from that durable record — which is what keeps the answer identical across a
resume. So **changing a project's tier affects only sessions created afterwards**;
existing sessions keep the tier they were born with, forever. The UI says so
rather than pretending the switch is retroactive.

With `sandbox`, one container is provisioned **per project** (not per session,
since all a project's sessions share its directory), and the side panel gains
live **Preview** (the container's browser) and **Terminal** views streamed from
it over a **separate origin** — the gateway also serves the container's
code-server path. Idle containers are reclaimed in two stages — stop, then
remove — and a resumed session re-attaches.

## What a project gives your agent

A **project** is one directory plus everything the agent brings to the sessions
held against it:

- **The directory itself.** All sessions of a project share it as their
  workspace root, which is the point: you are working on *this* project, not in
  a scratch folder. Two live sessions can therefore conflict on disk — there is
  no locking — which is why `rewind` ("undo last turn") restores files with an
  explicit warning and only on a root session, and why the artifact editor
  ships with 409-conflict handling.
- **Agent-config** — persona prompt (materialized as `AGENT.md` in the project
  directory), default model and reasoning effort, memory toggle.
- **MCP connectors** — per-project MCP servers (`http` or `stdio`) with
  per-connector tool subsets; credentials are stored server-side and scrubbed
  from every read.
- **Agent memory** — one long-term memory pool per project
  (`DATA_DIR/memories/<project_id>`), so what one session learns the next can
  recall.
- **Skills** — the SDK-level `SKILL.md` mechanism is untouched: drop a skill
  into `<project>/.noeta/skills/` and the model activates it on demand. The
  product manages no skill registry.

## The conversation surface

- **Turn control.** Stop halts the in-flight turn and leaves the conversation
  alive — the next message resumes the same stream with full context. A provider
  failure parks the turn as a retriable notice instead of sealing the ledger.
  Edit-and-retry **forks** a user message into a sibling branch inside the same
  session, with the original intact and switchable.
- **Turn-centric rendering.** Consecutive work folds into one turn block with a
  server-timestamped "Worked for 1m 35s" line; tool calls aggregate by family;
  paths render as chips and MCP calls as sentences, with raw payloads under
  "Technical details".
- **A composer that gets out of the way.** Slash commands, `@`-mentions of real
  files, paste-to-attach (images) or paste-to-collapse (long text), drafts that
  survive a reload, `↑` history recall, and a queue that drains as one message.
- **A side panel.** Files, live container panels, and **artifacts** the client
  derives from the transcript and the server verifies before anything is
  collectible. Text artifacts are editable with optimistic locking; spreadsheets
  are read-only; agent-written HTML renders on a separate origin, never
  same-origin with the app.
- **A workbench.** Retained session tabs, a split view, a command palette
  (`Mod+K`), a notification centre, and a sidebar with pin / archive / unread.

## The runtime underneath

Every turn is a durable, event-sourced engine task:

- **Crash-safe, exactly-once execution.** State is folded from an append-only
  event log, never held in memory — kill the process mid-task and a fresh one
  resumes at the exact point, exactly once.
- **Long-horizon tasks.** A task can suspend for hours waiting on a human
  answer, a timer, or a sub-task, then wake *exactly once* when the condition
  fires — waiting costs nothing while it sleeps.
- **Full audit & replay.** Every event, LLM turn, tool call, and token/cache
  stat is recorded; compaction is a reversible overlay. The `/trace/:sessionId`
  page answers *why* a step happened, not just *what*.
- **Provider-neutral.** Anthropic and OpenAI-compatible adapters sit behind one
  internal protocol — recorded history isn't bound to any vendor's shape.
- **Deterministic offline mode.** The mock provider runs the whole stack with no
  network, so install, storage, and wiring are provable on a fresh checkout (and
  in CI).

The wire between backend and frontend is deliberately **not** the raw event log:
the backend translates engine events into a flat UI-event vocabulary over one
SSE stream per session, and replays by **re-deriving** from the log (`since_seq`)
rather than storing a projection. Raw envelopes stay available on the trace
surface. The contract is normative and frozen:
[`docs/reference/wire-contract.md`](docs/reference/wire-contract.md).

## Benchmarks — how it compares

Noeta runs on the **same public harness the leaderboards use**
([harbor](https://github.com/harbor-framework/harbor)): installed into each
task's container, driven headless, scored by each task's own verifier — no
Noeta-specific scoring path. Both runs drive the `main` preset with **Claude
Opus 4.8**.

### Terminal-Bench 2.1

Official leaderboard:
**[tbench.ai/leaderboard/terminal-bench/2.1](https://www.tbench.ai/leaderboard/terminal-bench/2.1)**.
Every row below is a full-set (89 tasks) board entry with the board's own error
bar — **except Noeta's**, a 40-task stratified sample placed at its score for
context, not a ranked position.

| Agent | Model | Effort | Terminal-Bench 2.1 |
| --- | --- | --- | --- |
| Claude Code | Fable 5 | xhigh | 83.8% ± 1.2% |
| Codex | GPT-5.5 | xhigh | 83.1% ± 1.1% |
| **Noeta `main`** | **Opus 4.8** | **xhigh** | **82.5%** — 33/40 sample |
| Terminus 2 | Fable 5 | high | 80.4% ± 1.2% |
| Claude Code | Opus 4.8 | high | 78.9% ± 1.3% |
| Terminus 2 | GPT-5.5 | xhigh | 78.0% ± 1.2% |
| Claude Code | Sonnet 5 | high | 74.6% ± 1.6% |
| Claude Code | Opus 4.7 | max | 68.9% ± 1.4% |
| Gemini CLI | Gemini 3 Pro | high | 65.8% ± 1.4% |
| Claude Code | GLM-5.1 | max | 58.7% ± 1.2% |

The board has 17 entries spanning 58.7%–83.8%; abridged here to the shipping
CLIs plus the harness's reference agent. The closest same-model comparison is
Claude Code on Opus 4.8 — 78.9% at `high`, against Noeta's 82.5% at `xhigh`.
Noeta's sample resolved 4/4 easy, 20/24 medium, 9/12 hard.

### SWE-bench Verified

Official leaderboard: **[swebench.com](https://www.swebench.com/)** (full 500
instances; Noeta's row is a fixed 15-instance subset, one or two per repo across
all 12 repos).

| Run | Model | Scope | Resolved |
| --- | --- | --- | --- |
| **Noeta `main`** | **Opus 4.8** (`high`) | **15-instance subset** | **86.7%** (13/15) |
| Board top | frontier models | full 500 | ~79% |
| Board mid-pack | frontier models | full 500 | ~66–77% |

The board is indexed by harness + model rather than by product, so it carries no
directly comparable "shipping CLI" row — read those two rows as the field's
range, not as opponents.

Both Noeta rows are **samples, labelled as such** — a placement in the field's
band, not a ranked leaderboard position. Every number carries its exact command,
pinned dataset digest, and task list; full method and exclusions live in
[**docs/benchmarks.md**](docs/benchmarks.md).

## Honest limits

- **The `local` tier has no isolation** (above). This is a decision, not a gap.
- **Single user, single process, one machine.** App state is SQLite; there is no
  auth, no multi-user story, and nothing here is meant to be exposed on a
  network.
- **Sessions of one project share one directory with no locking**, so two
  concurrent turns can overwrite each other's files. `rewind` is withheld for
  the same reason.
- **A session's execution tier cannot be changed after it starts.**
- **Sandbox isolation is process + mounted FS**, not a full jail, and a sandbox
  `shell_run` timeout returns to the model without killing the command inside
  the container.

See [operations/limitations](docs/operations/limitations.md) for the full list.

## How this repo is built

`noeta-agent` consumes the runtime + SDK as ordinary dependencies
(`noeta-runtime` / `noeta-sdk`); `import noeta.sdk` is the only public surface it
touches, enforced by an import-linter contract in `pyproject.toml`. During
library development the two packages are wired in as editable path sources (see
`[tool.uv.sources]`); switching to the published wheels is deleting that table.

- `noeta/agent/` — the FastAPI backend (`api` / `host` / `store`), entered by
  `python -m noeta.agent`.
- `web/` — the React/TypeScript SPA; `web/dist` is bundled into the wheel and
  served same-origin by the backend. Its layering (`app/` is framework-agnostic;
  `react-app/` is React) is enforced by a gate, not just documented.
- `tests/` — the Python test suite; `web/e2e` — the opt-in Playwright browser
  suite (mock mode).

`make check` is the local CI gate (pytest, web typecheck + unit tests, the
frontend layering gate, import-linter); `make e2e-web` runs the opt-in browser
suite. Working conventions start at [`AGENTS.md`](AGENTS.md); vocabulary lives in
[`CONTEXT.md`](CONTEXT.md); cross-module decisions in [`docs/adr/`](docs/adr/).

## Documentation

The full docs live under [`docs/`](docs/):

| Layer | Start at |
| --- | --- |
| Tutorials | [Quickstart](docs/tutorials/quickstart.md) |
| How-to guides | [Use the workbench](docs/how-to/use-the-workbench.md) · [Configure a provider](docs/how-to/configure-provider.md) |
| Reference | [Product reference](docs/reference/noeta-agent.md) · [HTTP API](docs/reference/http-api.md) · [Configuration](docs/reference/configuration.md) · [Wire contract](docs/reference/wire-contract.md) · [Behavior ledger](docs/reference/behavior-ledger.md) |
| Operations | [Limitations](docs/operations/limitations.md) · [Troubleshooting](docs/operations/troubleshooting.md) |
| Benchmarks | [Public benchmark results](docs/benchmarks.md) — Terminal-Bench 2.1, SWE-bench Verified |
| Decisions | [ADR index](docs/adr/index.md) |

中文文档：[`docs/zh/`](docs/zh/)。

## Contributing

Issues and pull requests are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the setup, the standard verbs (`make dev` / `make check` / `make e2e-web`),
and how a change is shaped and accepted. Please read the
[Code of Conduct](CODE_OF_CONDUCT.md) first.

For **security-sensitive reports**, follow [`SECURITY.md`](SECURITY.md) rather
than opening a public issue — and read its threat model before deploying: this
is a single-user, no-auth tool whose `local` tier runs with your privileges.

## Related project

- **[Noeta](https://github.com/initxy/noeta)** — the runtime + SDK this product
  is built on: a Python engine where an agent's entire run is a replayable event
  ledger. Published on PyPI as
  [`noeta-runtime`](https://pypi.org/project/noeta-runtime/) /
  [`noeta-sdk`](https://pypi.org/project/noeta-sdk/).

## License

[Apache-2.0](LICENSE). Copyright 2026 initxy.

