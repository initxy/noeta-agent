/**
 * The sidebar's read model for one project's sessions.
 *
 * It joins three things the sidebar cannot get from any one of them alone: the
 * session domain's list query (the server rows), the organisation store (pin /
 * archive / unread), and the PATCH that writes an organisation change back.
 *
 * **Why the sidebar polls.** Unread means "the agent finished while you were
 * elsewhere", and *elsewhere* is the whole point: the SSE stream is per session
 * and only the open one is connected, so nothing else in the app would ever
 * learn that a background session finished. The session index is the only
 * surface that knows, so the rail re-reads it on a timer. The interval is long
 * — this is a local backend answering a small indexed query, but it is still a
 * request nobody asked for.
 *
 * The poll invalidates by *prefix*. The session domain owns the key's shape;
 * the sidebar only knows that every session query lives under `['sessions']`,
 * which is the one part of it that is not the domain's business to change.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { updateSession } from '@/app/api'
import type { SessionRow } from '@/app/types'
import { panelActions } from '@/react-app/domains/panels/panel-index'
import { useDeleteSession, useSessionRows } from '@/react-app/domains/session/queries/session-queries'
import { conversationActions } from '@/react-app/domains/session/state/conversation-store'
import { organisationOf, useOrganisationStore } from './organisation-store'
import type { SessionOrganisation } from './organisation-protocol'
import { sessionSections, sidebarEntries } from './session-sections'
import type { SidebarSection } from './session-sections'

/** How often the rail re-reads the session index. */
export const SIDEBAR_POLL_MS = 8_000

/** Every session query lives under this prefix; the rest of the key is the domain's. */
const SESSIONS_QUERY_ROOT = ['sessions'] as const

export interface SessionOrganisationView {
  status: 'loading' | 'ready'
  error: Error | null
  sections: SidebarSection[]
  /** How many sessions the project has, across every section. */
  total: number
  setPinned: (sessionId: string, pinned: boolean) => void
  setArchived: (sessionId: string, archived: boolean) => void
  /** Opening a session reads it — call before navigating, not after. */
  visit: (sessionId: string) => void
  /**
   * Delete a session and forget everything the client was holding for it.
   *
   * Four stores, because a session id is a key in four of them and a stale
   * entry in any one of them outlives the row: the transcript fold, the panel
   * dock's tabs, the workbench's retained tabs, and this rail's own baseline.
   * They are cleared **after** the server confirms — a failed delete must
   * leave the session usable, not half-erased.
   *
   * Resolves to the session focus should land on, or `null` for "nothing
   * selected"; the caller owns the navigation, because the URL is the shell's.
   */
  remove: (sessionId: string) => Promise<string | null>
}

export function useSessionOrganisation(
  projectId: string,
  selectedSessionId: string | null,
): SessionOrganisationView {
  const query = useSessionRows(projectId)
  const rows: SessionRow[] | undefined = query.data

  const organisation = useOrganisationStore((state) => state.organisation)
  const unread = useOrganisationStore((state) => state.unread)
  const observe = useOrganisationStore((state) => state.observe)
  const begin = useOrganisationStore((state) => state.begin)
  const settle = useOrganisationStore((state) => state.settle)
  const visit = useOrganisationStore((state) => state.visit)

  const queryClient = useQueryClient()

  // Every delivery of the list is a sync. The fold decides whether it lands
  // now or waits for an in-flight mutation to settle.
  useEffect(() => {
    if (!rows) return
    observe(rows, selectedSessionId)
  }, [rows, selectedSessionId, observe])

  useEffect(() => {
    if (!projectId) return
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_ROOT })
    }, SIDEBAR_POLL_MS)
    return () => window.clearInterval(timer)
  }, [projectId, queryClient])

  const mutate = useCallback(
    (sessionId: string, patch: Partial<SessionOrganisation>) => {
      const mutation = begin(sessionId, patch)
      // Deliberately not a `useMutation`: the reconciliation this needs is the
      // protocol's, and a second notion of pending state beside `pending`
      // would be a second thing to keep in step.
      void updateSession(sessionId, patch).then(
        (updated) => settle(sessionId, mutation, updated),
        () => settle(sessionId, mutation, null),
      )
    },
    [begin, settle],
  )

  const setPinned = useCallback(
    (sessionId: string, pinned: boolean) => mutate(sessionId, { pinned }),
    [mutate],
  )
  const setArchived = useCallback(
    (sessionId: string, archived: boolean) => mutate(sessionId, { archived }),
    [mutate],
  )

  const deletion = useDeleteSession()
  const removeSession = deletion.mutateAsync
  const remove = useCallback(
    async (sessionId: string): Promise<string | null> => {
      await removeSession({ projectId, sessionId })
      conversationActions().forget(sessionId)
      panelActions().clearSession(sessionId)
      const remaining = (rows ?? []).filter((row) => row.id !== sessionId)
      return remaining[0]?.id ?? null
    },
    [projectId, removeSession, rows],
  )

  const sections = useMemo(() => {
    const entries = sidebarEntries(
      rows ?? [],
      (row) => organisationOf(organisation, row),
      unread.unread,
    )
    return sessionSections(entries)
  }, [rows, organisation, unread])

  return {
    // `isLoading`, not `isPending`: a query disabled for want of a project id
    // is pending forever, and a sidebar stuck on "Loading…" is worse than an
    // honest empty list.
    status: query.isLoading ? 'loading' : 'ready',
    error: query.error ?? null,
    sections,
    total: rows?.length ?? 0,
    setPinned,
    setArchived,
    visit,
    remove,
  }
}
