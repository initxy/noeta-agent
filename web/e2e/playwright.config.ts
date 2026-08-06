import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/**
 * Browser e2e for the workbench SPA, driven through the real backend.
 *
 * Pipeline (what `make e2e-web` runs; each step is explicit — the webServer
 * block below builds nothing by itself):
 *   1. `cd web && npm run build`             → web/dist (the backend
 *      serves the built SPA; there is no vite dev server in this suite).
 *   2. `cd web/e2e && npm install`           → this package's own Playwright
 *      toolchain (kept separate from web's node_modules on purpose).
 *   3. `npx playwright test`                 → the webServer block boots
 *      `python -m noeta.agent` on a dedicated port with a throwaway data
 *      directory (wiped on every start), runs the specs, then kills it.
 *
 * The backend runs fully offline: mock LLM provider (deterministic demo chain,
 * see noeta/agent/host/mock_llm.py) and no Docker. There is no login step —
 * the product is single-user and local-first. Isolation between specs is per
 * PROJECT: a spec creates its own project and works inside it, which is also
 * what keeps them safe to run in parallel against one backend.
 */

const E2E_DIR = __dirname
const REPO_ROOT = path.resolve(E2E_DIR, '..', '..')
const WEB_DIST = path.resolve(E2E_DIR, '..', 'dist')
const DATA_DIR = path.join(E2E_DIR, '.tmp', 'data')

const PORT = 8123
const BASE_URL = `http://127.0.0.1:${PORT}`

// The backend serves the SPA from web/dist; without a build the suite
// can only fail later and less clearly, so fail fast here.
if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  throw new Error(
    `Built SPA not found at ${WEB_DIST}. ` +
      'Run `npm run build` in web first (or use `make e2e-web`, which does).',
  )
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    // `first-run` observes a backend that has never held any data, which is a
    // property of the *server* rather than of a page. Ordering it ahead of
    // everything else is the only way it is observable at all: the rest of the
    // suite creates projects in parallel, so an opportunistic assertion would
    // pass or fail on worker scheduling.
    {
      name: 'first-run',
      testMatch: /first-run\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /first-run\.spec\.ts/,
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Wipe the throwaway data dir, then boot the backend. The SPA must
    // already be built (checked above); readiness = the backend answering
    // on "/" with the served index.html.
    command: `rm -rf "${DATA_DIR}" && uv run python -m noeta.agent`,
    cwd: REPO_ROOT,
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      LLM_PROVIDER: 'mock',
      DATA_DIR,
      // Projects created by the specs land under the throwaway data dir too,
      // so `rm -rf DATA_DIR` above is a complete reset.
      PROJECTS_DIR: path.join(DATA_DIR, 'projects'),
    },
  },
})
