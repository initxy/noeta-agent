# Releasing

This repo publishes **one** distribution: the `noeta-agent` wheel. A merged
behavior change should be followed by a release — the published package must not
lag `main`.

`noeta-agent` depends on the separately published `noeta-runtime` / `noeta-sdk`
libraries (developed in the sibling `noeta` monorepo). When a release needs a
runtime/SDK behavior that just shipped, raise the `>=` floors in
`pyproject.toml` to the versions carrying it before you tag.

## What a tag publishes

One `vX.Y.Z` tag triggers `release.yml`, which builds the `noeta-agent` wheel
once and then runs one publish job. **The publish job is gated on the tag
version**: it uploads only if the build produced a wheel whose version equals
`X.Y.Z`, and otherwise skips with a notice. The gate keeps a tag from failing on
a duplicate upload if `noeta-agent`'s version was not bumped for that tag (for
example a tag cut to move only the sibling libraries).

## Version policy

- **Patch by default**: bug fixes, small additive API, packaging fixes.
- **Minor / major**: the maintainer's explicit call (feature-level or breaking
  release) — don't derive it mechanically from semver; ask.

## Procedure

1. Decide the scope: confirm `noeta-agent` source actually changed. A release
   whose source did not change stays at its current version.
2. Update `CHANGELOG.md`: rename `## [Unreleased]` to `## [X.Y.Z] - <date>`
   (keep a fresh empty `Unreleased` above it) and complete its entries from
   `git log vPREV..HEAD` — curated, user-visible changes only, not commit
   subjects. Update the compare links at the bottom. A behavior-changing PR
   *may* add its entry to `Unreleased` directly; the release PR is the backstop
   that fills whatever is missing. `release.yml` refuses to publish a tag whose
   version has no dated changelog section.
3. Bump `version` in `pyproject.toml`, and raise the `noeta-runtime>=` /
   `noeta-sdk>=` lower bounds if this release depends on a newly shipped library
   behavior.
4. Run `uv sync` to refresh `uv.lock`.
5. Merge to `main` via PR with CI green.
6. `git tag vX.Y.Z && git push origin vX.Y.Z` — `release.yml` builds the
   frontend + the wheel and publishes it via PyPI trusted publishing (no stored
   token).

## Verification

Install from PyPI into a clean venv with `uv pip install --no-cache
noeta-agent==X.Y.Z` (the JSON API and simple index lag the publish by a minute
or two behind the CDN) and import the surface the release changed. Then check
the Actions run: the publish job should show an upload, not the
`no noeta_agent-X.Y.Z wheel — not part of this release; skipping` notice. That
notice means the version bump in step 3 was missed.

## Notes

- `noeta-agent` is **wheel-only**: its wheel force-includes `web/dist`, a
  gitignored Vite artifact an sdist can't reach. So the frontend must be built
  before packaging (`release.yml` runs `make web` first), and a plain
  `uv build` without a prior web build fails on the missing forced include.
- Trusted-publisher setup on pypi.org: project `noeta-agent`, Owner `initxy`,
  Repository `noeta-agent`, Workflow `release.yml`, Environment `pypi-agent`
  (must match the `environment:` key in `release.yml`).
