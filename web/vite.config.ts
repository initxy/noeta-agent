import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Backend address: defaults to 127.0.0.1:8000 (`make dev` boots the backend
// there and vite here on 5273); override with VITE_API_TARGET so the proxy can
// point at a backend on a non-default port.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000'

// One alias, mirrored in tsconfig.app.json. Every cross-directory import goes
// through `@/`, which is what lets the layering gate decide an import's target
// layer from the specifier alone instead of resolving `../../..` chains.
const srcDir = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': srcDir },
  },
  test: {
    // Unit tests only — e2e/ is a separate Playwright package whose *.spec.ts
    // files must never run under vitest.
    //
    // `scripts/` is here so the layering gate's own fixtures run inside
    // `make check` alongside the gate itself. A checker nobody checks is one
    // refactor away from reporting "ok" on everything, and it would report it
    // in the same green line as a real pass.
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    // jsdom everywhere: the pure-logic tests do not need it, but component
    // tests arriving in later phases do, and a per-file environment docblock
    // is the kind of thing that gets forgotten.
    environment: 'jsdom',
  },
  server: {
    port: 5273,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
})
