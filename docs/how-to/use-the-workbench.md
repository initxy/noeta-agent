# Use the workbench

**Goal:** drive noeta-agent for real work — create a project, hold a session,
control a turn, and use the side panel.

**Before you start:** the workbench is running (`make run`, or
`python -m noeta.agent`; see the [quickstart](../tutorials/quickstart.md)).
Everything below works in offline mock mode; for real answers
[connect a gateway](configure-provider.md) first.

## 1. Create a project

Open the server URL (default <http://127.0.0.1:8000>). There is no login.

A **project** is one directory on your machine. Give it a name, an **absolute
path** to a directory that already exists (or tick "create it for me"), and an
**execution tier**:

| Tier | What it means |
| --- | --- |
| `local` | The agent's file and shell tools run **on this machine**, with no container and no approval prompt. Writes are fenced to the project directory; **`shell_run` is not fenced** — a command can touch anything you can. |
| `sandbox` | Tools run inside a Docker container with the project directory bind-mounted. Needs a local Docker daemon; the tier is hidden when the machine has none. |

Two things the form tells you, because both surprise people later:

- **Every session of this project shares this directory.** Two live sessions can
  write the same file. Nothing locks.
- **The tier is welded when a session starts.** Changing it later affects only
  sessions you create afterwards.

## 2. Configure the agent (optional)

Project → **Settings**:

- **General** — name and the execution tier (here because it is the one setting
  with a safety consequence, and because it is not retroactive).
- **Agent** — the persona prompt (materialized into the project directory as
  `AGENT.md`, and left alone if you already have a file by that name), the
  default model and reasoning effort.
- **Connections** — MCP servers, per project: an alias plus `http` (URL +
  headers) or `stdio` (command + args + env), optionally restricted to a tool
  subset. Enabled connectors are resolved into the agent **every turn**; their
  tools appear to the model as `mcp__<alias>__<tool>`. Credentials are stored
  server-side and never come back on a read.
- **Memory** — one recall toggle. Memory is scoped to the project: a session
  writes notes the project's later sessions recall, and no other project can
  read them. **Known gap:** the toggle is stored but has no reader today, so the
  memory tools are mounted either way — see
  [Limitations](../operations/limitations.md).
- **Advanced** — the project's identity, and deleting it. Deleting a project
  removes it and its sessions from the workbench and **leaves the directory on
  disk exactly as it is**.

**Skills** need no management surface: drop a `SKILL.md` pack into
`<project>/.noeta/skills/` and the model activates it on demand. A skill added
to a project this process has already used needs a restart — the skill registry
is resolved when the workspace's engine is first compiled and cached for the
process.

## 3. Hold a session

**New session**, then type. During a turn you see streamed assistant text and
reasoning, tool calls with their results, todo updates, skill activations and
subagent cards — all replayable: reload the page mid-turn and the transcript
re-derives from the event log.

- **Questions.** The agent can park on a structured question (choices plus
  freeform); the session sits in `waiting` until you answer. You can still queue
  a message while it waits.
- **Send / steer / queue.** Idle shows one Run pill. While a turn runs, Send
  *steers* (it is literally the idle send path — the words join the running
  turn), and the chevron beside it queues instead; a queue drains as **one**
  message.
- **Stop** halts the running turn and **leaves the conversation alive** — the
  next message resumes the same stream with full context. `Escape` twice does
  the same thing from the keyboard. Stop clears the queue before it aborts.
- **A failed turn is retriable in place.** A provider fault renders as an
  in-conversation notice with the composer still enabled; an ordinary message
  resumes the same task.
- **Edit & retry** on one of your own messages **forks**: a sibling branch
  inside the same session, with the original intact. The branch switcher shows
  the lineage, and both branches share the project directory — a fork does not
  restore files.
- **Attachments.** Paste or pick PNG / JPEG / GIF / WebP images (≤ 5 MB each,
  compressed client-side when that helps). Pasting long text collapses into a
  chip instead of flooding the box; pasting a link inserts a link.
- **`/` commands and `@` mentions.** `@` searches real files in the project;
  `/` pins a skill for the message. `↑` on an empty composer recalls what you
  sent before. Drafts survive a reload.

## 4. The side panel

Toggle it from the pane header.

- **Files** — the project directory, read host-side, so it works on both tiers
  and while a container is stopped.
- **Artifacts** — files the transcript pointed at, **verified by the server**
  before any of them earns a tab. Markdown, images, PDFs, HTML and documents
  open; text files are editable with a save that is optimistically locked. If
  something else rewrote the file first you get a conflict with two choices,
  **Reload theirs** or **Overwrite with mine** — no silent overwrite and no
  merge. Spreadsheets are read-only.
- **Preview / Terminal** (sandbox projects only) — the container's own browser
  and terminal, served from a separate origin. They disappear when there is no
  running container, which is normal for a `local` project or a reclaimed one.

## 5. Shell, tabs and shortcuts

- Sessions are listed in the sidebar under **Pinned / Sessions / Archived**, with
  a dot for a session that finished while you were elsewhere and a working
  indicator for one that is running. Delete is a two-click affordance on the
  row.
- Opened sessions are retained as **tabs**; a session can be **split** into a
  second pane. That layout lives in the browser tab and dies with it — the URL
  is what identifies the conversation you are reading.
- `Mod+K` opens the **command palette** (Escape goes back one view before it
  closes); `Mod+/` lists every shortcut.

## 6. When something looks wrong

`/trace/<session id>` is the raw event trace: untranslated engine envelopes for
the session's streams and their subtasks, in time order. It answers *why* a step
happened, not just *what*. See [Troubleshooting](../operations/troubleshooting.md).

## See also

- [Product reference](../reference/noeta-agent.md) — architecture and boot modes
- [HTTP API reference](../reference/http-api.md) — the routes behind the UI
- [Connect an OpenAI-compatible gateway](configure-provider.md)
- [Limitations](../operations/limitations.md) — what this product will not do
