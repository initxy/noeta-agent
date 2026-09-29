/**
 * The find bar's state — one bar, app-wide.
 *
 * A singleton rather than per-session state because that is what ⌘F means: the
 * browser has one find bar, and a second one opening behind a split pane would
 * be a surface nobody asked for and nobody can see. The **owner** is therefore
 * part of the state: a session surface renders the bar only while `sessionId`
 * names it, and closes find when it unmounts while owning it.
 *
 * `query` and `appliedQuery` are separate on purpose. `query` is what the input
 * shows and changes on every keystroke; `appliedQuery` is what the DOM has been
 * rewritten for, and it lags by a debounce. Collapsing them would re-walk the
 * whole transcript per character.
 */

import { create } from 'zustand'

interface FindStoreState {
  open: boolean
  /** Which session surface owns the bar. Null only while closed. */
  sessionId: string | null
  query: string
  /** The query the marks in the DOM were built from. */
  appliedQuery: string
  /** Bumped on every open so re-triggering ⌘F re-focuses an already-open bar. */
  focusNonce: number
  matchCount: number
  activeIndex: number

  openFind: (sessionId: string) => void
  closeFind: () => void
  setQuery: (query: string) => void
  applyQuery: (query: string) => void
  setMatches: (matchCount: number, activeIndex: number) => void
  /** Close if `sessionId` owns the bar; used when a surface unmounts. */
  releaseOwner: (sessionId: string) => void
}

const CLOSED = {
  open: false,
  sessionId: null,
  query: '',
  appliedQuery: '',
  matchCount: 0,
  activeIndex: -1,
}

export const useFindStore = create<FindStoreState>((set) => ({
  ...CLOSED,
  focusNonce: 0,

  // Opening seeds `appliedQuery` immediately: re-opening onto an existing
  // query must show its matches now, not after a debounce that exists for
  // typing.
  openFind: (sessionId) =>
    set((state) => ({
      ...state,
      open: true,
      sessionId,
      appliedQuery: state.sessionId === sessionId ? state.query : '',
      query: state.sessionId === sessionId ? state.query : '',
      focusNonce: state.focusNonce + 1,
    })),

  closeFind: () => set((state) => ({ ...state, ...CLOSED })),

  setQuery: (query) => set((state) => (state.query === query ? state : { ...state, query })),

  applyQuery: (appliedQuery) =>
    set((state) => (state.appliedQuery === appliedQuery ? state : { ...state, appliedQuery })),

  setMatches: (matchCount, activeIndex) =>
    set((state) =>
      state.matchCount === matchCount && state.activeIndex === activeIndex
        ? state
        : { ...state, matchCount, activeIndex },
    ),

  releaseOwner: (sessionId) =>
    set((state) => (state.sessionId === sessionId ? { ...state, ...CLOSED } : state)),
}))

export function findActions() {
  return useFindStore.getState()
}
