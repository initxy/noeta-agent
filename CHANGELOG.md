# Changelog

All notable, user-visible changes to `noeta-agent`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the
policy in [`docs/releasing.md`](docs/releasing.md). `release.yml` refuses to
publish a tag whose version has no dated section here.

## [Unreleased]

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
