# Changelog

All notable, user-visible changes to `noeta-agent`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
policy in [`docs/releasing.md`](docs/releasing.md). `release.yml` refuses to
publish a tag whose version has no dated section here.

## [Unreleased]

### Changed — no deployment-specific model ids in the tree

- With no `models.json`, the single fallback model is now `claude-opus-4-8`
  ("Claude Opus 4.8"), a public model id, instead of a private gateway alias.
  Tests, comments and the benchmark spec no longer name private gateway models;
  the quick6 comparison scripts take the models as arguments.

### Removed — the `plan` subagent

- The preset's read-only `plan` identity is no longer spawnable, in both the
  workbench server and the headless `noeta run` CLI; the delegation roster is
  now **`explore` + `general-purpose` only**. The identity is dropped from the
  compiled `agents` map, from which `spawnable` is derived by union, so it
  disappears from the Task tool's enum and no turn can delegate to it. Streams
  that used `plan` before the change still render in the trace.

### Changed — noeta-sdk / noeta-runtime 0.6.32

- Bumped both packages in lockstep to **0.6.32**, taking in 0.6.29–0.6.32.
  One product change rides with it:
  - **The workbench keeps recording model request bodies**
    (`HostConfig(record_llm_requests=True)`). Since 0.6.32 the SDK mints
    `LLMRequestStarted.request_ref` without storing the body, and the trace
    view dereferences that ref to show each round's system prompt, tools and
    conversation. The headless `noeta run` CLI has no trace view and takes the
    new default. The stored bodies can be reclaimed with the SDK's new
    `Client.collect_garbage()`; the product does not schedule it yet.
  - **The container sandbox's shell adapter follows the SDK's per-command
    sessions.** Since 0.6.31 `run_argv` creates a shell session per command
    (so a foreground command can be interrupted and a timed-out one is killed
    in the container) and reaches `/v1/shell/sessions/create`, `/v1/shell/exec`
    and `/v1/shell/kill` directly. The product's `agent-sandbox` adapter now
    routes those three calls through the official client; without it every
    `Bash` call in a container sandbox failed. A missing exit code is now a
    failed run rather than a success.
  - Other behavior that moves with the upgrade: `Read` serves at most 100 KB
    per call; sub-agents no longer carry the `Task` tool; turns cut by
    `max_tokens` mid-tool-call no longer poison later turns; provider 4xx text
    reaches `TaskFailed.detail`; old tool outputs are cleared before the window
    fills; Anthropic requests use a fourth cache breakpoint.

### Changed — noeta-sdk / noeta-runtime 0.6.28

- Bumped both packages in lockstep to **0.6.28** (sdk was 0.6.25, runtime
  0.6.24), taking in 0.6.26–0.6.28. No product code changed — dependency floors
  and the lockfile only — and all automated gates are green, including the
  browser suite. User-visible behavior that moves with the upgrade:
  - **Prompt-injection hardening.** Tool results (files, command output, web
    pages, MCP results, sub-agent reports) are now framed to the model as data
    rather than instructions; a safety constraint found only inside a tool
    result can no longer be lifted verbatim into a permanent compaction
    constraint; forged `<system-reminder>` text in tool output is neutralised.
    The main prompt changed (the cached prefix re-primes once on first turn).
  - **WebFetch** labels every result as external content, and a fetch to a host
    outside an allowlist now suspends for approval **only under a gating
    permission mode**. This host runs `bypassPermissions`, so behaviour here is
    unchanged (no host is refused; cross-host redirects are re-evaluated).
  - **Memory recall injects less by default**: a single shared word is now a
    pointer rather than the full page body, common tokens no longer count as
    evidence, and Unicode (e.g. Chinese) memory names are indexed instead of
    skipped. New opt-in host knobs (`recall_exclude`, `memory_max_bytes`,
    `memory_index_budget_tokens`) are left at their defaults.
  - **Non-streamed calls now carry `provider_headers`** — the compaction
    summarize round and any turn without a delta sink previously dropped them.
  - **MCP**: stateful Streamable-HTTP servers are joined properly (session id
    retained), and a task resumed on another process rebuilds its MCP tools so
    a pending approval no longer fails on an unknown `mcp__…` tool. The
    product's connector resolver is a pure store read, so the new
    resolver-is-called-on-resume path needs no change.
  - **Task-lifecycle reliability**: a capped child now completes the parent
    barrier (no more waiting forever), cancel reaches a subtask claimed by
    another worker, `require_approval` at finish/spawn is answerable, a
    mid-turn injection survives a crash, and a storage failure no longer kills
    the resident worker.
  - The repository-controlled `.noeta/shell-allowlist.json` now loads only in a
    trusted workspace (irrelevant to `bypassPermissions`); the environment
    resident is version 4.
- **Test-only change**: the streamed-vs-batch parity test normalises the
  per-task `Captured at:` clock and the hashes it derives. The two sessions it
  compares are two different tasks that capture the workspace environment a
  moment apart; under the SDK's per-turn rebuild they occasionally straddled a
  wall-clock second and the recorded environment hash differed even though the
  requests sent were byte-identical. The `stable_prefix`, `dynamic_suffix`, and
  the actual exchange are still compared byte for byte.

### Changed — noeta-sdk 0.6.25 / noeta-runtime 0.6.24

- Bumped `noeta-sdk` to **0.6.25** and `noeta-runtime` to **0.6.24** (both were
  0.6.11). Fourteen upstream releases, all additive relative to the surface
  this product uses; **no product code changed** — `pyproject.toml` floors and
  the lockfile only. User-visible behavior that moves with the upgrade:
  - **WebFetch now answers a question instead of returning the raw page.** The
    tool requires URL + prompt, sends the rendered page through one auxiliary
    model call (configurable via `Options.webfetch_model`), caches a successful
    fetch for 15 minutes, upgrades plain HTTP to HTTPS, and hands cross-host
    redirects back to the model instead of following them. Container fetches
    now require curl ≥ 7.63 (the stock AIO sandbox image already ships it;
    custom `SANDBOX_IMAGE` builds must provide it).
  - **One Engine per turn.** The runtime dropped its shared 256-task Engine LRU;
    each turn builds from folded bindings and is released when the turn settles,
    with per-task state (edit read-first records, the web cache, trigger
    baselines, the skill roster) in a task-local registry — so one task's read
    can no longer authorize another task's edit.
  - **MCP connections pool per server/scope**, with idle expiry (30 min),
    `Client.shutdown()` closing the pool, and one reconnection attempt before a
    dead server is skipped for the turn.
  - **Skills installed, edited, or removed during a run appear on the next
    turn** (previously fixed at task start); the roster is fitted to a token
    budget with CJK-aware counting, shortening summaries before dropping to
    name-only entries. Usage-based ranking folds recent task streams, and is
    automatically off here because this host binds `memory_root_resolver`
    (the fold spans tenants).
  - **Memory recall** records a recalled body once per task as a resident and
    no longer re-injects a page the model already loaded with `memory_read`.
  - **Compaction** refuses a summarization reply that is prose instead of the
    required note (at least two of nine section headings), fixing the case
    where a model that ignored the summarize instruction silently replaced
    history with a "next step" narration.
  - Prompt-cache fixes: the workspace-environment resident no longer changes on
    every recapture (stable prefix across resume), and the messages-side cache
    breakpoint anchors to the last *recorded* block. Expect one cold first turn
    after the upgrade (environment resident v3, roster schema).

### Changed — Open-source release preparation

- **Licensed under Apache-2.0.** Added a `LICENSE` file and declared the license
  in `pyproject.toml`, matching the `noeta-runtime` / `noeta-sdk` libraries.
- **Dependencies now resolve from PyPI.** Removed the `[tool.uv.sources]` table
  that pinned `noeta-runtime` / `noeta-sdk` to a local checkout path, so a fresh
  `git clone && uv sync` works for everyone. Added project URLs (repository,
  issues, changelog, and the upstream Noeta project).
- **Contributor documentation.** Added `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, GitHub issue/PR templates, and a `models.json.example`.
- **UI is English throughout.** Translated the remaining Chinese strings on the
  `/trace` page (event filters, the inspector, the context/cache panel) to
  English.
- **Docs housekeeping.** Removed the one-shot `docs/specs/` working artifacts
  from the repository and added a Chinese translation of the release guide.

### Added — Undo last turn (rewind)

- A new **"Undo last turn"** affordance on the latest user message re-bases the
  session's stream to before that turn and **restores the workspace files** it
  changed — the engine's `rewind`, now exposed (reversing decision D6). Because
  every session of a project shares one directory, undo can revert files
  another session wrote after that point, so it carries an explicit
  file-rollback warning at the confirm step, is offered on **root** sessions
  only (fork children are excluded for now), and is refused while a turn is
  running. New endpoint `POST /sessions/{id}/rewind` (200; `409 session_busy` /
  `409 not_rewindable`). Distinct from `fork` ("edit & retry"), which keeps
  both branches and touches no files.

### Changed — a lifecycle verb on a stream the engine never saw is a 404

- Bumped `noeta-runtime` / `noeta-sdk` to **0.6.11** (was 0.6.10). The runtime
  now refuses `cancel` / `interrupt` / `close` / `reopen` on a `task_id` that
  names no live stream, instead of minting an unreadable one as a side effect
  of writing the marker. Reachable only when the two databases disagree —
  `app.db` still binds a stream `noeta.db` no longer holds (a restored backup,
  a half-swapped data dir) — and previously that wrote a task whose first event
  was `TaskCancelled`, which no fold can read.
- The refusal reaches the client as **`404 unknown_task`**, alongside the
  existing `404 unknown_task_stream`; without the mapping it would arrive as a
  generic 409.

### Changed — Stop lands promptly

- Bumped `noeta-runtime` / `noeta-sdk` to **0.6.3** (was 0.6.2). Pressing Stop
  now interrupts within milliseconds instead of waiting out the in-flight LLM
  round: the runtime makes the provider wait abandonable, slices the
  transient-retry backoff around the cancel check, and aborts streaming
  mid-response. Previously a long generation (or a slow gateway) left the
  conversation locked for up to the request timeout after Stop. Additive/patch
  upgrade — no product code change; the default single-gateway path picks up
  the fix through the SDK's own `OpenAIResponsesProvider`.

## [0.6.0] - 2026-08-04

Consumes `noeta-runtime` / `noeta-sdk` **0.6.1** (was 0.5.x). The 0.6.x
libraries carry two hard breaks the product had to move with — the Claude Code
tool-surface alignment (0.6.0) and the structured-HITL answer contract — so the
product minor bumps in lockstep.

### Changed — model-facing tool surface follows the SDK (BREAKING)

- The offline **mock provider** now speaks the reference tool surface —
  `AskUserQuestion` / `Bash` / `Write` / `Task` (was `ask_user_question` /
  `shell_run` / `write` / `spawn_subagent`), with the matching argument names
  (`file_path`, and `Task`'s `{description, prompt, subagent_type}` instead of
  the removed `spawns` array). Under 0.6.x the old names silently failed their
  availability guard, so offline mode dead-ended on the first delegating or
  file-writing turn.
- The web fold's tool-family table and per-call sentences key off the reference
  names (`Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob`, plus `BashOutput` /
  `KillShell` / `WebFetch` / `WebSearch` / `TodoWrite` / `AskUserQuestion` /
  `Task`); `apply_patch` was removed upstream and no longer aggregates.

### Changed — structured-HITL question/answer contract (BREAKING)

- The `question` frame and the `POST /answer` body follow the SDK's 0.6.x
  shape: a question carries `options: [{label, description}]` + `multiSelect`
  (was `choices: [{id, label, ...}]` + `allow_freeform`), and an answer is
  `{selected: [labels...], other}` keyed by the question's index (was
  `{choice_id?, text?}`). The question panel renders single-select as radios
  and multi-select as checkboxes, with the always-available free-text "Other"
  slot.

### Changed — catalog registration is fail-open

- A configured model the SDK catalog does not know is now **registered with a
  conservative default and a startup warning** rather than skipped — an
  unregistered model had compaction off *and* no output ceiling. Declare
  `context_window` / `max_output_tokens` in `models.json` for the real numbers
  (and to silence the warning); the new capability flags `supports_vision` /
  `is_reasoning` ride the registered spec.

### Fixed — sandbox text reads over the SDK client

- `SdkSandboxExecEnv` now overrides `_read_content` (the whole-file text read)
  onto the `agent-sandbox` client's native `read_file`. 0.6.1 split
  `read_text`'s utf-8 path onto the native `/v1/file/read` endpoint, which the
  product adapter has no urllib wire for; without the override every default
  text read tripped the adapter's no-wire guard.

## [0.4.0] - 2026-07-26

### Changed

- The product now lives in its own repository, consuming `noeta-runtime` /
  `noeta-sdk` as ordinary dependencies (`>=0.4.0`) instead of a monorepo
  workspace. `import noeta.sdk` is the only runtime surface the product touches,
  enforced by an import-linter contract in `pyproject.toml`.
- The web SPA moved from `apps/web` to `web/`; the wheel force-include and the
  server's frontend lookup were repointed accordingly.

[Unreleased]: https://github.com/initxy/noeta-agent/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/initxy/noeta-agent/releases/tag/v0.6.0
[0.4.0]: https://github.com/initxy/noeta-agent/releases/tag/v0.4.0
