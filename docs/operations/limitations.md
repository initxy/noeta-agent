# Known limitations

Deliberate boundaries of the product, not bugs. Each entry says what it means,
when you hit it, and the workaround if there is one. Symptom-shaped problems
live in [Troubleshooting](troubleshooting.md).

## The `local` tier has no isolation and no approval gate

**What it means:** A project on the `local` tier runs the agent's file and shell
tools **on your machine, as you**. There is no container, and there is no
per-call approval prompt anywhere in this product — permissions are bypassed by
design, because there is no UI to answer them and a turn parked on an
unanswerable approval is a hung conversation.

- **File writes are fenced to the project directory.** An out-of-workspace
  `write` / `edit` / `apply_patch` simply fails; there is no approval flow to
  grant an exception, so the wall is absolute.
- **`shell_run` is not fenced.** A shell command can read, write or delete
  anything your user can.

**When you hit it:** any `local` project. Which is the default and the common
case.

**Workaround:** choose the `sandbox` tier for work you do not want touching the
rest of the machine, and keep the server bound to `127.0.0.1` (the default) —
an exposed workbench is an unauthenticated remote shell.

**Why it is this way:** [execution-tier-per-project](../adr/execution-tier-per-project.md).

## A session's execution tier cannot be changed

**What it means:** The tier is resolved once, when a session's first message
seeds its task, and welded into that task. Every later turn resolves it from
there.

**When you hit it:** you switch a project from `local` to `sandbox` and an
existing session keeps running locally.

**Workaround:** start a new session. The UI says so at the control.

**Why it is this way:** the runtime requires the policy to be deterministic for
a given session, and a task that changed environment mid-conversation would have
written half its files in two different worlds.

## Sessions of one project share one directory, with no locking

**What it means:** All sessions of a project use the project directory as their
workspace root. Two live sessions — or one session and your own editor — can
write the same file at the same time. Nothing arbitrates.

**When you hit it:** running two turns in parallel over the same files.

**Workaround:** none automatic, and two consequences are designed around it: an
artifact save is optimistically locked (a conflicting save is a **409** you
answer, not a silent overwrite), and **`rewind` ("undo last turn") restores
files with an explicit warning** — because restoring one session's files can
revert another's work, undo is offered on a root session's latest turn only and
states the risk before the click.

**Why it is this way:** [project-model](../adr/project-model.md).

## Single user, single process, no auth

**What it means:** There is no login, no user model, no sharing, and no
authorization anywhere in the API. App state is a local SQLite file. The product
is meant to run on your own machine.

**When you hit it:** any thought of putting it on a network.

**Workaround:** none — this is the product. If you need multi-user, that is a
different product (the one this rewrite deliberately deleted).

## Some capability toggles have no readers

**What it means:** `MEMORY_TOOLS_ENABLED`, `SUBAGENT_ENABLED`,
`MEMORY_CONSOLIDATION`, `MEMORY_CONSOLIDATION_DEBOUNCE_HOURS` and the
per-project **memory toggle in Settings → Memory** are stored but not read.
Memory and subagent tools are mounted unconditionally by the agent preset, and
memory consolidation is never triggered.

**When you hit it:** you turn memory off for a project and the agent still
recalls.

**Workaround:** none today. Switching them per project needs a second compiled
agent recipe selected at seed time; consolidation needs the host to call the
SDK's pass.

## MCP connectors are configured but their handshake is unpinned

**What it means:** Connector records, scoping, credential scrubbing and the
specs handed to the engine are covered by tests. What no automated test covers
is the wire half — that an enabled connector is really handshaked at task start
with its credential on the request, and that a disabled one never touches the
network.

**When you hit it:** a connector that looks configured and never appears in the
model's tools.

**Workaround:** check the backend log at the start of a turn, and the trace page
for the tools the turn was actually given.

## Sandbox isolation is process + mounted FS

**What it means:** The container sees the directories mounted into it, not the
host root — but the project directory is a bind mount, so a write to it lands on
the host filesystem directly. It is not a full filesystem or network jail, and
`--security-opt seccomp=unconfined` is the AIO image's own requirement.

**When you hit it:** running genuinely untrusted code.

**Workaround:** run the whole workbench inside a VM.

## A sandbox `shell_run` timeout does not kill the command

**What it means:** On the host, a `shell_run` timeout kills the process. Inside
the container there is no remote hard-kill, so the timeout is enforced by the
HTTP read timeout of that one call: the model is told the command timed out, and
the command **keeps running in the container** until the container's own lease
reaps it. Its side effects may land after the tool reported a timeout.

**When you hit it:** a build or test run that exceeds its timeout.

**Workaround:** treat a timed-out sandbox `shell_run` as "may still be running"
and observe before retrying; give genuinely long commands a larger explicit
timeout. Background shell commands are refused under a container for the same
reason.

## Removing an idle container discards its write layer

**What it means:** Idle reclamation has two levels. `docker stop`
(`SANDBOX_IDLE_STOP_HOURS`) returns memory and CPU while the container, its
write layer and its port mappings survive, so a resume re-attaches in seconds.
`docker rm` (`SANDBOX_IDLE_REMOVE_HOURS`) reclaims disk by discarding the write
layer. A resume after it *rebuilds* the container from its recoverable shape
(name + the `/workspace` bind mount), so the session comes back — but only its
shape: `/workspace` files survive, while installed packages, `/tmp` and any
running processes are gone with the write layer.

**When you hit it:** returning to a session whose container was removed. The
first turn is slower (a full `docker run` rather than a `docker start`), and
anything that lived only inside the container — not under `/workspace` — has to
be re-created. A rebuild needs the project's directory to still be known to this
host; a genuinely foreign ref (another machine) or a deleted project cannot be
rebuilt and raises.

**Workaround:** keep the remove TTL much longer than the stop TTL (the defaults
do: 1 h vs 24 h), and keep work in the project directory, which is a bind mount
and survives everything.

## The container is a project resource, not a session one

**What it means:** One container serves every session of a project. The idle
criterion is therefore "no session of this project is running or waiting" — one
busy session keeps the container alive for all of them — and deleting a session
never releases it.

**When you hit it:** expecting a session to have its own container, or expecting
deletion to free resources.

**Workaround:** delete the project to release its container.

## The preview panels are token-guarded, not authenticated

**What it means:** The container's browser and terminal are republished on a
**separate origin** under an unguessable token (`secrets.token_urlsafe(16)`).
The container credential rides only the gateway-to-container leg and never
reaches the browser, but the browser-to-gateway leg has no auth beyond the
token. That origin serves nothing but `/sandbox-preview/<token>/*` — no API, no
SPA, no cookies of ours — which is exactly why those iframes may run with
`allow-same-origin`.

**When you hit it:** reaching the workbench through a tunnel that forwards only
the main port, or expecting network-grade access control.

**Workaround:** pin `SANDBOX_PREVIEW_PORT` and forward it too; keep the whole
thing on localhost.

## Spreadsheets are read-only

**What it means:** Binary workbooks are not parsed at all. A spreadsheet
artifact downloads instead of opening in an editor.

**Why it is this way:** the obvious model (a grid of strings, first sheet only)
destroys every other sheet, all formulas and all formatting on save. A
limitation beats data loss. See
[artifact-trust-model](../adr/artifact-trust-model.md).

## Artifact resolution is capped

**What it means:** At most 80 derived candidates are verified per round. A very
long conversation can derive more, and the surplus stays unverified — and
therefore uncollectible.

**Workaround:** none needed in practice; the panel degrades to "the first N are
verified", never to an error.

## No out-of-band notification

**What it means:** When the agent asks a question, the task waits durably — but
nothing tells you. There is no webhook, no email, no OS notification. The
in-app notification centre only reaches a browser tab that is open.

**Workaround:** keep the tab open; the sidebar marks sessions that are waiting
and ones that finished while you were elsewhere.

## Mock-mode fidelity

**What it means:** The offline mock plays one canned chain. Re-running it in a
project that already has `report.md` produces a *failed* write (the agent's
read-before-write rule) while the canned reply still claims success.

**When you hit it:** demoing twice into the same directory.

**Workaround:** use a fresh project directory, or connect a real gateway.

## See also

- [Troubleshooting](troubleshooting.md) — symptom → cause → resolution
- [Product reference](../reference/noeta-agent.md) — the architecture behind these
- [ADR index](../adr/index.md) — why each boundary is where it is
