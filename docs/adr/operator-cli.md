# There is one operator CLI: `noeta run`, the headless twin of the web server

## Context

The product shipped with a single entry point — `python -m noeta.agent` —
which boots the FastAPI + uvicorn server and serves the SPA. `CONTEXT.md`
stated the rule as an absolute: "There is **no operator CLI**." That rule was
right for the product as a *workbench you open in a browser*: a second CLI
surface would have been a second way to do the same thing, with its own
argument grammar to maintain and its own drift from the wire contract.

Two forces changed the calculus:

- **A benchmark harness needs a non-interactive driver.** Integrating Noeta
  into Terminal-Bench 2.0 / SWE-bench (via harbor) requires a program that
  takes a task prompt and a working directory, runs the agent autonomously to
  completion, and exits with a machine-readable result — no browser, no SSE, no
  human at an approval prompt. harbor's own agents (e.g. `pi`) are exactly this:
  a CLI the sandbox invokes.
- **The "first five minutes" gap.** The engine is a library with no runnable
  host of its own; the only way to *see Noeta work* was to boot the web server.
  A `pip install` → one-command run is the missing on-ramp, and it is the same
  shape the benchmark needs.

Both wants are the same artifact: a thin, headless, one-shot runner over
`noeta.sdk.query()`.

## Decision

There is **one** operator CLI, `noeta run <prompt>`, registered as the
`noeta` console script. It is the **headless twin** of `python -m noeta.agent`,
not a second product surface:

- **One-shot, not interactive.** It drives a single task to a terminal
  `TaskCompleted` and prints one JSON object (`answer`, `task_id`, `model`,
  `usage`) to stdout, then exits. Multi-turn conversation, forking, rewind, and
  every other stateful verb stay behind the server and the SDK `Client`. A run
  that does not reach a terminal exits non-zero with a structured failure.
- **It reuses the product's own wiring, not a parallel copy.** The provider
  comes from `build_provider(settings)` — the same gateway construction the
  server uses, scars included (base_url `/v1` trimming, Bearer mirroring,
  prompt-cache session affinity). The run recipe is the three load-bearing
  settings `build_client` documents: `permission_mode="bypassPermissions"`,
  `write_mode="apply"`, and instructions enabled + discovered.
- **Two departures from the server, each required for an unattended run:**
  `ask_user_question` is stripped from the plugin set by default (a headless run
  must not park waiting for an answer; `--allow-questions` restores it), and
  storage is in-memory by default (`--storage-path` opts into a durable record).
- **It stays on the public boundary.** The CLI lives under `noeta.agent.*` and
  imports only `noeta.sdk` / `noeta.presets` plus the product's own
  `noeta.agent.host` wiring, so the import-linter contract is unchanged.

`CONTEXT.md`'s "no operator CLI" statement is replaced by "the interactive
server and the headless `noeta run` are the two entry points."

## Rationale

- **Same behavior, two shells — not two behaviors.** The risk the old rule
  guarded against was two divergent ways to run a turn. `noeta run` avoids that
  by delegating to the same `query()` / provider / recipe the server drives;
  the difference is the shell (argv + stdout JSON vs REST + SSE), not the agent.
  If they ever drift, the provider and the recipe are the single source both
  read from.
- **The headless path already existed; only the entry point was missing.**
  `noeta.sdk.query()` drives an autonomous run to a terminal today. Not exposing
  it as a command meant every external driver had to re-derive the recipe — and
  the recipe has two settings (`write_mode`, `permission_mode`) that fail
  *silently* when wrong. Shipping the correct recipe once, as a command, is
  safer than documenting it for others to copy.
- **The benchmark and the reference host are the same deliverable.** Making the
  benchmark work forces the reference host into existence; there is no separate
  cost.

## Alternatives considered

1. **A throwaway script under `scripts/` or `bench/`, not a product entry
   point.** Rejected: it would still have to encode the silent-failure recipe,
   but off the supported surface, where it rots. The benchmark's driver *is*
   the reference host; treating it as disposable throws away the on-ramp.
2. **Extend `python -m noeta.agent` with subcommands** (a `run` mode on the
   existing module). Rejected: the server entry point is deliberately
   zero-argument and env-only; adding argparse to it couples the server's boot
   path to a CLI grammar and muddies the one-process story.
3. **Let harbor drive the server over HTTP.** Rejected: it forces a port, SSE
   parsing, and session lifecycle into every benchmark trial for no gain — a
   one-shot task wants a one-shot process, which is what harbor's installed-agent
   model expects anyway.

## Consequences

- `pyproject.toml` gains a `[project.scripts]` entry `noeta =
  noeta.agent.run_cli:main`. `CONTEXT.md`'s entry-point section is updated to
  name both entry points.
- The CLI is the foundation the harbor adapter (a separate milestone) installs
  and invokes; the adapter parses the stdout JSON for the answer and token
  usage.
- `local`-tier execution semantics apply unchanged: `noeta run` executes real
  shell and file tools in the workspace with no sandbox of its own. It is safe
  only inside a container the caller controls (harbor provides one). Pointing it
  at a real machine with untrusted task input is out of scope, exactly as it is
  for the `local` tier in the server.
- Token usage in the JSON is summed from the `LLMRequestFinished` envelopes'
  `Usage`; a model the SDK catalog does not price still reports token counts,
  and cost accounting is left to the caller.
