/**
 * The panel's per-session state: what artifacts a session produced, and whether
 * the panel is showing.
 *
 * Per session and not global, because a panel is part of a conversation: the
 * files session A produced have nothing to do with session B, and a shared
 * store means every session switch shows you someone else's panel. The store is
 * a map keyed by session id and every selector takes one — there is no ambient
 * "current session" here, which is what makes the isolation structural rather
 * than a discipline.
 *
 * **Not persisted.** Artifact targets are re-derived from a transcript that is
 * itself re-derived on every load, so a restored list would either duplicate
 * that work or contradict it. A cold start shows the conversation, and the
 * panel opens when the user opens it — nothing auto-opens.
 *
 * There is deliberately **no selection here.** Which file is open is the file
 * browser's own state (`FilesView`), controlled by the dock within one mounted
 * panel; it does not outlive the panel and so has no place in a session-keyed
 * store.
 */

import { create } from 'zustand'
import type { ArtifactTarget } from '@/app/types/artifacts'

const NO_TARGETS: readonly ArtifactTarget[] = Object.freeze([])

interface PanelStoreState {
  /** The **full** resolved list per session, not just the collectible subset —
   *  the in-conversation affordances need the openable ones too. */
  targets: Record<string, readonly ArtifactTarget[]>
  /** Whether the panel is showing at all, per session. */
  open: Record<string, boolean>

  /** Adopt the server-verified targets for a session. */
  syncTargets: (sessionId: string, targets: readonly ArtifactTarget[]) => void
  setOpen: (sessionId: string, open: boolean) => void
  /** Forget a session entirely. Called when a session is deleted. */
  clearSession: (sessionId: string) => void
}

export const usePanelTabStore = create<PanelStoreState>((set) => ({
  targets: {},
  open: {},

  syncTargets: (sessionId, targets) =>
    set((state) => ({ targets: { ...state.targets, [sessionId]: targets } })),

  setOpen: (sessionId, open) =>
    set((state) =>
      (state.open[sessionId] ?? false) === open
        ? state
        : { open: { ...state.open, [sessionId]: open } },
    ),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.targets) && !(sessionId in state.open)) return state
      const targets = { ...state.targets }
      const open = { ...state.open }
      delete targets[sessionId]
      delete open[sessionId]
      return { targets, open }
    }),
}))

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Every resolved target, collectible or not. */
export function usePanelTargets(sessionId: string): readonly ArtifactTarget[] {
  return usePanelTabStore((state) => state.targets[sessionId] ?? NO_TARGETS)
}

export function usePanelOpen(sessionId: string): boolean {
  return usePanelTabStore((state) => state.open[sessionId] ?? false)
}

export function panelActions() {
  return usePanelTabStore.getState()
}
