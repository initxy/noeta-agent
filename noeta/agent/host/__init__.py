"""The engine-facing half of the product: everything that talks to the SDK.

Nothing here is assembled here. Every module is a piece with injected seams,
and the one place that knows they fit together is `api/runtime.py` — the
composition root, which is also the only module allowed to be a wiring
diagram. Reading order, roughly outside-in:

- **`client.py`** — the single `Client` per process (`build_client`) and the
  small turn-driving surface over it (`AgentHost`: send a goal, answer,
  interrupt, cancel, fork). Startup and shutdown order are both load-bearing:
  an interactive session never reaches a root terminal state, so a skipped
  shutdown leaks a container per live session.
- **`translator.py`** — a pure, stateless function from `EventEnvelope` to the
  flat UI-event vocabulary, shared by live streaming and replay so the wire
  cannot drift from the log. It imports no engine type; structural tags are
  read off the value, never `isinstance`-checked.
- **`hub.py` + `status.py`** — the fan-out from one engine subscription to N
  SSE subscribers, the task↔session routing map, and the per-task status
  machine whose predicates come from the translator rather than being
  re-derived.
- **`provider.py` / `catalog.py` / `mock_llm.py` / `title.py`** — `models.json`
  to a provider, gateway routing, catalog registration (an unregistered model
  silently disables compaction), the mock provider that makes a
  credential-free boot a usable product, and sidebar-title generation.
- **`tiers.py` / `workspace.py` / `memory.py` / `files.py`** — the per-project
  half: which projects want a container, the assembled `AGENT.md`, the
  per-project memory pool, and the workspace file reads.
- **The execution tier** — `sandbox_provider.py` (who runs `docker`),
  `reaper.py` (two-level idle reclamation), `sandbox.py` (their composition),
  and the two concrete AIO adapters (`sdk_sandbox_exec_env` /
  `sdk_browser_backend`), which are the only two modules exempted from the
  import boundary. Each declares its exemption in the import-linter contract
  in `pyproject.toml` in the commit that adds it — the contract rejects an
  exemption for a module that is not there yet, and the list may only shrink.
"""
