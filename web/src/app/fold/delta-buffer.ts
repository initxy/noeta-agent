/**
 * The streaming-preview buffer.
 *
 * A delta is an ephemeral projection of bytes whose truth arrives later: the
 * `MessagesAppended` that follows is the durable record, and the final frame
 * *repaints* whatever this buffer was showing. Deltas are never persisted,
 * never folded into the item list, and never replayed — which is why this is a
 * separate, tiny state machine rather than part of the conversation reducer.
 *
 * Four rules, each of which exists because breaking it produced visible
 * garbage:
 *
 * 1. **A different `call_id` replaces the whole state.** That is what discards
 *    a half-stream abandoned by a retry.
 * 2. Same `(call_id, index)` with the same kind appends; a **different kind
 *    replaces**, because text and thinking at one index are two different
 *    things, not two halves of one.
 * 3. **Returning the same reference means "nothing changed".** The React layer
 *    subscribes by identity; a new-but-equal object re-renders the transcript
 *    on every dropped frame.
 * 4. **An invalid delta is ignored, by identity.** Unknown kinds and missing
 *    fields are how a forward-compatible wire looks from an older client, so
 *    they must be inert rather than corrupting.
 */

import type { DeltaKind } from '../types/ui-events'

export interface DeltaBlock {
  kind: DeltaKind
  text: string
}

/** One buffered call. There is at most one per session at a time. */
export interface DeltaState {
  callId: string
  blocks: ReadonlyMap<number, DeltaBlock>
}

const KINDS = new Set<string>(['text', 'thinking'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ValidDelta {
  callId: string
  kind: DeltaKind
  text: string
  index: number
}

/**
 * Accept a delta payload only if every field is exactly what it claims.
 *
 * Deliberately strict and deliberately silent: a frame that fails here is
 * dropped without a trace in the UI, because the durable record of the same
 * bytes is still coming and will repaint whatever was or was not previewed.
 */
function validate(delta: unknown): ValidDelta | null {
  if (!isRecord(delta)) return null
  const { call_id: callId, kind, text, index } = delta
  if (typeof callId !== 'string' || callId === '') return null
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  if (typeof text !== 'string') return null
  if (typeof index !== 'number' || !Number.isFinite(index)) return null
  return { callId, kind: kind as DeltaKind, text, index }
}

/**
 * Apply one `delta` frame's data.
 *
 * Returns the **same reference** when nothing changed — an invalid payload, or
 * an append that adds no characters.
 */
export function applyDelta(state: DeltaState | null, delta: unknown): DeltaState | null {
  const valid = validate(delta)
  if (!valid) return state

  if (state === null || state.callId !== valid.callId) {
    return {
      callId: valid.callId,
      blocks: new Map([[valid.index, { kind: valid.kind, text: valid.text }]]),
    }
  }

  const existing = state.blocks.get(valid.index)
  const next: DeltaBlock =
    existing && existing.kind === valid.kind
      ? { kind: valid.kind, text: existing.text + valid.text }
      : { kind: valid.kind, text: valid.text }

  if (existing && existing.kind === next.kind && existing.text === next.text) return state

  const blocks = new Map(state.blocks)
  blocks.set(valid.index, next)
  return { callId: state.callId, blocks }
}

/**
 * Clear the buffer for one call, on `llm_retry`.
 *
 * The retry re-streams under the **same** `call_id`; without this the old and
 * the new half-stream concatenate into garbage. A mismatched id is a genuine
 * no-op — it returns the same object, not a new equal one, so a retry on some
 * other call does not re-render the transcript. A `null` id clears
 * unconditionally.
 */
export function resetCall(state: DeltaState | null, callId: string | null): DeltaState | null {
  if (state === null) return state
  if (callId === null) return null
  return state.callId === callId ? null : state
}

/**
 * The blocks to render, in index order, or `null` when there is nothing to
 * show. Empty blocks are dropped: a delta can legitimately carry no
 * characters, and an empty preview bubble flickering in and out is worse than
 * no preview at all.
 */
export function renderDeltaBlocks(state: DeltaState | null): DeltaBlock[] | null {
  if (state === null) return null
  const visible = [...state.blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, block]) => block)
    .filter((block) => block.text !== '')
  return visible.length > 0 ? visible : null
}
