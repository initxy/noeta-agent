/**
 * The session index for one project — the list the sidebar renders and the
 * route resolves ids against.
 *
 * A session carries its fork lineage (`parentSessionId`, `branchedAtSeq`) so
 * the surfaces that open it can say where it came from. Both are null on an
 * ordinary session; a fork is its own session nested under its source.
 *
 * `status` is explicit rather than derived from an empty array, because "still
 * loading" and "loaded, and there are none" must never render the same way —
 * conflating them is how a not-found flashes on every cold start.
 */

import { useMemo } from 'react'
import type { SessionRow } from '@/app/types'
import { useSessionRows } from './queries/session-queries'

export interface SessionSummary {
  id: string
  title: string
  /** The session this was forked from, or null for an ordinary session. */
  parentSessionId: string | null
  /** The user-message seq it was forked at, or null when not a fork. */
  branchedAtSeq: number | null
}

export interface SessionIndex {
  status: 'loading' | 'ready'
  sessions: SessionSummary[]
  /**
   * The list could not be read. Optional because the routing rules deliberately
   * do not branch on it — an index that failed to load knows nothing about the
   * session in the URL, which is the same answer as "it is not there".
   */
  error?: Error | null
}

const NO_SESSIONS: SessionSummary[] = []

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    parentSessionId: row.parent_session_id ?? null,
    branchedAtSeq: row.branched_at_seq ?? null,
  }
}

export function useSessionIndex(projectId: string): SessionIndex {
  const query = useSessionRows(projectId)
  const rows = query.data
  const { isLoading, error } = query

  return useMemo(
    () => ({
      // `isLoading`, not `isPending`: a query disabled for want of a project id
      // is pending forever, and a sidebar stuck on "Loading…" is worse than an
      // honest empty list.
      status: isLoading ? 'loading' : 'ready',
      sessions: rows ? rows.map(toSummary) : NO_SESSIONS,
      error,
    }),
    [isLoading, rows, error],
  )
}
