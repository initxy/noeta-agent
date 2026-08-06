#!/usr/bin/env node
/**
 * The frontend layering gate.
 *
 * `app/` is framework-agnostic and `react-app/` is not; domains are siblings
 * that may not reach into each other; nothing anywhere may form an import
 * cycle. Those rules only survive if something runs them, so this is wired
 * into `make check` as `npm run layering` rather than written down somewhere.
 *
 * The RULES table below is the authoritative statement of the layering — the
 * gate is the spec. Widening it is a design decision, not a fix for a red
 * build.
 *
 * Usage:
 *   node scripts/check-layering.mjs [--root <dir>]   # default: ../src
 *
 * Exit 0 = clean, 1 = violations, 2 = the gate itself could not run.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Layer ids. A domain is `domain:<name>` so that "own domain only" is a plain
 * string equality rather than a special case in the rule table.
 */
const LAYER_LABELS = {
  entry: 'src root',
  app: 'app/',
  kernel: 'react-app/kernel/',
  infra: 'react-app/infra/',
  'design-system': 'react-app/design-system/',
  shell: 'react-app/shell/',
}

const labelOf = (layer) =>
  LAYER_LABELS[layer] ?? (layer.startsWith('domain:') ? `react-app/domains/${layer.slice(7)}/` : layer)

/**
 * Which layers each layer may import. `self` is the importing layer itself —
 * spelled out rather than implied, so every row reads as the whole truth.
 * `domain:*` is any domain; the `domain` row applies to every domain, where
 * `self` therefore means "this domain only".
 *
 * Third-party packages are unconstrained everywhere; the single exception is
 * the React ban inside `app/`.
 */
const RULES = {
  // The whole point of the split: `app/` is the framework-agnostic layer, so
  // it reaches nothing but itself — and no React (see isReactPackage).
  app: ['self'],
  kernel: ['self', 'app'],
  infra: ['self', 'app', 'kernel'],
  // The design system is deliberately *not* given kernel/infra: a component
  // that needs a store or a query is a domain component, not a primitive.
  'design-system': ['self', 'app'],
  // A domain gets every layer below it plus its own directory — never a
  // sibling domain. Cross-domain composition is the shell's job.
  domain: ['self', 'app', 'kernel', 'infra', 'design-system'],
  // The shell composes: it is the one layer that may see every domain.
  shell: ['self', 'app', 'kernel', 'infra', 'design-system', 'domain:*'],
  // main.tsx mounts the shell and nothing else.
  entry: ['self', 'app', 'shell'],
}

/** Bare packages `app/**` may not import, at any subpath. */
const isReactPackage = (pkg) => pkg === 'react' || pkg === 'react-dom' || pkg.startsWith('react-')

function mayImport(from, to) {
  const allowed = from.startsWith('domain:') ? RULES.domain : RULES[from]
  if (!allowed) return false
  for (const entry of allowed) {
    if (entry === 'self') {
      if (from === to) return true
    } else if (entry === 'domain:*') {
      if (to.startsWith('domain:')) return true
    } else if (entry === to) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const hasCodeExt = (p) => CODE_EXTS.some((ext) => p.endsWith(ext))

/**
 * Map a src-relative POSIX path to its layer, or null when the path sits
 * somewhere the layering has no name for (which is itself a violation — an
 * unplaceable file is how a layering quietly stops meaning anything).
 *
 * This runs over both real file paths and import targets, so it has to accept
 * a bare directory: `@/react-app/design-system` is the barrel import of a
 * layer, and it classifies exactly like a file inside it. A real file always
 * carries a code extension, which is how a stray `react-app/domains/x.ts`
 * stays unclassified while the directory `react-app/domains/x` does not.
 */
function classify(rel) {
  const parts = rel.split('/')
  if (parts[0] === 'app') return 'app'
  if (parts[0] !== 'react-app') return parts.length === 1 ? 'entry' : null // main.tsx, index.css …
  const [, second, third] = parts
  if (second === 'kernel' || second === 'infra' || second === 'design-system' || second === 'shell') {
    return second
  }
  if (second === 'domains' && third !== undefined && !hasCodeExt(third)) return `domain:${third}`
  return null
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function scriptKindOf(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/**
 * Every module specifier in a file: static `import`, `import type`,
 * `export … from`, `export * from`, `import x = require(…)` and dynamic
 * `import()`. Type-only imports count — a type dependency is a dependency.
 *
 * The TypeScript parser is used rather than a regex because it is already a
 * dependency and it is exact: specifiers inside comments and strings simply
 * are not nodes.
 */
function parseImports(absFile, text) {
  const sf = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, scriptKindOf(absFile))
  const found = []
  const push = (node) => {
    if (node && ts.isStringLiteralLike(node)) {
      found.push({
        spec: node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      })
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) push(node.moduleSpecifier)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) push(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      push(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      push(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return found
}

function walk(dir, root, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      walk(abs, root, out)
    } else if (entry.isFile() && hasCodeExt(entry.name)) {
      out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  return out
}

/**
 * Turn a specifier into a src-relative path, or say why it is not one.
 * The `@/` alias and relative paths both land in the same coordinate space,
 * which is what lets a rule check run off the specifier without a resolver.
 */
function targetOf(fromRel, spec) {
  if (spec.startsWith('@/')) return { kind: 'internal', rel: path.posix.normalize(spec.slice(2)) }
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
    if (rel === '..' || rel.startsWith('../')) return { kind: 'outside', rel }
    return { kind: 'internal', rel }
  }
  if (spec.startsWith('/') || /^[a-z]+:/i.test(spec)) return { kind: 'outside', rel: spec }
  return { kind: 'bare', pkg: packageName(spec) }
}

function packageName(spec) {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/')
    return name ? `${scope}/${name}` : scope
  }
  return spec.split('/')[0]
}

/** Resolve a src-relative target onto a real file, for the cycle graph only. */
function resolveFile(rel, fileSet) {
  if (hasCodeExt(rel) && fileSet.has(rel)) return rel
  for (const ext of CODE_EXTS) {
    if (fileSet.has(rel + ext)) return rel + ext
  }
  for (const ext of CODE_EXTS) {
    if (fileSet.has(`${rel}/index${ext}`)) return `${rel}/index${ext}`
  }
  // `allowImportingTsExtensions` lets a specifier be written './x.ts'; a
  // bundler-mode './x.js' may equally mean './x.ts'.
  const jsSuffix = rel.match(/\.(m|c)?jsx?$/)
  if (jsSuffix) {
    const base = rel.slice(0, -jsSuffix[0].length)
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      if (fileSet.has(base + ext)) return base + ext
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Analyse a `src`-shaped tree. Returns violations rather than printing them so
 * the gate's own tests can assert on them.
 */
export function analyze(root) {
  const files = walk(root, root, []).sort()
  const fileSet = new Set(files)
  const violations = []
  const graph = new Map(files.map((f) => [f, []]))
  let edgeCount = 0

  for (const rel of files) {
    const layer = classify(rel)
    if (layer === null) {
      violations.push({
        kind: 'unclassified',
        file: rel,
        line: 1,
        edge: 'unclassified',
        detail:
          'file is not in a known layer — put it under app/, ' +
          'react-app/{kernel,infra,design-system,shell}, react-app/domains/<name>/ or src root',
      })
      continue
    }

    const imports = parseImports(path.join(root, rel), fs.readFileSync(path.join(root, rel), 'utf8'))
    for (const { spec, line } of imports) {
      const target = targetOf(rel, spec)

      if (target.kind === 'bare') {
        // Third-party is unconstrained everywhere except the one rule with
        // teeth: `app/` stays framework-agnostic.
        if (layer === 'app' && isReactPackage(target.pkg)) {
          violations.push({
            kind: 'react-in-app',
            file: rel,
            line,
            edge: `${labelOf('app')} -> ${target.pkg} (third-party)`,
            detail: `imports '${spec}'`,
          })
        }
        continue
      }

      if (target.kind === 'outside') {
        violations.push({
          kind: 'escapes-src',
          file: rel,
          line,
          edge: `${labelOf(layer)} -> outside src/`,
          detail: `imports '${spec}'`,
        })
        continue
      }

      edgeCount += 1
      const targetLayer = classify(target.rel)
      if (targetLayer === null || !mayImport(layer, targetLayer)) {
        violations.push({
          kind: 'forbidden-edge',
          file: rel,
          line,
          edge: `${labelOf(layer)} -> ${targetLayer === null ? 'unclassified' : labelOf(targetLayer)}`,
          detail: `imports '${spec}'`,
        })
      }

      const resolved = resolveFile(target.rel, fileSet)
      if (resolved) graph.get(rel).push({ to: resolved, line, spec })
    }
  }

  for (const cycle of findCycles(graph)) {
    const head = cycle[0]
    const edge = graph.get(head).find((e) => e.to === cycle[1] || (cycle.length === 1 && e.to === head))
    violations.push({
      kind: 'cycle',
      file: head,
      line: edge ? edge.line : 1,
      edge: 'import cycle',
      detail: [...cycle, head].join(' -> '),
    })
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const layers = new Set(files.map(classify).filter((l) => l !== null))
  return { files, edgeCount, layers, violations }
}

/**
 * Tarjan SCCs, then one shortest cycle per component. Reporting a concrete
 * path (`a -> b -> a`) instead of a member set is the difference between a
 * cycle report you can act on and one you have to re-derive by hand.
 */
function findCycles(graph) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  let counter = 0

  for (const start of graph.keys()) {
    if (index.has(start)) continue
    // Iterative DFS: the tree is small, but a stack overflow inside a gate is
    // an unhelpful way to learn that.
    const work = [{ node: start, i: 0 }]
    index.set(start, counter)
    low.set(start, counter)
    counter += 1
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const edges = graph.get(frame.node) ?? []
      if (frame.i < edges.length) {
        const next = edges[frame.i].to
        frame.i += 1
        if (!index.has(next)) {
          index.set(next, counter)
          low.set(next, counter)
          counter += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, i: 0 })
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)))
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = []
        for (;;) {
          const node = stack.pop()
          onStack.delete(node)
          component.push(node)
          if (node === frame.node) break
        }
        components.push(component)
      }
    }
  }

  const cycles = []
  for (const component of components) {
    const members = new Set(component)
    const selfLoop = component.length === 1 && (graph.get(component[0]) ?? []).some((e) => e.to === component[0])
    if (component.length === 1 && !selfLoop) continue
    if (selfLoop) {
      cycles.push([component[0]])
      continue
    }
    cycles.push(shortestCycle(graph, [...members].sort()[0], members))
  }
  return cycles
}

function shortestCycle(graph, start, members) {
  let best = null
  for (const first of graph.get(start) ?? []) {
    if (!members.has(first.to)) continue
    if (first.to === start) return [start]
    // BFS back to start through the component.
    const prev = new Map([[first.to, null]])
    const queue = [first.to]
    let found = false
    while (queue.length > 0 && !found) {
      const node = queue.shift()
      for (const edge of graph.get(node) ?? []) {
        if (!members.has(edge.to)) continue
        if (edge.to === start) {
          const chain = [node]
          let cursor = prev.get(node)
          while (cursor !== null && cursor !== undefined) {
            chain.push(cursor)
            cursor = prev.get(cursor)
          }
          const candidate = [start, ...chain.reverse()]
          if (best === null || candidate.length < best.length) best = candidate
          found = true
          break
        }
        if (!prev.has(edge.to)) {
          prev.set(edge.to, node)
          queue.push(edge.to)
        }
      }
    }
  }
  return best ?? [start, ...[...members].filter((m) => m !== start).sort()]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatReport({ files, edgeCount, layers, violations }, prefix) {
  if (violations.length === 0) {
    return (
      `layering ok — ${files.length} files, ${edgeCount} internal imports, ` +
      `${layers.size} layers, no cycles`
    )
  }
  const lines = [`layering: ${violations.length} violation${violations.length === 1 ? '' : 's'}`, '']
  for (const v of violations) {
    lines.push(`${prefix}${v.file}:${v.line}  ${v.edge}  (${v.detail})`)
  }
  lines.push('', 'see the RULES table in web/scripts/check-layering.mjs for what each layer may import')
  return lines.join('\n')
}

function main(argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag === -1 ? path.resolve(scriptDir, '..', 'src') : path.resolve(argv[rootFlag + 1] ?? '')

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`layering: not a directory: ${root}\n`)
    return 2
  }

  const report = analyze(root)
  const prefix = rootFlag === -1 ? 'src/' : `${path.relative(process.cwd(), root)}/`
  const text = formatReport(report, prefix)
  if (report.violations.length === 0) {
    process.stdout.write(`${text}\n`)
    return 0
  }
  process.stderr.write(`${text}\n`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`layering: ${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 2
  }
}
