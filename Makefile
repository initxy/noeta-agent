# noeta-agent developer convenience wrapper.
#
# The underlying entry point stays the single, zero-argument, env-only
# `python -m noeta.agent`. Configuration comes from ./.env and environment
# variables (see noeta/agent/config.py); this Makefile only builds the
# frontend and forwards HOST/PORT overrides.
#
# Common usage:
#   make run                # one step: build frontend + start backend (port 8000)
#   make run PORT=9000      # override the port for this run
#   make serve              # backend only (skip the build when the frontend is current)
#   make dev                # hot reload: backend(8000) + vite dev(5273 auto proxy)
#   make install            # first time: uv sync + frontend deps
#   make check              # the local CI gate

PY      ?= uv run python
WEB_DIR := web

PORT    ?=
HOST    ?=

# Only export when passed explicitly on the command line, so .env values win otherwise.
ifeq ($(origin PORT),command line)
export PORT
endif
ifeq ($(origin HOST),command line)
export HOST
endif

.DEFAULT_GOAL := help
.PHONY: help run serve web dev install check e2e-web

help:
	@echo "noeta-agent — one-step build + start (python -m noeta.agent underneath, env-only config)"
	@echo ""
	@echo "  make run        build frontend + start backend (default http://127.0.0.1:8000)"
	@echo "  make serve      backend only (do not rebuild the frontend)"
	@echo "  make web        build the frontend to web/dist only"
	@echo "  make dev        hot reload: backend(8000) + vite dev(5273 proxy)"
	@echo "  make install    first time: uv sync + npm ci in web"
	@echo "  make check      the local CI gate: pytest, web tsc+tests, import-linter"
	@echo "  make e2e-web    opt-in browser e2e: build SPA + Playwright against a throwaway backend (not in check)"
	@echo ""
	@echo "  overridable variables: PORT= HOST=  (otherwise ./.env applies)"

## one step: build frontend + start backend
run: web serve

## start the backend only (do not rebuild the frontend)
serve:
	@echo "▶ noeta.agent → http://$${HOST:-127.0.0.1}:$${PORT:-8000}  (config: ./.env)"
	$(PY) -m noeta.agent

## build the frontend to dist/ (installs deps automatically on first run)
web:
	@[ -d $(WEB_DIR)/node_modules ] || (cd $(WEB_DIR) && npm install)
	cd $(WEB_DIR) && npm run build

## hot-reload development: backend(8000) in the background + vite dev in the foreground,
## Ctrl-C stops both. The backend is forced to 8000 to match vite's default proxy target.
dev:
	@[ -d $(WEB_DIR)/node_modules ] || (cd $(WEB_DIR) && npm install)
	@echo "▶ backend :8000 + vite dev :5273 (proxy → 8000). Ctrl-C stops both."
	@PORT=8000 $(PY) -m noeta.agent & \
	  AGENT_PID=$$!; \
	  trap 'kill $$AGENT_PID 2>/dev/null' EXIT INT TERM; \
	  cd $(WEB_DIR) && npm run dev

## first-time install: dependency sync + frontend deps
install:
	uv sync
	cd $(WEB_DIR) && npm ci

## opt-in browser e2e (not part of `make check`): build the SPA, then run the
## Playwright suite in web/e2e (its own isolated npm package). The suite's
## webServer block boots `python -m noeta.agent` on port 8123 with a throwaway
## data dir (wiped per run, mock provider, sandbox off) and tears it down after.
e2e-web: web
	@[ -d $(WEB_DIR)/e2e/node_modules ] || (cd $(WEB_DIR)/e2e && npm install)
	cd $(WEB_DIR)/e2e && npx playwright test

## the local CI gate — mirrors .github/workflows/ci.yml. Every step here is
## reproducible from a clean clone (no external services required).
##
## Four gates: the Python suite; the web typecheck + unit tests; the frontend
## LAYERING gate (web/scripts/check-layering.mjs — the app/ ⇄ react-app/
## dependency rules plus a cycle check); and the import-linter contract that
## keeps the product off the runtime internals.
check:
	uv run pytest
	cd $(WEB_DIR) && npx tsc -b --noEmit && npx vitest run && npm run layering
	uv run lint-imports
