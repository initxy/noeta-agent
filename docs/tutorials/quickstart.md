# Quickstart: the workbench in 5 minutes

**What you'll do:** boot the workbench with zero credentials, point it at a real
directory, hold a scripted conversation, and watch it replay from the event log.
**No API key, no Docker, no accounts** — the default mock provider is a
deterministic LLM double, and there is no login screen.

## 1. Install

You need Python 3.12+ with [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
git clone https://github.com/initxy/noeta-agent && cd noeta-agent
make install        # uv sync + frontend deps
```

## 2. Boot

```bash
make run            # build the SPA + python -m noeta.agent
```

That starts the server on <http://127.0.0.1:8000> with the offline mock LLM and
SQLite storage under `./data`. The underlying entry point is always
`python -m noeta.agent` — zero arguments, env-only, no flags. Ctrl-C stops it.

## 3. Create a project

Open the URL. Make an empty directory first — the agent is about to write into
it for real:

```bash
mkdir -p ~/noeta-demo
```

In the form: a name, the **absolute path** to that directory (e.g.
`/home/you/noeta-demo`), and the tier **`local`**.

> `local` means the agent runs on your machine with no container and no approval
> prompt. Its writes are fenced to this directory; a shell command is not fenced
> at all. Use a scratch directory for this tutorial.

## 4. Talk

Start a session and send something like:

```text
Write me a short report on the state of this project.
```

The mock provider plays a scripted demo through the **real** machinery:

1. the agent asks you a clarifying question — answer it;
2. it writes `report.md` into your directory;
3. it answers.

Every one of those moments is a recorded event. Check that the file really
exists:

```bash
cat ~/noeta-demo/report.md
```

## 5. See the log underneath

Reload the page mid-conversation. The transcript rebuilds exactly, because the
UI replays by **re-deriving from the event log** (`since_seq`) rather than
trusting anything held in memory — there is no stored copy of what you see.

Then open the side panel: `report.md` is offered as an **artifact**, because the
client derived it from the transcript and the server confirmed it exists. Open
it, edit it, save it.

For the raw record, open `/trace/<session id>` — the untranslated engine
envelopes (LLM turns, tool calls, token and cache stats) for that session.

## 6. Try turn control

- Send a longer request and press **Stop** (or `Escape` twice). The turn halts;
  the conversation stays alive and your next message resumes it.
- Hover one of *your* messages and use **Edit & retry**. That forks a branch
  inside the same session — the original stays intact and you can switch back.

## Next steps

- **Connect a real model** —
  [configure a provider](../how-to/configure-provider.md): any
  OpenAI-Responses-compatible gateway, in two `.env` lines.
- **Use it for real work** — [use the workbench](../how-to/use-the-workbench.md).
- **Contain the agent** — create a project with the `sandbox` tier (needs
  Docker); the same directory is bind-mounted into a container, and the side
  panel gains the container's browser and terminal.
- **Know the boundaries** — [limitations](../operations/limitations.md).
