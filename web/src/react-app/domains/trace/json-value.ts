/**
 * How a raw payload is shaped for reading.
 *
 * The trace page renders arbitrary engine payloads, which range from three
 * scalars to a nested question spec with a dozen choices. Printing them as one
 * `JSON.stringify` block is what makes a debug surface useless: the interesting
 * two lines get lost in four hundred. So every container is collapsible, and
 * the *default* state is a judgement about size rather than a fixed depth —
 * a small nested object is worth showing inline, a large one is worth a click.
 *
 * Pure, and separate from the components that use it, so the policy is
 * testable and so the rendering file exports components only.
 */

/** Below this depth a container may open on its own; at or past it, never. */
export const AUTO_EXPAND_DEPTH = 2

/** More entries than this and the container starts collapsed at any depth. */
export const LARGE_NODE_ENTRIES = 20

/** More serialized characters than this and the container starts collapsed. */
export const LARGE_NODE_CHARS = 600

/** A string longer than this is itself a collapsible node, not a wall of text. */
export const LONG_STRING_CHARS = 300

/** Characters of a long string shown while it is collapsed. */
const STRING_PREVIEW_CHARS = 72

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Containers, plus long strings — anything with a hidden state worth toggling. */
export function isCollapsible(value: unknown): boolean {
  if (typeof value === 'string') return value.length > LONG_STRING_CHARS
  return Array.isArray(value) || isPlainRecord(value)
}

/** `[key, value]` pairs for a container; `[]` for anything else. */
export function entriesOf(value: unknown): [string, unknown][] {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item])
  if (isPlainRecord(value)) return Object.entries(value)
  return []
}

/**
 * Serialized length, or `Infinity` when the value cannot be serialized.
 *
 * Unserializable is treated as *large* rather than small: a value this page
 * cannot measure is exactly the one not to auto-expand into the list.
 */
export function approxSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function shouldAutoExpand(value: unknown, depth: number): boolean {
  if (!isCollapsible(value)) return true
  // A long string is never opened for you: it is the single biggest source of
  // wall-of-text on this page (clipped tool output, a thinking block).
  if (typeof value === 'string') return false
  if (depth >= AUTO_EXPAND_DEPTH) return false
  const entries = entriesOf(value)
  if (entries.length === 0) return true
  if (entries.length > LARGE_NODE_ENTRIES) return false
  return approxSize(value) <= LARGE_NODE_CHARS
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** The one-line stand-in shown while a node is collapsed. */
export function summarize(value: unknown): string {
  if (typeof value === 'string') {
    return `"${clip(value, STRING_PREVIEW_CHARS)}" · ${value.length} chars`
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[…] ${value.length} item${value.length === 1 ? '' : 's'}`
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    return `{ ${clip(keys.join(', '), STRING_PREVIEW_CHARS)} }`
  }
  return formatScalar(value)
}

/** How a non-container prints. Quoted strings, `null`, `undefined` — as JSON reads. */
export function formatScalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return String(value)
}
