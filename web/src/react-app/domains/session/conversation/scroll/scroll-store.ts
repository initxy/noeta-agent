/**
 * Where each session's transcript is parked.
 *
 * **Per session, not per surface.** A reader who scrolled back through one
 * conversation and then opened another must land at the bottom of the new one
 * and, on return, exactly where they left the first. Holding a single mode for
 * "the transcript" makes every session inherit the last one's, which reads as
 * the app losing its place at random.
 *
 * Not persisted, by the same rule as the workbench store: this is process
 * memory. A scroll offset restored from storage would outrank the far more
 * likely intent of a cold start, which is to see the end of the conversation.
 *
 * Setters return the **same state object** when nothing changed. A scroll
 * handler fires dozens of times per gesture and almost all of those events
 * decide nothing; a new-but-equal object on each would re-render the overlay,
 * and through it the surface, at input frequency.
 */

import { create } from 'zustand'
import type { ScrollMode } from './scroll-machine'

export interface SessionScrollState {
  mode: ScrollMode
  /** Meaningful only while `manual`; kept at 0 in sticky so the shape is flat. */
  scrollTop: number
  /**
   * The newest message when it is taller than the viewport *and* its top edge
   * has scrolled off — the case where "jump to latest" is useless because you
   * are already inside the latest and cannot see where it began.
   */
  topClippedKey: string | null
}

const DEFAULT: SessionScrollState = { mode: 'sticky', scrollTop: 0, topClippedKey: null }

interface ScrollStoreState {
  sessions: Record<string, SessionScrollState>
  setSticky: (sessionId: string) => void
  setManual: (sessionId: string, scrollTop: number) => void
  setTopClipped: (sessionId: string, key: string | null) => void
  forget: (sessionId: string) => void
}

export const useScrollStore = create<ScrollStoreState>((set) => {
  const patch = (
    sessionId: string,
    next: (current: SessionScrollState) => SessionScrollState,
  ) =>
    set((state) => {
      const current = state.sessions[sessionId] ?? DEFAULT
      const updated = next(current)
      if (
        state.sessions[sessionId] !== undefined &&
        updated.mode === current.mode &&
        updated.scrollTop === current.scrollTop &&
        updated.topClippedKey === current.topClippedKey
      ) {
        return state
      }
      return { sessions: { ...state.sessions, [sessionId]: updated } }
    })

  return {
    sessions: {},

    setSticky: (sessionId) =>
      patch(sessionId, (current) => ({ ...current, mode: 'sticky', scrollTop: 0 })),

    // Clamped rather than trusted: a negative offset is what an overscroll
    // bounce reports, and restoring it later scrolls to a position that does
    // not exist.
    setManual: (sessionId, scrollTop) =>
      patch(sessionId, (current) => ({
        ...current,
        mode: 'manual',
        scrollTop: Math.max(0, Math.round(scrollTop)),
      })),

    setTopClipped: (sessionId, key) =>
      patch(sessionId, (current) => ({ ...current, topClippedKey: key })),

    forget: (sessionId) =>
      set((state) => {
        if (state.sessions[sessionId] === undefined) return state
        const sessions = { ...state.sessions }
        delete sessions[sessionId]
        return { sessions }
      }),
  }
})

/** One session's parked position. Stable identity while it does not move. */
export function scrollStateOf(sessionId: string | null): SessionScrollState {
  if (sessionId === null) return DEFAULT
  return useScrollStore.getState().sessions[sessionId] ?? DEFAULT
}

export function useSessionScrollState(sessionId: string | null): SessionScrollState {
  return useScrollStore((state) =>
    sessionId === null ? DEFAULT : (state.sessions[sessionId] ?? DEFAULT),
  )
}

export function scrollActions() {
  return useScrollStore.getState()
}
