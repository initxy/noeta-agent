/**
 * Accumulating the raw-event stream across pages.
 *
 * `GET /trace/sessions/{id}/raw-events` is incremental, and its cursor is a
 * **`{task_id: last_seq}` map, not a scalar** — every task stream counts `seq`
 * from 0 independently, so one number can only ever describe one stream. The
 * defect this shape exists to prevent is concrete: a scalar cursor read the
 * root stream only, and clicking a subagent on the trace page showed nothing
 * at all.
 *
 * Two consequences drive everything below.
 *
 * - **Dedup is per stream.** A subtask's seq 0 is a new envelope even when the
 *   root is already at seq 40. Comparing against a single "last seen" number
 *   silently swallows a whole subagent.
 * - **The cursor only ever grows, per stream.** A page that advances the root
 *   and says nothing about a subtask must not drop the subtask's entry: the
 *   next request would then ask for that stream from 0 and re-deliver it
 *   forever. Merging by `max` per key makes the increment strict in both
 *   directions — no gaps, no repeats.
 *
 * Pure, so the whole cursor contract is testable without a backend or a React
 * tree; `use-trace-stream.ts` is the thin part that polls.
 */

import type { RawEnvelope, RawEventsPayload, TraceCursor } from '@/app/types'
import { envelopeSeq, envelopeTaskId } from './raw-envelope'

export interface TraceStreamState {
  /** What to send on the next request: the high-water seq of every known stream. */
  cursor: TraceCursor
  /** Every envelope seen so far, in arrival order. */
  events: RawEnvelope[]
  /**
   * Known task streams in discovery order. The first is the session's root
   * stream — the raw-events endpoint discovers subtasks *from* the root
   * increment, so the root is always seen first.
   */
  streams: string[]
}

export const initialTraceStreamState: TraceStreamState = {
  cursor: {},
  events: [],
  streams: [],
}

/**
 * Fold one response page into the accumulated state.
 *
 * Returns the **same state reference** when the page carried nothing new. That
 * is what tells React there is nothing to re-render, and it is also the poll
 * loop's stop condition: a server that keeps replaying the same page cannot
 * spin the client, because "no change" is observable rather than inferred from
 * an empty array.
 */
export function applyRawEventsPage(
  state: TraceStreamState,
  payload: RawEventsPayload,
): TraceStreamState {
  const incoming = Array.isArray(payload?.events) ? payload.events : []

  const cursor: TraceCursor = { ...state.cursor }
  const streams = [...state.streams]
  const known = new Set(streams)
  const accepted: RawEnvelope[] = []
  let cursorChanged = false

  const observe = (taskId: string) => {
    if (known.has(taskId)) return
    known.add(taskId)
    streams.push(taskId)
  }

  const advance = (taskId: string, seq: number) => {
    const current = cursor[taskId]
    if (current !== undefined && current >= seq) return
    cursor[taskId] = seq
    cursorChanged = true
  }

  for (const envelope of incoming) {
    const taskId = envelopeTaskId(envelope)
    const seq = envelopeSeq(envelope)

    // Per-stream dedup. An envelope at or below *this* stream's high-water
    // mark was already folded in — which happens whenever a page overlaps a
    // previous one, and must never be decided against another stream's mark.
    if (seq !== null && cursor[taskId] !== undefined && seq <= cursor[taskId]) continue

    observe(taskId)
    accepted.push(envelope)
    if (seq !== null) advance(taskId, seq)
  }

  // The server's cursor wins where it is ahead of what the events showed —
  // it is the authority on streams whose increment was empty this round.
  const returned = payload?.cursor
  if (returned && typeof returned === 'object') {
    for (const [taskId, seq] of Object.entries(returned)) {
      if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
      // A stream can be known before any of its envelopes arrive; the switcher
      // should list it rather than pretend it does not exist.
      observe(taskId)
      advance(taskId, seq)
    }
  }

  const streamsChanged = streams.length !== state.streams.length
  if (accepted.length === 0 && !cursorChanged && !streamsChanged) return state

  return {
    cursor,
    events: accepted.length === 0 ? state.events : [...state.events, ...accepted],
    streams: streamsChanged ? streams : state.streams,
  }
}

/** Envelopes per stream, for the switcher's counts. */
export function countByStream(events: readonly RawEnvelope[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const envelope of events) {
    const taskId = envelopeTaskId(envelope)
    counts[taskId] = (counts[taskId] ?? 0) + 1
  }
  return counts
}
