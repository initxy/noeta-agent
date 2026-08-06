<!-- Feature work changes behavior; maintenance work changes structure. Keep them in separate PRs. -->

## What & why

<!-- What does this change do, and what problem does it solve? -->

## Type of change

- [ ] Feature (changes behavior)
- [ ] Maintenance (changes structure only, no behavior change)
- [ ] Docs / specs / ADR
- [ ] Packaging / CI

## Checklist

- [ ] `make check` is green (pytest + web typecheck + vitest + import-linter)
- [ ] `make e2e-web` run if this touches the SPA↔backend wire (translator, session lifecycle, streaming)
- [ ] `CHANGELOG.md` `## [Unreleased]` updated for any user-visible change
- [ ] Docs updated (and Chinese counterpart under `docs/zh/` if a user/ops doc changed)
