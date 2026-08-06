/**
 * ↑ / ↓ recall of what you sent before.
 *
 * Two decisions carry this module.
 *
 * **History lives outside per-session composer state.** It is a property of
 * the person, not of the conversation: the prompt you want back is usually the
 * one you just sent *somewhere else*, and a per-session buffer is empty
 * exactly when a new session makes recall most useful. Keeping it out of the
 * composer store also means the `clearDraft` that follows every successful
 * send cannot take the recall buffer with it — a bug whose symptom is "↑ works
 * until it matters".
 *
 * **↑ only starts recall on an empty composer, and any edit ends it.** Getting
 * this wrong is not a cosmetic miss: ↑ inside a half-written message would
 * replace text the user is still writing, with no undo, from a keystroke they
 * pressed to move the caret. So recall starts only from a blank box, and the
 * moment the recalled text stops matching what recall put there, recall is
 * over and ↑ goes back to being a caret key.
 *
 * The state machine is three values and is deliberately pure — `useHistoryRecall`
 * is a thin ref around `stepBack` / `stepForward`, so the edge cases are tested
 * as data rather than through a keyboard.
 */

import { useRef } from 'react'
import { create } from 'zustand'

/** How many prompts are kept. Beyond this, recall is a search box, not an arrow key. */
export const HISTORY_LIMIT = 50

interface HistoryStoreState {
  /** Oldest first, so `length - 1` is "the one I just sent". */
  entries: readonly string[]
  append: (text: string) => void
  clear: () => void
}

export const useHistoryStore = create<HistoryStoreState>((set) => ({
  entries: [],
  append: (text) =>
    set((state) => {
      const entry = text.trim()
      // An empty send is not a thing, and pressing Run twice on the same text
      // should not mean pressing ↑ twice to get past it.
      if (entry === '') return state
      const last = state.entries[state.entries.length - 1]
      if (last === entry) return state
      const entries = [...state.entries, entry]
      return { entries: entries.length > HISTORY_LIMIT ? entries.slice(-HISTORY_LIMIT) : entries }
    }),
  clear: () => set({ entries: [] }),
}))

/**
 * Record a sent prompt.
 *
 * Call it **after** the send is accepted. A rejected send leaves the text in
 * the composer, so recording it there would put the same string both in the
 * box and one ↑ away.
 */
export function appendHistory(text: string): void {
  useHistoryStore.getState().append(text)
}

export function useHistoryEntries(): readonly string[] {
  return useHistoryStore((state) => state.entries)
}

/**
 * Where recall is.
 *
 * `position` is an index into the history, or `null` for "not recalling".
 * `expected` is what the draft should still be if recall is live — the single
 * comparison that detects an edit without watching keystrokes. `stash` is
 * whatever was in the box when recall started, so ↓ past the newest entry can
 * give it back.
 */
export interface RecallState {
  position: number | null
  expected: string | null
  stash: string
}

export const NOT_RECALLING: RecallState = { position: null, expected: null, stash: '' }

/**
 * Recall, re-checked against the live draft.
 *
 * Any difference between the draft and what recall last wrote means the user
 * edited it, and that ends recall. Doing this on read rather than in an effect
 * is what makes it impossible for a keystroke to be handled against a stale
 * position.
 */
export function syncRecall(state: RecallState, draft: string): RecallState {
  if (state.position === null) return state
  return draft === state.expected ? state : NOT_RECALLING
}

/** What a step produced: the new machine state, and the draft to show. */
export interface RecallStep {
  state: RecallState
  draft: string
}

/**
 * ↑. Returns `null` when the key is not recall — the caller must then let the
 * event through so the caret moves normally.
 *
 * Starting requires an empty box. "Empty" is `trim() === ''`, so a box holding
 * only whitespace still recalls, and the whitespace is stashed.
 */
export function stepBack(
  state: RecallState,
  draft: string,
  history: readonly string[],
): RecallStep | null {
  const current = syncRecall(state, draft)

  if (current.position === null) {
    if (draft.trim() !== '' || history.length === 0) return null
    const position = history.length - 1
    return {
      state: { position, expected: history[position], stash: draft },
      draft: history[position],
    }
  }

  if (current.position <= 0) return null
  const position = current.position - 1
  return {
    state: { position, expected: history[position], stash: current.stash },
    draft: history[position],
  }
}

/**
 * ↓. Only ever acts while recalling; stepping past the newest entry exits and
 * restores whatever the box held before ↑ was first pressed.
 */
export function stepForward(
  state: RecallState,
  draft: string,
  history: readonly string[],
): RecallStep | null {
  const current = syncRecall(state, draft)
  if (current.position === null) return null

  const position = current.position + 1
  if (position >= history.length) {
    return { state: NOT_RECALLING, draft: current.stash }
  }
  return {
    state: { position, expected: history[position], stash: current.stash },
    draft: history[position],
  }
}

export interface HistoryRecall {
  /**
   * Handle ↑ against the live draft. Returns the text to put in the composer,
   * or `null` to leave the event alone.
   */
  back: (draft: string) => string | null
  /** Handle ↓. Same contract. */
  forward: (draft: string) => string | null
}

/**
 * The machine as a hook.
 *
 * Both functions take the *current* draft rather than reading one captured at
 * render: a keydown handler runs between renders, and recall that judged
 * "unedited" from a stale draft is exactly the bug this module exists to
 * prevent. For the same reason the history is read at keypress instead of
 * subscribed to — this hook renders nothing, so re-rendering the composer on
 * every send just to keep an array fresh would buy nothing.
 */
export function useHistoryRecall(): HistoryRecall {
  const stateRef = useRef<RecallState>(NOT_RECALLING)

  const apply = (
    step: (state: RecallState, draft: string, history: readonly string[]) => RecallStep | null,
    draft: string,
  ): string | null => {
    const result = step(stateRef.current, draft, useHistoryStore.getState().entries)
    if (result === null) {
      stateRef.current = syncRecall(stateRef.current, draft)
      return null
    }
    stateRef.current = result.state
    return result.draft
  }

  return {
    back: (draft) => apply(stepBack, draft),
    forward: (draft) => apply(stepForward, draft),
  }
}
