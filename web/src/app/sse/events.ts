/**
 * From an SSE frame to a UI event.
 *
 * One rule dominates this file: **a bad frame is skipped, never fatal.** The
 * session stream is the product's only live channel, and tearing it down over
 * one unparseable block would turn a cosmetic backend bug into a dead
 * conversation that a reload does not fix (the same bad frame is replayed).
 * So every failure path here returns `null` and the reader moves on.
 */

import { DEFAULT_EVENT_TYPE } from './decoder'
import type { SseFrame } from './decoder'
import type { RawUIEvent } from '../types/ui-events'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one decoded frame, or `null` to skip it.
 *
 * Skipped: a block that declared no `event:` line, a block whose `data:` is
 * not valid JSON, and a block whose data is not a JSON object.
 *
 * `seq` comes from the frame's own `id:` line and is `null` when there was
 * none — which is the load-bearing property of the whole transport. A frame
 * with a non-numeric id is treated as having none: the frame is still
 * delivered (dropping it would lose real content), it simply never advances
 * the resume cursor, so the worst case is that it is replayed and deduped.
 */
export function parseUIEvent(frame: SseFrame): RawUIEvent | null {
  if (!frame.event || frame.event === DEFAULT_EVENT_TYPE) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  // `Number('')` is 0, so an empty `id:` line has to be excluded explicitly or
  // it would claim seq 0 and dedup away the first envelope of the session.
  const seq = frame.id === null || frame.id === '' ? Number.NaN : Number(frame.id)
  return {
    seq: Number.isFinite(seq) ? seq : null,
    type: frame.event,
    data: parsed,
  }
}
