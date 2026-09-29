/**
 * Readers over one serialized `EventEnvelope`.
 *
 * Trace is the only surface that renders the engine's own record instead of
 * the product's UI-event vocabulary, so it deliberately does **not** model the
 * engine's types. `envelope_to_dict` is driven by `dataclasses.fields`: the
 * shape follows the engine's release cadence, and any field may appear, vanish
 * or change type without this page being touched.
 *
 * Every reader here therefore degrades instead of throwing. An envelope that
 * does not match expectations is precisely the envelope a developer opened
 * this page to look at — losing the whole list to one of them would destroy
 * the surface's only reason to exist.
 */

import type { RawEnvelope } from '@/app/types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shown in place of a `task_id` the envelope did not carry. */
export const UNKNOWN_TASK_ID = '(no task)'

/** Shown in place of a `type` the envelope did not carry. */
export const UNKNOWN_TYPE = '(untyped)'

export function envelopeType(envelope: RawEnvelope): string {
  const raw = (envelope as { type?: unknown }).type
  return typeof raw === 'string' && raw ? raw : UNKNOWN_TYPE
}

export function envelopeTaskId(envelope: RawEnvelope): string {
  const raw = (envelope as { task_id?: unknown }).task_id
  return typeof raw === 'string' && raw ? raw : UNKNOWN_TASK_ID
}

/**
 * The envelope's `seq`, or `null` when it does not carry a usable one.
 *
 * `null` is not the same as `0`: seq 0 is the first envelope of every stream,
 * and treating a missing seq as 0 would make it collide with a real one on
 * dedup.
 */
export function envelopeSeq(envelope: RawEnvelope): number | null {
  const raw = (envelope as { seq?: unknown }).seq
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

export function envelopePayload(envelope: RawEnvelope): unknown {
  return (envelope as { payload?: unknown }).payload
}

/**
 * A stable identity for one envelope.
 *
 * `(task_id, seq)` is the engine's own primary key, which is what lets a row
 * survive a re-render and a card claim exactly the envelopes it paired. The
 * positional fallback exists only for a malformed envelope with no seq: it is
 * not stable across pages, but such an envelope cannot be deduped anyway.
 */
export function envelopeKey(envelope: RawEnvelope, index: number): string {
  const seq = envelopeSeq(envelope)
  const task = envelopeTaskId(envelope)
  return seq === null ? `${task}#@${index}` : `${task}#${seq}`
}

// ---------------------------------------------------------------------------
// ContentRef
// ---------------------------------------------------------------------------

/**
 * A content-addressed blob referenced by an envelope.
 *
 * The engine keeps large bodies — tool output, thinking blocks, question
 * specs, images — out of the event log and stores a reference instead. The
 * trace page resolves them **on demand** (`GET /api/v1/content/{hash}`), never
 * eagerly: a page of envelopes can hold dozens of refs, and fetching them all
 * to render a list would pull megabytes for bodies nobody opened.
 */
export interface ContentRefInfo {
  hash: string
  mediaType: string | null
  size: number | null
  /** The engine's own tag for the value, shown as-is because this is a debug surface. */
  tag: string
}

/**
 * The content hash as `/content/{hash}` accepts it: 64 hex characters or 404.
 *
 * Used as the *discriminator* rather than the tag's exact spelling. The wire
 * contract says a tagged value is recognised through `__canonical_tag__`
 * (never `isinstance`), but it never fixes the tag's namespace — so this
 * requires the value to be tagged at all, and then keys on the one field whose
 * format the REST surface does pin.
 */
const CONTENT_HASH = /^[0-9a-f]{64}$/i

function readHash(value: Record<string, unknown>): string | null {
  for (const field of ['hash', 'content_hash'] as const) {
    const candidate = value[field]
    if (typeof candidate === 'string' && CONTENT_HASH.test(candidate)) return candidate
  }
  return null
}

export function asContentRef(value: unknown): ContentRefInfo | null {
  if (!isRecord(value)) return null
  const tag = value.__canonical_tag__
  if (typeof tag !== 'string' || !tag) return null
  const hash = readHash(value)
  if (hash === null) return null
  const mediaType = value.media_type
  const size = value.size
  return {
    hash,
    mediaType: typeof mediaType === 'string' && mediaType ? mediaType : null,
    size: typeof size === 'number' && Number.isFinite(size) ? size : null,
    tag,
  }
}

/**
 * Wall-clock time from the envelope's `occurred_at` (epoch seconds, float).
 *
 * Millisecond precision is kept: the ordering questions this page is opened to
 * answer — did the cancel land before the suspend? — are decided inside one
 * second far more often than not.
 */
export function formatOccurredAt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const ms = Math.round(value * 1000)
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) return ''
  const millis = String(((ms % 1000) + 1000) % 1000).padStart(3, '0')
  return `${at.toLocaleTimeString(undefined, { hour12: false })}.${millis}`
}
