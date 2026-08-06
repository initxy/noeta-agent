/**
 * The gate's own tests: a gate that always passes is worse than no gate, so
 * every rule is pinned by a fixture tree that must be REJECTED, plus one legal
 * tree that must be accepted.
 *
 * These live under `scripts/` as `.mjs`, which vitest's `test.include`
 * (`src/**\/*.test.{ts,tsx}`) does not cover — run them with
 * `node --test scripts/`. The runner is imported conditionally so the file
 * keeps working unchanged if that include is ever widened.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyze, formatReport } from './check-layering.mjs'

const { describe, it } = process.env.VITEST ? await import('vitest') : await import('node:test')

/** Materialise `{ 'a/b.ts': 'source' }` into a throwaway src-shaped tree. */
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layering-'))
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, source)
  }
  return root
}

const check = (files) => analyze(tree(files))
const kinds = (report) => report.violations.map((v) => v.kind)

const LEGAL = {
  'main.tsx': "import '@/app/types'\nimport { Root } from '@/react-app/shell/app-root'\nexport { Root }\n",
  'app/types/index.ts': 'export type Wire = { ok: boolean }\n',
  'app/api/client.ts': "import type { Wire } from '../types'\nexport const q = (w: Wire) => w\n",
  'react-app/kernel/store.ts': "import type { Wire } from '@/app/types'\nexport type S = Wire\n",
  'react-app/infra/query.ts': "import type { S } from '@/react-app/kernel/store'\nexport type Q = S\n",
  'react-app/design-system/cn.ts': "import type { ReactNode } from 'react'\nexport type N = ReactNode\n",
  'react-app/domains/session/page.tsx': [
    "import type { N } from '@/react-app/design-system/cn'",
    "import type { Q } from '@/react-app/infra/query'",
    "import { q } from '@/app/api/client'",
    'export const P = (n: N, x: Q) => [n, x, q]',
  ].join('\n'),
  'react-app/domains/project/page.tsx': "export const P = 1\n",
  'react-app/shell/app-root.tsx': [
    "import { P } from '@/react-app/domains/session/page'",
    "import { P as Q } from '@/react-app/domains/project/page'",
    "import type { S } from '@/react-app/kernel/store'",
    'export const Root = (s: S) => [P, Q, s]',
  ].join('\n'),
}

describe('check-layering', () => {
  it('accepts a legal tree', () => {
    const report = check(LEGAL)
    assert.deepEqual(report.violations, [], formatReport(report, ''))
    assert.equal(report.files.length, 9)
    assert.ok(report.edgeCount > 0)
  })

  it('rejects an app/ file importing react', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': "import { useMemo } from 'react'\nexport const q = useMemo\n",
    })
    assert.deepEqual(kinds(report), ['react-in-app'])
    assert.match(report.violations[0].edge, /^app\/ -> react \(third-party\)$/)
  })

  it('rejects an app/ file importing a react-* package, at any subpath', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': "import { createRoot } from 'react-dom/client'\nexport const q = createRoot\n",
      'app/api/router.ts': "import { Link } from 'react-router-dom'\nexport const l = Link\n",
    })
    assert.deepEqual(kinds(report), ['react-in-app', 'react-in-app'])
  })

  it('rejects an app/ file importing react-app/', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': "import type { S } from '@/react-app/kernel/store'\nexport type Q = S\n",
    })
    assert.deepEqual(kinds(report), ['forbidden-edge'])
    assert.equal(report.violations[0].edge, 'app/ -> react-app/kernel/')
    assert.equal(report.violations[0].detail, "imports '@/react-app/kernel/store'")
  })

  it('rejects a design-system file importing a domain', () => {
    const report = check({
      ...LEGAL,
      // `domains/project` is the leaf domain — importing `domains/session`
      // here would also close a cycle back through the design system, and the
      // point of this case is the layer edge on its own.
      'react-app/design-system/cn.ts': "export { P } from '@/react-app/domains/project/page'\n",
    })
    assert.deepEqual(kinds(report), ['forbidden-edge'])
    assert.equal(report.violations[0].edge, 'react-app/design-system/ -> react-app/domains/project/')
  })

  it('rejects domain A importing domain B', () => {
    const report = check({
      ...LEGAL,
      'react-app/domains/project/page.tsx': "export { P } from '@/react-app/domains/session/page'\n",
    })
    assert.deepEqual(kinds(report), ['forbidden-edge'])
    assert.equal(report.violations[0].edge, 'react-app/domains/project/ -> react-app/domains/session/')
  })

  it('rejects a two-file cycle', () => {
    const report = check({
      ...LEGAL,
      'react-app/kernel/store.ts': "import type { A } from './alias'\nexport type S = A\n",
      'react-app/kernel/alias.ts': "import type { S } from './store'\nexport type A = S\n",
    })
    assert.deepEqual(kinds(report), ['cycle'])
    assert.equal(
      report.violations[0].detail,
      'react-app/kernel/alias.ts -> react-app/kernel/store.ts -> react-app/kernel/alias.ts',
    )
  })

  it('rejects a cycle that crosses directories', () => {
    const report = check({
      ...LEGAL,
      'react-app/shell/app-root.tsx': "export { P } from '@/react-app/domains/session/page'\n",
      'react-app/domains/session/page.tsx': "export { L } from './leaf'\n",
      'react-app/domains/session/leaf.ts': "export { Root as L } from '@/react-app/shell/app-root'\n",
    })
    // The illegal domain -> shell edge and the cycle it creates are both real.
    assert.deepEqual(kinds(report).sort(), ['cycle', 'forbidden-edge'])
    assert.equal(report.violations.find((v) => v.kind === 'cycle').detail.split(' -> ').length, 4)
  })

  it('rejects a self-import', () => {
    const report = check({ ...LEGAL, 'app/api/client.ts': "export { q } from './client'\n" })
    assert.deepEqual(kinds(report), ['cycle'])
    assert.equal(report.violations[0].detail, 'app/api/client.ts -> app/api/client.ts')
  })

  it('counts type-only imports, dynamic imports and re-exports as dependencies', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': "export const q = () => import('@/react-app/kernel/store')\n",
      'app/api/types.ts': "import type { S } from '@/react-app/kernel/store'\nexport type T = S\n",
      'app/api/re.ts': "export type { S } from '@/react-app/kernel/store'\n",
    })
    assert.deepEqual(kinds(report), ['forbidden-edge', 'forbidden-edge', 'forbidden-edge'])
  })

  it('ignores specifiers that only look like imports', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': [
        "// import { useMemo } from 'react'",
        "/* import '@/react-app/kernel/store' */",
        `export const q = "import { x } from 'react'"`,
      ].join('\n'),
    })
    assert.deepEqual(report.violations, [])
  })

  it('classifies barrel imports of a layer directory', () => {
    const ok = check({
      ...LEGAL,
      'react-app/design-system/index.ts': "export type { N } from './cn'\n",
      'react-app/domains/project/index.ts': "export { P } from './page'\n",
      'react-app/shell/app-root.tsx': [
        "import type { N } from '@/react-app/design-system'",
        "import { P } from '@/react-app/domains/project'",
        'export const Root = (n: N) => [n, P]',
      ].join('\n'),
    })
    assert.deepEqual(ok.violations, [], formatReport(ok, ''))

    const bad = check({
      ...LEGAL,
      'react-app/design-system/index.ts': "export type { N } from './cn'\n",
      'app/api/client.ts': "import type { N } from '@/react-app/design-system'\nexport type Q = N\n",
    })
    assert.deepEqual(kinds(bad), ['forbidden-edge'])
    assert.equal(bad.violations[0].edge, 'app/ -> react-app/design-system/')
  })

  it('rejects a file that belongs to no layer', () => {
    const report = check({ ...LEGAL, 'react-app/stray.ts': 'export const x = 1\n' })
    assert.deepEqual(kinds(report), ['unclassified'])
  })

  it('rejects an import that escapes src/', () => {
    const report = check({ ...LEGAL, 'app/api/client.ts': "export { name } from '../../../package.json'\n" })
    assert.deepEqual(kinds(report), ['escapes-src'])
  })

  it('leaves third-party imports alone outside app/', () => {
    const report = check({
      ...LEGAL,
      'react-app/kernel/store.ts': [
        "import { create } from 'zustand'",
        "import { useMemo } from 'react'",
        "import { NavLink } from 'react-router-dom'",
        'export const S = [create, useMemo, NavLink]',
      ].join('\n'),
    })
    assert.deepEqual(report.violations, [])
  })

  it('formats a violation as file:line, edge, specifier', () => {
    const report = check({
      ...LEGAL,
      'app/api/client.ts': "export const a = 1\n\nimport type { S } from '@/react-app/kernel/store'\n",
    })
    const text = formatReport(report, 'src/')
    assert.match(text, /^layering: 1 violation$/m)
    assert.match(
      text,
      /^src\/app\/api\/client\.ts:3 {2}app\/ -> react-app\/kernel\/ {2}\(imports '@\/react-app\/kernel\/store'\)$/m,
    )
  })

  it('summarises a clean tree in one line', () => {
    assert.match(formatReport(check(LEGAL), 'src/'), /^layering ok — 9 files, \d+ internal imports, \d+ layers, no cycles$/)
  })
})
