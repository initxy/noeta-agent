# noeta-agent documentation

A single-user, local-first agent workbench: one process, your own directories,
no accounts. Start at the [README](../README.md) for what it is; this page maps
the rest.

| Layer | Document | For |
| --- | --- | --- |
| Tutorial | [Quickstart](tutorials/quickstart.md) | Boot it, create a project, watch a turn replay. |
| How-to | [Use the workbench](how-to/use-the-workbench.md) | Projects, sessions, turn control, the side panel. |
| How-to | [Connect a gateway](how-to/configure-provider.md) | Point it at a real model. |
| Reference | [Product reference](reference/noeta-agent.md) | Boot modes, architecture, the sandbox tier. |
| Reference | [HTTP API](reference/http-api.md) | Every route, the SSE stream, the error codes. |
| Reference | [Configuration](reference/configuration.md) | Every `.env` key and default. |
| Reference | [The wire contract](reference/wire-contract.md) | **Normative.** The frozen UI-event vocabulary, SSE contract, REST surface and status machine. |
| Reference | [Behavior ledger](reference/behavior-ledger.md) | Invariants the code must honour, most pinned by tests — the sandbox lifecycle, the preview gateway, the regression rows and the traps. |
| Operations | [Limitations](operations/limitations.md) | Boundaries that are not bugs. |
| Operations | [Troubleshooting](operations/troubleshooting.md) | Symptom → cause → resolution. |
| Decisions | [ADR index](adr/index.md) | Why the product is shaped this way. |
| Release | [Releasing](releasing.md) | The tag-and-publish path. |

Two documents live outside `docs/` and outrank anything here on their own
subject:

- [`CONTEXT.md`](../CONTEXT.md) — the **vocabulary**: what Project, Session,
  task stream, branch, turn, UI event, execution tier, MCP connector,
  agent-config, artifact and SandboxProvider mean in this repository, and what
  each one is *not*.
- [`AGENTS.md`](../AGENTS.md) — the working agreement: the standard verbs
  (`make dev` / `uv run pytest` / `make check`), the gates, and how a change is
  shaped and accepted.

The [behavior ledger](reference/behavior-ledger.md) collects the invariants the
code must honour — the sandbox container lifecycle, the preview gateway, the
numbered regression rows that tests cite, and the traps the code is shaped
around. Read it before you change the translator, the SSE path, the sandbox seam
or the provider wiring.

中文文档：[`zh/`](zh/)。
