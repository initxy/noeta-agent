/**
 * Unread, derived.
 *
 * Unread means exactly one thing: **the agent finished while you were looking
 * at something else.** It is *derived* from what the session index reports,
 * never a flag anybody pushes — a pushed flag is a second copy of the truth
 * and it goes stale the moment anything else about the row changes, which in
 * this product is every turn.
 *
 * The derivation is a fold over successive snapshots of the session list:
 *
 * - a row seen for the **first time** is recorded and never marked. A cold
 *   page load must not light up every session that ever finished;
 * - the **selected** session is never unread, and visiting one clears it;
 * - a row that **was working and is now idle** is unread;
 * - a row that **was idle, is idle, and moved** is also unread. This is the
 *   case a snapshot-based derivation would otherwise lose: the sidebar learns
 *   about background sessions by polling, and a turn that starts and finishes
 *   between two polls shows up as idle → idle with nothing in between. The
 *   row's `version` is the evidence — it is bumped by every write including
 *   the engine's own, so it catches the transition the status field slept
 *   through.
 *
 * `version` rather than `updated_at` for that last rule on purpose: it is
 * strictly monotonic per row, where a timestamp is only as fine as its
 * resolution and two writes inside the same millisecond are indistinguishable.
 *
 * The rule needs one guard: *our own* writes bump the version too, so pinning
 * a session would mark it unread. `acknowledge` rebases a row's baseline and
 * the organisation store calls it with every mutation response.
 */

import type { SessionStatus } from '@/app/types'
import { versionOf } from './versioned-row'
import type { VersionedSessionRow } from './versioned-row'

/** What was last observed about a row — the baseline the next snapshot is read against. */
export interface UnreadBaseline {
  status: SessionStatus
  version: number
}

export interface UnreadState {
  /** Session ids currently carrying the unread mark. */
  readonly unread: ReadonlySet<string>
  /** The last observation per row. Never pruned: unread is global and outlives a project switch. */
  readonly seen: Readonly<Record<string, UnreadBaseline>>
}

export const EMPTY_UNREAD: UnreadState = { unread: new Set<string>(), seen: {} }

/** Statuses that mean the agent is engaged: work running, or a question parked. */
function isActive(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting'
}

function baselineOf(row: VersionedSessionRow): UnreadBaseline {
  return { status: row.status, version: versionOf(row) }
}

/**
 * Fold one snapshot of a project's sessions into the unread state.
 *
 * Returns the **same reference** when nothing changed, so a poll that found no
 * news costs no re-render.
 */
export function observeSessions(
  state: UnreadState,
  rows: readonly VersionedSessionRow[],
  selectedId: string | null,
): UnreadState {
  const unread = new Set(state.unread)
  const seen: Record<string, UnreadBaseline> = { ...state.seen }
  let changed = false

  for (const row of rows) {
    const previous = state.seen[row.id]
    const next = baselineOf(row)

    if (row.id === selectedId) {
      // Looking at it *is* reading it, and that holds even while it runs: the
      // turn's output is arriving on screen.
      if (unread.delete(row.id)) changed = true
    } else if (!previous) {
      // First sight. Record, decide nothing.
    } else if (isActive(previous.status) && !isActive(row.status)) {
      if (!unread.has(row.id)) {
        unread.add(row.id)
        changed = true
      }
    } else if (
      !isActive(previous.status) &&
      !isActive(row.status) &&
      next.version > previous.version
    ) {
      // Idle → idle, but the row moved: a whole turn happened between two
      // observations. The status field cannot see it; the version can.
      if (!unread.has(row.id)) {
        unread.add(row.id)
        changed = true
      }
    }

    if (!previous || previous.status !== next.status || previous.version !== next.version) {
      seen[row.id] = next
      changed = true
    }
  }

  return changed ? { unread, seen } : state
}

/** Clear one row's mark — what opening a session does, before it navigates. */
export function clearUnread(state: UnreadState, sessionId: string): UnreadState {
  if (!state.unread.has(sessionId)) return state
  const unread = new Set(state.unread)
  unread.delete(sessionId)
  return { unread, seen: state.seen }
}

/**
 * Rebase a row's baseline to a state we caused ourselves.
 *
 * A pin, an archive or a rename bumps the version without the agent having
 * done anything, and the idle → idle rule above would read that as a finished
 * turn. Acknowledging the response we already hold means the next snapshot has
 * nothing new to report.
 */
export function acknowledge(state: UnreadState, row: VersionedSessionRow): UnreadState {
  const previous = state.seen[row.id]
  const next = baselineOf(row)
  if (previous && previous.status === next.status && previous.version === next.version) {
    return state
  }
  return { unread: state.unread, seen: { ...state.seen, [row.id]: next } }
}
