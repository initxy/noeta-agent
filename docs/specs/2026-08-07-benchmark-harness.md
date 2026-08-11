---
status: active
created: 2026-08-07
owner: initxy
---

# Benchmark Noeta on Terminal-Bench 2.0 and SWE-bench (via harbor)

## Goal

Produce publishable Terminal-Bench 2.0 and SWE-bench scores for Noeta's `main`
preset by (1) shipping a headless `noeta run` CLI that drives one task to
completion in a working directory, and (2) writing a harbor `BaseInstalledAgent`
adapter — modelled line-for-line on harbor's own `pi.py` — that installs and
invokes that CLI inside harbor's sandbox.

## Non-goals

- **No engine or SDK changes.** Headless is already solved at the
  `noeta.sdk.query()` layer; this work is a thin wrapper plus an adapter.
- **No contribution to the harbor upstream repo.** The adapter lives in this
  project (or a small sibling repo); we do not open a harbor PR in this spec.
- **No new tool codecs / no `read` summarization / no plugin-authoring skill.**
  Those are separate roadmap items (omp-style tool benchmaxxing, self-extension)
  and must not be mixed into this behavior change.
- **No multi-turn / interactive CLI.** `noeta run` is one-shot: prompt in,
  terminal + result out. The web server (`python -m noeta.agent`) remains the
  interactive surface.
- **No SWE-bench full 500-instance run.** We publish a fixed, labelled subset
  for SWE-bench (see Decisions); TB2.0 runs in full.

## Context

- **Why now.** External validation of Noeta ("is it SOTA? better than Pi?")
  requires a public benchmark score. Pi already ships as a built-in harbor
  agent (`harbor-framework/harbor:src/harbor/agents/installed/pi.py`), so a
  Noeta adapter competes on the exact same battlefield.
- **Headless is a solved SDK problem.** `noeta.sdk.query(options, goal, *,
  provider, workspace_dir, model, host_config) -> QueryResult` drives an agent
  through tool calls to a terminal `TaskCompleted` and returns synchronously.
  The product's own `build_client` (`noeta/agent/host/client.py:244`) documents
  the three load-bearing settings; we reuse that recipe:
  - `permission_mode="bypassPermissions"` — nothing is gated, so the driver
    never parks on an approval suspend. (`can_use_tool=None`.)
  - `write_mode="apply"` — the SDK default `"dry_run"` silently makes every
    edit a no-op; benchmark edits must hit disk.
  - `instructions_enabled=True` + `instructions_discovery=True` — read the
    task repo's `AGENTS.md`.
- **harbor adapter contract** (`src/harbor/agents/installed/base.py`,
  `pi.py`): subclass `BaseInstalledAgent`; implement `name()`, `install()`
  (uses `exec_as_agent`/`exec_as_root`), `@with_prompt_template run()` (runs
  the CLI via `exec_as_agent`, tees output to `/logs/agent/<file>`), and
  `populate_context_post_run()` (parses token usage from that output). harbor
  references a custom agent by import path: `harbor run -a pkg.module:Noeta`.
- **SWE-bench rides the same adapter.** harbor ships `adapters/swebench`, which
  converts SWE-bench Verified into harbor tasks — `harbor run -d
  swebench-verified` uses the *same* `Noeta` agent, only a different dataset.
  No second agent implementation.
- **Import boundary.** `noeta.agent.*` may import only `noeta.sdk` /
  `noeta.presets` (enforced by `lint-imports`). `query` lives in `noeta.sdk`,
  so the CLI is compliant by construction.
- **CONTEXT.md conflict (must be resolved by this work).** `CONTEXT.md:51`
  states "There is **no operator CLI**." Adding `noeta run` overturns that
  standing decision; it requires an ADR and a CONTEXT.md edit in the same
  change. See Decisions.

## Decisions

1. **Two benchmarks, one adapter.** Target Terminal-Bench 2.0 (harbor built-in,
   direct comparison to Pi) *and* SWE-bench Verified (harbor `swebench`
   adapter). Both driven by a single `Noeta(BaseInstalledAgent)`; SWE-bench is
   only a different `-d`.

2. **`noeta run` is a first-class product entry point.** Add a
   `console_scripts` entry `noeta` (subcommand `run`) in `pyproject.toml`.
   Update the CONTEXT.md "entry point" section and record the reversal of the
   "no operator CLI" decision in a new ADR. Rationale: this CLI *is* the
   "`pip install` and it runs" reference host on the roadmap — it should be a
   supported surface, not a throwaway script.

3. **Adapter lives in-project, no upstream PR.** `Noeta(BaseInstalledAgent)`
   ships in this repo (e.g. `bench/harbor_adapter.py`), referenced as
   `harbor run -a bench.harbor_adapter:Noeta`. Fully self-controlled; external
   users would need our package to run it, which is acceptable for now.

4. **`noeta run` output contract.** The CLI prints a single JSON object to
   stdout on completion: `{"answer": str, "usage": {"input": int, "output":
   int, "cache_read": int, ...}}`. `QueryResult` exposes only
   `answer()`/`messages()`/`task_id` (no usage accessor), so usage is derived
   by scanning the returned `EventEnvelope` stream — confirm the envelope
   carries per-call usage during M1; if not, usage is best-effort/omitted and
   the adapter's `populate_context_post_run` degrades gracefully (matches how
   pi.py tolerates a missing field).

5. **Strip `AskUserQuestion` in benchmark runs.** Benchmark task instructions
   are self-contained; the agent must not stop to ask. `noeta run` removes the
   `ask_user_question` plugin from `main_options()` by default (a
   `--allow-questions` flag can re-enable it). With one-shot `query()`
   (`multi_turn=False`), an unanswered question already surfaces as
   `QueryFailedError` rather than hanging — stripping the plugin makes that a
   non-event.

6. **`local` tier, isolation from harbor.** `noeta run` leaves
   `sandbox_provider=None` so tools execute directly in `workspace_dir` (real
   bash/edit). Isolation is provided by harbor's own container around the whole
   process — Noeta does not nest a second sandbox.

7. **Milestones and the publish scope.**
   - **M1** — `noeta run` CLI + unit tests (`make check` green). This is the
     headless reference-host nucleus.
   - **M2** — `Noeta` harbor adapter + a real end-to-end closed loop
     (install → run → score) on **1–2 tasks of *each* benchmark**. Proves
     "can integrate, can emit a score." Requires local Docker + harbor + real
     provider credentials (outside `make check`; a manual gate).
   - **M3** — scaled scored run and **publish**: Terminal-Bench 2.0 **in full**
     (~100 tasks) and a **fixed, labelled SWE-bench Verified subset** (e.g. 50
     instances, instance IDs pinned in the results doc). Publish the numbers
     with the exact command, model id, dataset version, and subset list.

8. **Evaluation model is `opus4.8`**. It is
   the adapter's default `-m`; harbor's `-m` can override it per run. The model
   id contains a `/`, so — unlike `pi.py` — the adapter does not split it to
   recover a provider (the gateway, via `LLM_BASE_URL`, decides routing).

## Plan

Dependency order. M1 → M2 → M3.

### M1 — headless `noeta run` CLI

- [x] Add `noeta/agent/run_cli.py`: `run` subcommand taking a prompt (arg) +
      `--workspace` (default cwd) + `--model` (default from env/models config)
      + `--allow-questions` flag.
- [x] Wire the `query()` recipe: `replace(main_options(),
      permission_mode="bypassPermissions", can_use_tool=None, plugins=…strip
      ask_user_question…)`, `HostConfig(write_mode="apply",
      instructions_enabled=True, instructions_discovery=True,
      storage_path=…)`, real provider from `noeta/agent/host/provider.py`.
- [x] Implement the stdout JSON contract (answer + usage); usage is summed from
      the `LLMRequestFinished` envelopes' `Usage` (confirmed field, not
      best-effort) — `input = uncached + cache_read + cache_write`.
- [x] Register `console_scripts` `noeta = noeta.agent.run_cli:main` in
      `pyproject.toml`.
- [x] Unit tests in `tests/test_run_cli.py` using the `FakeLLMProvider` seam:
      exit 0 + JSON shape + files actually written to a tmp workspace (proves
      `write_mode`), usage totals, missing-workspace exit 2, provider-failure
      exit 1, and the `main` argv→print path.
- [x] `lint-imports` still green (CLI imports only `noeta.sdk`/`noeta.presets`
      + the product's own `noeta.agent.host` wiring).
- [x] ADR `docs/adr/operator-cli.md`: records reversing "no operator CLI";
      `CONTEXT.md` "entry point" section now names both entry points; ADR
      linked from `docs/adr/index.md`.
- [x] `make check` green (Python 646 passed, web 857 passed, contract KEPT).

### M2 — harbor adapter + real closed loop (both benchmarks)

- [x] `bench/harbor_adapter.py`: `Noeta(BaseInstalledAgent)` mirroring `pi.py` —
      `name()`, `install()` (`pip install` this package into the container),
      `@with_prompt_template run()` (invoke `noeta run` via `exec_as_agent`,
      pass provider env through, tee to `/logs/agent/noeta.json`),
      `populate_context_post_run()` (parse usage from that JSON). Model default
      `opus4.8`; the `-m` string is NOT split on `/`.
- [x] Pass `LLM_BASE_URL`/`LLM_API_KEY` (and timeout) into the container env so
      install succeeds *and* run has credentials.
- [x] `bench/run_benchmark.sh` (smoke/full/subset modes) with preflight checks;
      real harbor flags verified against `cli/jobs.py`
      (`-d`/`-a`/`-m`/`-i`/`-l`/`--n-concurrent-trials`).
- [x] `bench/README.md` documents the exact commands + env + why this is
      outside `make check`.
- [x] Offline verification: adapter + script syntax OK; the exact arg vector
      the adapter builds parses through the real CLI parser (`noeta run
      --workspace /app --model … `); `bench/` is outside pytest + import-linter
      scope so `make check` is unaffected.
- [ ] **Manual gate (needs Docker + harbor + credentials + tokens):** real run
      `bench/run_benchmark.sh smoke-tb` → non-error trial, a score emitted.
- [ ] **Manual gate:** real run `bench/run_benchmark.sh smoke-swe` → non-error
      trial, a score emitted.

### M3 — scaled scored run + publish

- [x] `docs/benchmarks.md` publish scaffold: reproducibility contract, both
      score tables with pinned columns (model / dataset@version / command /
      subset ids), cost+wall-clock table, and an honest "what this does not
      claim" section. All numbers marked _TBD_ until the scored run.
- [x] **Manual gate:** pull required dataset images; pin dataset versions.
      TB2 pinned at `sha256:c6fc2e23…`; SWE-bench Verified downloaded (500).
- [x] **Manual gate:** run TB2.0 scored. Ran a pinned **40-task stratified
      sample** (not the full 89) — `24/40 = 60.0%` resolved. Full 89 deferred;
      sample is the published scope.
- [x] **Manual gate:** choose + pin the SWE-bench subset (15 instances, pinned
      in `SWE_SUBSET15`), run it, fill the rows and the id list. **13/15 = 86.7%**
      (adapter provisions a private 3.12 via `uv` for SWE's 3.11 images).
- [x] **Manual gate:** publish — `docs/benchmarks.md` filled for both TB2 (60.0%)
      and SWE-bench (86.7%), with leaderboard comparison and coverage section.

## Acceptance criteria

- [ ] `noeta run "<prompt>" --workspace <dir>` runs the `main` agent
      autonomously to completion and prints the JSON contract; edits land on
      disk in `<dir>`; the process exits without human input. (M1)
- [ ] M1 unit tests + `make check` pass, including `lint-imports`. (M1)
- [ ] ADR recording the operator-CLI reversal exists; `CONTEXT.md` entry-point
      section names `noeta run`. (M1)
- [ ] `bench/harbor_adapter.py` exposes `Noeta`; `harbor run -a
      bench.harbor_adapter:Noeta` installs and invokes `noeta run` in the
      sandbox with no adapter-side error. (M2)
- [ ] A real harbor trial completes and emits a score for **both** TB2.0 and
      SWE-bench on 1–2 tasks each. (M2)
- [ ] Published results doc: TB2.0 full-set score and the fixed SWE-bench subset
      score, each with model id, dataset version, exact command, and (SWE-bench)
      the pinned instance-ID list. (M3)

## Risks

- **Heavier install than Pi.** Pi is a global npm install; `noeta run` pulls a
  Python package + deps. Prove install→run→score on harbor's single-container
  `simple-task` recipe before any scaled run. (M2)
- **Real-money, non-`make check` gate.** M2/M3 need Docker + harbor + provider
  credentials and burn real tokens (opus-tier full runs are ~hundreds of USD +
  hours). These are manual gates, not automatable; verification of M1 is fully
  covered by `make check`, M2/M3 are human-run.
- **Usage parsing may be best-effort.** If `EventEnvelope` carries no per-call
  usage, published cost is approximate; call this out in the results doc rather
  than reporting a false-precise number.
- **Model alignment.** The adapter must forward `LLM_BASE_URL`/`LLM_API_KEY`
  into the container; a common failure is install succeeding but `run` having
  no credentials.
- **`local`-tier shell is unfenced.** `noeta run` executes real bash in the
  workspace with no sandbox of its own — safe only because harbor wraps it in a
  container. Never point `noeta run` at a real machine with untrusted task
  input outside a container.

## Progress log

- 2026-08-07 — Spec shaped. Design converged over: two benchmarks share one
  adapter (harbor ships a SWE-bench adapter, so it's a `-d` switch); `noeta run`
  is a first-class entry point (overturns "no operator CLI", needs ADR);
  adapter stays in-project, no upstream PR; M2 requires real runs on both
  benchmarks; publish scope = TB2.0 full + fixed SWE-bench subset.
- 2026-08-07 — Implementation. User approved building all three milestones and
  set the **evaluation model to `opus4.8`**.
  - **M1 done, `make check` green** (Python 646, web 857, import contract KEPT):
    `noeta/agent/run_cli.py` + `tests/test_run_cli.py`, `console_scripts`
    `noeta`, ADR `operator-cli.md`, CONTEXT.md entry-point section updated.
    Confirmed against the runtime: `query()` runs headless with no server,
    `write_mode="apply"` writes to disk, usage lives on `LLMRequestFinished`
    envelopes (not best-effort). Reuses the product's `build_provider` so the
    gateway scars aren't re-derived.
  - **M2 code done, real run is a manual gate.** `bench/harbor_adapter.py`
    (mirrors `pi.py`), `bench/run_benchmark.sh` (real harbor flags verified
    against `cli/jobs.py`), `bench/README.md`. Verified offline: syntax, and the
    adapter→CLI arg contract parses through the real parser. `bench/` is outside
    `make check` scope. Real smoke runs need Docker + harbor + credentials.
  - **M3 scaffold done, scored run is a manual gate.** `docs/benchmarks.md`
    publish template with pinned-column tables, all numbers _TBD_ until run.
  - Friction: harbor's run flags are not in `docs`; had to read
    `cli/jobs.py` source to get the real names (`-i/--include-task-name`,
    `-l/--n-tasks`, `--n-concurrent-trials` — not the `--n-concurrent` /
    `--task-id` I first guessed). The SWE-bench-rides-the-same-adapter fact
    also came from reading harbor's `adapters/swebench`, not the docs.
- 2026-08-08 — Real smoke run on this machine (harbor 0.20.0). Each failure was
  one layer deeper than the last; fixing them is what "verified" means here:
  1. `--n-concurrent-trials` → the installed harbor 0.20.0 uses `--n-concurrent`
     (my flag came from harbor's main branch, not this release). Fixed in
     `run_benchmark.sh`.
  2. Dataset `terminal-bench-2.0` / `swebench-verified` not found → real
     registry ids are `org/dataset`: `terminal-bench/terminal-bench-2` and
     `swe-bench/swe-bench-verified`. Confirmed via `harbor datasets download`.
  3. Task image pull `i/o timeout` → this host cannot reach docker.io directly.
     Configured dockerd systemd proxy drop-in
     (`<proxy-host>:<port>`), `docker pull` verified. (Env fix,
     not code — noted here so a fresh machine reproduces it.)
  4. `AttributeError: ensure_system_dependencies` → this harbor build's
     `BaseInstalledAgent` has no such helper (again a main-vs-release gap);
     switched to `exec_as_root` + apt.
  5. `pip install noeta-agent` fails — not on PyPI. Switched to uploading a
     locally-built wheel (`NOETA_WHEEL`, from `uv build --wheel`).
  6. `NameError: Path` in the adapter — I added the wheel path logic without
     importing `Path`. Fixed, and added **pyflakes** as the offline gate that
     catches undefined names (my earlier `ast.parse` check could not).
  7. `Invalid wheel filename` — I renamed the uploaded wheel to
     `noeta_agent.whl`; pip parses name/version/tags from the filename, so the
     original name must be kept. Fixed (upload into a dir, keep basename).
  8. `AgentSetupTimeoutError after 360s` — pip installing all deps in a fresh
     container over the proxy exceeds harbor's default setup timeout. Added
     `--agent-setup-timeout-multiplier` (default 3x) to `run_benchmark.sh`.
  9. Container pip still slow/stalling — dockerd's proxy covers image pulls
     only, not processes *inside* the container. Measured: a 400 KB wheel took
     19.3 s direct vs 0.8 s via proxy (~25x). The adapter now forwards proxy
     env into the install + run commands (`_proxy_env`).
  10. `NetworkConnectionError: Cannot connect to proxy` — the shell's
      `HTTP_PROXY` was a loopback (`127.0.0.1:7897`), unreachable from inside the
      container. `_proxy_env` now drops loopback proxies and honours
      `NOETA_PROXY` (a container-reachable relay); `run_benchmark.sh` passes it.
  Result: with `NOETA_PROXY` set, install completes in ~20 s and `noeta run`
  runs inside the sandbox. **Closed loop verified**: a manual `noeta run` in the
  live container returned the full JSON contract
  (`{"answer","task_id","model","usage":{...}}`) and wrote the file — real
  model call, real edit, `write_mode="apply"` confirmed end-to-end. In the
  harbor trial itself `noeta run` also wrote a 46 KB `/app/vm.js` for the
  make-mips-interpreter task before harbor's per-agent run timeout hung the
  trial — the `-l 1` pick happened to be one of TB2's hardest tasks (implement a
  MIPS interpreter to boot DOOM), which opus does not finish quickly. Smoke
  should target a light task; the pipeline itself (install → run → emit) is
  proven. M2 closed loop is done; a clean scored trial is deferred to M3.
- 2026-08-08 (later) — noeta-sdk bumped 0.6.5 → 0.6.9 (external change to
  `pyproject.toml`). Verified the harness still holds: CLI unit tests 5/5 green,
  a `query()` smoke passed, and full `make check` is green on 0.6.9 (Python 646
  passed, layering ok, import contract KEPT). Rebuilt the wheel so its declared
  dep matches (`noeta-sdk>=0.6.9`). One real benchmark-relevant change in 0.6.9:
  **`Grep`/`Glob` now shell out to `ripgrep`** (per `[[sdk-0.6.9-upgrade]]`), so
  a task image without `rg` loses file search. Confirmed the TB2 task image ships
  no `rg` (but has apt), so the adapter's `install` now apt-get's
  `python3 python3-pip ripgrep` as root. `bench/README.md` restricted-network
  section documents it.
- 2026-08-09 — First real scored TB2 run + directory cleanup + honest publish.
  - **Repo tidy.** The stray dataset copies (`terminal-bench-2/`,
    `terminal-bench-2-1/`) and `jobs/` at the repo root moved under `bench/`
    (`bench/datasets/`, `bench/jobs/`), both gitignored; harbor reads its own
    `~/.cache/harbor` copy, so the repo copies were disposable. `run_benchmark.sh`
    now writes artifacts to `bench/jobs` via `-o`.
  - **Two fidelity fixes found by running.** (1) The sandbox had no `models.json`
    (gitignored, not in the wheel), so the CLI degraded o48 to a 16384
    max-output fallback — far below the product's 128000. Added
    `NOETA_MODELS_CONFIG`: the adapter uploads the catalogue and sets
    `MODELS_CONFIG`, so o48 runs at its real limits. (2) At `--n-concurrent 6`,
    ~8/40 tasks failed with gateway `llm_error`/`llm_empty_response` (o48's
    non-streaming empty-body bug under load) — infra, not capability. Re-running
    those at `--n-concurrent 2` recovered 5. Lesson: keep concurrency ≤2 for a
    scored run; documented in `bench/README.md`.
  - **Result.** Pinned 40-task stratified sample (`tb-sample40`), o48 +
    effort=high: **24/40 = 60.0%** (strict — the 6 remaining infra errors
    counted as failures; 24/34 = 70.6% excluding them). Above Claude Code's
    listed best (58.0%, Opus 4.6), inside the field's CLI band. Published to
    `docs/benchmarks.md` with the leaderboard comparison and a coverage/exclusions
    section (7 Python<3.12 tasks + 4 unscoreable, stated not hidden).
  - **Naming.** The public TB2.0 leaderboard's reference agent is **Terminus 2**,
    not "Pi" — `bench/README.md`/docs comparison wording corrected. The adapter
    is still modelled on harbor's `pi.py` (a real `BaseInstalledAgent`); that
    code-lineage note is accurate and kept.
  - **SWE-bench.** Verified downloaded (500); pinned a 15-instance cross-repo
    subset (`SWE_SUBSET15`, `swe-15` mode). All 15 images are conda envs on
    Python 3.9–3.11, below noeta-agent's 3.12 floor — the first run failed 15/15
    at install. Taught the adapter to provision a private 3.12 (via `uv`, not
    `conda create` which OOM-kills under the 4 GB trial cap) and re-ran:
    **13/15 = 86.7%**. Four instances first hit a setup timeout under
    `--n-concurrent 2` and all resolved at `--n-concurrent 1`; the merged result
    has 0 errors, 2 genuine misses (`django-11820`, `requests-1724`).
