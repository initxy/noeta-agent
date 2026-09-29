/**
 * Turning a string into an artifact candidate: normalisation, classification,
 * and the two constructors everything else in the engine calls.
 *
 * Path normalisation stays on the client even though the server re-checks
 * containment. They answer different questions. The server's `resolve_within`
 * decides whether a path is *allowed*; `normalizePath` decides whether a path
 * the agent printed can be *matched to the workspace at all* — tool output
 * routinely carries an absolute host path or a `workspace/<id>/` prefix, and
 * neither resolves against a workspace-relative API without being rewritten
 * first. Dropping this pass would not make the surface safer, it would make it
 * empty.
 */

import type { ArtifactCandidate, ArtifactPreview } from '../types/artifacts'

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** `workspaces/<anything>/` — a container-side prefix tools print verbatim. */
const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i
/** `workspace/<ws_x | digits | hex-ish>/` — the same idea, one segment up. */
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i

/**
 * A path in prose. Two alternatives: a multi-segment path with an optional
 * `./ ../ ~/ /` lead, or a bare `name.ext`. The boundary class is what keeps
 * it from matching inside a longer token.
 */
export const FILE_PATTERN =
  /(?:^|[\s"'`([{])((?:\.{1,2}[/\\]|~[/\\]|[/\\])?[\w.-]+(?:[/\\][\w.-]+)+\.[a-z][a-z0-9]{0,9}|[\w.-]+\.[a-z][a-z0-9]{0,9})/gi

export const URL_PATTERN = /https?:\/\/[^\s)\]}>"'`]+/gi

/**
 * `ws://` / `wss://` are kept as URL candidates rather than dropped: a dev
 * server announcing its socket endpoint is exactly the kind of "the thing you
 * just started is here" hint the panel exists to surface. The browser tab
 * rewrites the scheme to http(s) before opening one.
 */
export const SOCKET_PATTERN = /(?:ws|wss):\/\/[^\s)\]}>"'`]+/gi

export const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

/**
 * The gate that lets assistant prose be scanned for *paths*.
 *
 * Without it every `.ts` the model mentions while explaining itself becomes a
 * candidate. URLs are not gated — a URL in prose is unambiguous.
 */
export const ARTIFACT_VERB_PATTERN =
  /\b(?:artifact|created|deck|deliverable|exported|file|generated|opened|presentation|saved|slides?|updated|wrote)\b/i

/** `apply_patch` headers, which name the file more reliably than any argument. */
export const PATCH_FILE_PATTERN = /^\*\*\* (?:Add File|Update File):\s*(.+)$/gim
export const PATCH_MOVE_TO_PATTERN = /^\*\*\* Move to:\s*(.+)$/gim

/** Longer than this is not a path, it is a paragraph that happened to match. */
export const MAX_PATH_LENGTH = 500

// ---------------------------------------------------------------------------
// Preview classification
// ---------------------------------------------------------------------------

const PREVIEW_BY_EXTENSION: Record<string, ArtifactPreview> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',

  csv: 'sheet',
  tsv: 'sheet',
  xlsx: 'sheet',
  xls: 'sheet',
  ods: 'sheet',

  ppt: 'slides',
  pptx: 'slides',
  pptm: 'slides',
  pot: 'slides',
  potx: 'slides',
  odp: 'slides',
  key: 'slides',
  sxi: 'slides',

  docx: 'document',

  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',

  pdf: 'pdf',

  html: 'html',
  htm: 'html',

  txt: 'text',
  log: 'text',
  json: 'text',
  jsonc: 'text',
  yaml: 'text',
  yml: 'text',
  toml: 'text',
  xml: 'text',
  ts: 'text',
  tsx: 'text',
  js: 'text',
  jsx: 'text',
  mjs: 'text',
  cjs: 'text',
  css: 'text',
  scss: 'text',
  py: 'text',
  sh: 'text',
}

export function extensionOf(value: string): string {
  const base = basename(value)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

export function basename(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** A URL is always a browser target; a file goes by extension. */
export function classifyPreview(value: string, kind: 'file' | 'url'): ArtifactPreview {
  if (kind === 'url') return 'browser'
  return PREVIEW_BY_EXTENSION[extensionOf(value)] ?? 'external'
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:]+$/, '')
}

/**
 * Rewrite whatever a tool printed into a workspace-relative path.
 *
 * `root` is the project directory. An absolute path under it becomes relative;
 * an absolute path outside it returns `""`, which every caller reads as "not an
 * artifact of this project" — the alternative is shipping a candidate the
 * server is required to reject, and a panel full of permanently-missing files
 * teaches the user to ignore the panel.
 */
export function normalizePath(raw: string, root?: string | null): string {
  let value = raw.trim().replace(/\\+/g, '/')
  if (!value) return ''

  if (root) {
    const normalizedRoot = root.trim().replace(/\\+/g, '/').replace(/\/+$/, '')
    if (normalizedRoot && value === normalizedRoot) return ''
    if (normalizedRoot && value.startsWith(`${normalizedRoot}/`)) {
      value = value.slice(normalizedRoot.length + 1)
    }
  }
  // An absolute path that survived the root strip points outside the project.
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('~/')) return ''

  value = value.replace(/^\.\//, '')
  value = value.replace(WORKSPACES_PREFIX_PATTERN, '')
  value = value.replace(WORKSPACE_ID_PREFIX_PATTERN, '')
  return value
}

export function fileId(path: string): string {
  return `file:${path.toLowerCase()}`
}

export function urlId(url: string): string {
  return `url:${url}`
}

/**
 * A file candidate, or `null` when the string cannot be one.
 *
 * The rejections are all load-bearing:
 * - **no extension** — `FILE_PATTERN`'s second alternative would otherwise
 *   turn every bare word into a candidate;
 * - **`..` anywhere** — the server rejects it, so shipping it only wastes a
 *   slot in the resolve batch;
 * - **over 500 characters** — a match that long is a paragraph.
 */
export function candidateFromFile(
  path: string,
  confidence: number,
  reason: string,
  root?: string | null,
): ArtifactCandidate | null {
  const normalized = stripTrailingPunctuation(normalizePath(path, root))
  if (!normalized) return null
  if (normalized.length > MAX_PATH_LENGTH) return null
  if (!normalized.includes('.')) return null
  if (normalized.split('/').includes('..')) return null

  return {
    id: fileId(normalized),
    kind: 'file',
    value: normalized,
    name: basename(normalized),
    preview: classifyPreview(normalized, 'file'),
    confidence,
    reason,
  }
}

/**
 * A URL candidate.
 *
 * The origin collapse folds `http://localhost:3000/`, `http://localhost:3000//`
 * and a backslash-escaped variant into one id, which is the difference between
 * one "your dev server" entry and four.
 */
export function candidateFromUrl(
  url: string,
  confidence: number,
  reason: string,
): ArtifactCandidate | null {
  const trimmed = url.trim().replace(/[.,;:`\\]+$/, '')
  if (!trimmed) return null

  let clean = trimmed
  try {
    const parsed = new URL(trimmed)
    if (/^\/*$/.test(parsed.pathname) && !parsed.search && !parsed.hash) {
      clean = parsed.origin
    }
  } catch {
    // Not parseable: keep the stripped string. A malformed URL is still a
    // better tab label than nothing, and it is never opened without a click.
  }

  return {
    id: urlId(clean),
    kind: 'url',
    value: clean,
    name: basename(clean) || clean,
    preview: 'browser',
    confidence,
    reason,
  }
}
