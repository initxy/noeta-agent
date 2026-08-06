/**
 * The mention side table: decoded value → what it refers to.
 *
 * A `@token` in a draft is only a chip if something knows what it means, and
 * the draft string cannot carry that — which is the point of a side table. It
 * is also the thing that stops the editor dressing an `@someone` typed in prose
 * as a file reference.
 *
 * **Entries are never removed.** Two facts make that the right shape rather
 * than a leak:
 *
 * - a queued message is a bare string, cleared out of the draft the moment it
 *   is queued, and its chips still have to render in the queued panel and
 *   resolve when the queue drains;
 * - a rejected send gives the draft back, so a value can come back after the
 *   draft that carried it is gone.
 *
 * The set is bounded by how many distinct files one person mentions in one
 * session, so pruning would cost more attention than it saves.
 */

import { create } from 'zustand'
import type { MentionKind, MentionTable } from '@/app/draft/tokens'

const EMPTY: MentionTable = {}

interface MentionStoreState {
  tables: Record<string, Record<string, MentionKind>>
  remember: (key: string, value: string, kind: MentionKind) => void
}

export const useMentionStore = create<MentionStoreState>((set) => ({
  tables: {},
  remember: (key, value, kind) =>
    set((state) => {
      const table = state.tables[key] ?? {}
      if (table[value] === kind) return state
      return { tables: { ...state.tables, [key]: { ...table, [value]: kind } } }
    }),
}))

export function useMentionTable(key: string): MentionTable {
  return useMentionStore((state) => state.tables[key] ?? EMPTY)
}

export function mentionActions() {
  return useMentionStore.getState()
}
