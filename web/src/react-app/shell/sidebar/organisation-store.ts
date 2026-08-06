/**
 * The sidebar's organisation state: pin/archive reconciliation and unread.
 *
 * Two pure folds (`organisation-protocol.ts`, `unread.ts`) behind one store,
 * so the sidebar has a single door and the two folds stay independently
 * testable. Nothing here decides anything; it sequences.
 *
 * Process-global rather than per-project, for the same reason unread is: both
 * are about sessions the user is *not* looking at, and a store scoped to the
 * open project forgets them at exactly the moment they start mattering.
 */

import { create } from 'zustand'
import { versionOf } from './versioned-row'
import type { VersionedSessionRow } from './versioned-row'
import {
  EMPTY_ORGANISATION,
  applySync,
  beginMutation,
  settleMutation,
  viewOrganisation,
} from './organisation-protocol'
import type {
  OrganisationSnapshot,
  OrganisationState,
  SessionOrganisation,
} from './organisation-protocol'
import { EMPTY_UNREAD, acknowledge, clearUnread, observeSessions } from './unread'
import type { UnreadState } from './unread'

export type { VersionedSessionRow } from './versioned-row'

export function snapshotOf(row: VersionedSessionRow): OrganisationSnapshot {
  return {
    id: row.id,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    version: versionOf(row),
  }
}

interface OrganisationStore {
  organisation: OrganisationState
  unread: UnreadState
  /** Fold one snapshot of a project's sessions in — the poll path. */
  observe: (rows: readonly VersionedSessionRow[], selectedId: string | null) => void
  /** Apply an optimistic pin/archive edit; returns the mutation number. */
  begin: (sessionId: string, patch: Partial<SessionOrganisation>) => number
  /** Reconcile one edit against the server's answer, or `null` when it failed. */
  settle: (sessionId: string, mutation: number, row: VersionedSessionRow | null) => void
  /** Opening a session reads it. */
  visit: (sessionId: string) => void
}

export const useOrganisationStore = create<OrganisationStore>((set, get) => ({
  organisation: EMPTY_ORGANISATION,
  unread: EMPTY_UNREAD,

  observe: (rows, selectedId) => {
    const state = get()
    const organisation = applySync(state.organisation, rows.map(snapshotOf))
    const unread = observeSessions(state.unread, rows, selectedId)
    if (organisation === state.organisation && unread === state.unread) return
    set({ organisation, unread })
  },

  begin: (sessionId, patch) => {
    const begun = beginMutation(get().organisation, sessionId, patch)
    set({ organisation: begun.state })
    return begun.mutation
  },

  settle: (sessionId, mutation, row) => {
    const state = get()
    set({
      organisation: settleMutation(
        state.organisation,
        sessionId,
        mutation,
        row ? snapshotOf(row) : null,
      ),
      // Our own write moved `updated_at`; rebasing here is what stops the
      // next poll reading it as a turn that finished in the background.
      unread: row ? acknowledge(state.unread, row) : state.unread,
    })
  },

  visit: (sessionId) => {
    const unread = clearUnread(get().unread, sessionId)
    if (unread !== get().unread) set({ unread })
  },
}))

/** The organisation view of one row: authoritative state with any edit on top. */
export function organisationOf(
  state: OrganisationState,
  row: VersionedSessionRow,
): SessionOrganisation {
  return viewOrganisation(state, snapshotOf(row))
}
