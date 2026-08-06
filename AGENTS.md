## Communication

- Be concise and direct: lead with the conclusion and the next step.
- State assumptions and risks when uncertain; skip filler.

## Language

- Docs (`CONTEXT.md`, ADR, `docs/specs/`): English.
- Replies / conversation: Simplified Chinese.

## Context

- Read `CONTEXT.md` before touching domain concepts, system boundaries, or stable conventions.
- Read `docs/adr/` before revisiting long-term architecture calls; never rely on ADRs marked `superseded`.
- Code is the single source of truth for "what is." When docs and code disagree, trust the code and fix the docs.
- Code comments reference `CONTEXT.md` and ADRs only — never `docs/specs/` (one-shot artifacts; the reference breaks once archived).

## Task flow

- Vague request → shape a spec first; a small, well-defined change can start directly.
- Implement against the spec: flip status to `active` on start (and set `owner` in the frontmatter when others may be working in parallel); tick Plan tasks as they complete; log progress, decision changes, and friction (retries / confusion / slow tests) in the spec's Progress log as you go.
- done = every acceptance criterion met + all automated gates green. Both required, no exceptions. Pass review before merge.
- Resume across sessions from the spec alone; write no separate handoff doc.

## Verbs

The toolchain is `uv` (Python) + `npm`/Vite (web), wrapped behind a root
`Makefile` so these verbs stay stable regardless of the tool underneath. Run
them from the repo root.

- dev: `make dev` — hot reload: backend on :8000 + vite dev on :5273 (proxy).
- test: `uv run pytest` — the Python suite (`tests/`).
- lint: `uv run lint-imports` — the import-linter contract (product reaches the
  runtime only through `noeta.sdk` / `noeta.presets`).
- build: `make web` — build the SPA to `web/dist` (bundled into the wheel).
- e2e: `make e2e-web` — opt-in Playwright browser suite against a throwaway
  mock-mode backend (not part of `check`).
- check: `make check` — one command that runs every automated gate.
- release: `git tag vX.Y.Z && git push origin vX.Y.Z` — approval gate, see
  Release below.

## Gates

- Automated gates (required for done): run `make check`. It runs the Python
  suite (`uv run pytest`), the web typecheck + unit tests
  (`tsc -b --noEmit` + `vitest run`), and the import-linter contract
  (`lint-imports`). It exits non-zero on any failure.
- CI-only steps: `.github/workflows/ci.yml` runs `make check` (so local green
  means CI green) **plus** a separate `e2e-web` job — the Playwright browser
  suite (`make e2e-web`), which `check` deliberately does not include because it
  needs a built SPA, a booted backend, and Chromium. Run `make e2e-web` locally
  when a change touches the SPA↔backend wire.
- Approval gates (a human must sign off before running): release, data
  migration, data deletion, external publishing.

## Autonomy scope

`make check` runs a real regression suite — the Python `tests/` suite, the web
unit tests, and the import-boundary contract — so an agent can verify most of
its own work.

- Safe to do autonomously (verify with `make check`): backend and library-facing
  behavior covered by `tests/`, web logic covered by `vitest`, and the
  product↔SDK import boundary. Also always safe: docs, specs, and ADRs.
- Run `make e2e-web` before calling done any change to the SPA↔backend wire (the
  UI-event translator, session lifecycle, streaming) — the browser suite is the
  only gate that exercises it end-to-end, and it is outside `check`.
- Still wants human review: schema/data migrations and the release path (see
  Release), which no gate can undo.

## Release

- Follow `docs/releasing.md`. Human sign-off = pushing the release tag.

## Engineering constraints

- Feature work changes behavior; maintenance work changes structure. Never mix them in one diff.
- Prefer existing patterns; keep changes focused; no unrelated refactors.
- Prefer deep modules: a small interface hiding enough implementation.
- The interface is the test surface; don't introduce a seam without a real need to swap implementations.
- Run verification matched to the change's risk; if you can't verify, say why.

## Maintenance

- After a large feature merges, run a scoped gc over the changed area.
- Periodically (weekly is a good default) run a global gc: doc reconciliation, friction scan, architecture proposals.
