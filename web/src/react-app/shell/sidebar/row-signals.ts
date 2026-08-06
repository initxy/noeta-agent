/**
 * What a session row is allowed to signal, and where.
 *
 * Two signals on opposite edges of the row, **mutually exclusive by
 * construction** — that separation is what makes the sidebar readable at a
 * glance instead of a christmas tree:
 *
 * - **left, on the glyph lane: activity.** A dot-matrix, and only ever for
 *   work that is happening right now.
 * - **right, an 8px dot: outcome.** Only ever "this needs you" or "this
 *   finished while you were elsewhere".
 *
 * The two rules that are easy to get wrong, both of them deliberate:
 *
 * - **`waiting` is not activity.** A session parked on a question is not
 *   working, it is asking — that is an outcome, it belongs on the right edge,
 *   and putting a living animation on it says the opposite of what is true.
 * - **Activity wins the row.** While work is running the left lane owns the
 *   row and the right edge renders nothing, even if the session was unread a
 *   moment ago: an unread mark on a session that is visibly running again is
 *   noise about the past.
 *
 * Accessibility is a third, separate channel and is *not* subject to the
 * exclusion: every row carries exactly one accessible state name, always, so a
 * screen reader is never left to infer a row's state from a colour it cannot
 * see. See `activity-indicators.tsx`.
 */

import type { SessionStatus } from '@/app/types'

/** What the right edge may say. `null` is the common case: nothing at all. */
export type RowOutcome = 'waiting' | 'unread' | null

export interface RowSignals {
  /** Render the dot-matrix on the glyph lane. */
  activity: boolean
  /** Render the 8px dot at the trailing edge. */
  outcome: RowOutcome
}

export interface RowSignalInput {
  status: SessionStatus
  /** Derived, never pushed — see `unread.ts`. */
  unread?: boolean
  /** The session the user is looking at right now. */
  selected?: boolean
}

/**
 * The one place the two channels are decided, so they cannot both fire.
 *
 * `running` is the whole of this product's active-work vocabulary (wire
 * contract §7): `idle` / `running` / `waiting` is the entire status machine,
 * and only the middle one means "the agent is doing something".
 */
export function rowSignals({ status, unread = false, selected = false }: RowSignalInput): RowSignals {
  if (status === 'running') return { activity: true, outcome: null }
  if (status === 'waiting') return { activity: false, outcome: 'waiting' }
  if (unread && !selected) return { activity: false, outcome: 'unread' }
  return { activity: false, outcome: null }
}

/**
 * The accessible name for a row's state.
 *
 * One string per row, chosen from the same decision the visual signals are —
 * so the two can never describe different things.
 */
export function rowStateLabel(signals: RowSignals, status: SessionStatus): string {
  if (signals.activity) return 'Running'
  if (signals.outcome === 'waiting') return 'Waiting for you'
  if (signals.outcome === 'unread') return 'Unread'
  return status === 'idle' ? 'Idle' : status
}
