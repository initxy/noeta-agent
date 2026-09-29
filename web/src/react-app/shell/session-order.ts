/**
 * Sidebar order for a project's sessions.
 *
 * Most-recently-touched first, because a session is picked up again far more
 * often than it is picked out of an alphabet. `updated_at` is a server
 * timestamp, so the ordering agrees across tabs and survives a reload.
 *
 * Pinned rows float to the top and archived rows are dropped: both fields are
 * on the wire already, and honouring them now means Phase 6 adds the
 * *controls* rather than also having to teach the list what they mean.
 */

import type { SessionRow } from '@/app/types'

/**
 * Most recently touched first, with the id as a total tie-break.
 *
 * Extracted because the sidebar sorts *within* each of its sections (pinned,
 * active, archived) and the flat sort below sorts across them: one definition
 * of "most recently touched", used three times, so the rail cannot order two
 * of its sections by different rules.
 */
export function compareSessionRecency(a: SessionRow, b: SessionRow): number {
  const byTime = Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '')
  // NaN when a timestamp is missing or unparseable. Falling through to a
  // stable tie-break matters: a comparator that returns NaN leaves the
  // order to the sort implementation, and the list reshuffles on rerender.
  if (Number.isFinite(byTime) && byTime !== 0) return byTime
  return a.id.localeCompare(b.id)
}

/**
 * Sorting is done on a copy — the array belongs to the query cache, and
 * sorting it in place reorders it for every other consumer without notifying
 * any of them.
 */
export function sortSessionRows(rows: readonly SessionRow[]): SessionRow[] {
  return rows
    .filter((row) => !row.archived)
    .slice()
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return compareSessionRecency(a, b)
    })
}
