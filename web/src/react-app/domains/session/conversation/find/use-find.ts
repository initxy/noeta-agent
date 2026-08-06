/**
 * The find controller: keystrokes in, marked DOM and an active match out.
 *
 * Three timers, and each one is a different problem:
 *
 * - `QUERY_DEBOUNCE_MS` — typing. Re-walking the transcript per character is
 *   the difference between a responsive input and one that stutters on a long
 *   conversation.
 * - `COLLECT_DELAY_MS` — the gap between asking React to render with a new
 *   query and the marks actually existing in the DOM. Collecting immediately
 *   finds the *previous* query's marks.
 * - `MUTATION_DEBOUNCE_MS` — a streaming turn mutates the transcript
 *   constantly. Re-collecting per mutation record would run the walker at
 *   frame rate.
 *
 * A re-collect caused by a mutation **never scrolls**. The reader is reading;
 * yanking the viewport because a tool row appeared elsewhere is the single
 * worst thing this feature can do. Only a query change or an explicit
 * next/previous moves the page.
 *
 * The active match is held as an **element**, not an index, for the reason
 * `matches.ts` states: the list is rebuilt under it.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import {
  MIN_QUERY_LENGTH,
  applyHighlights,
  clearHighlights,
  collectMarks,
  refreshHighlights,
  revealMatch,
  setMarkActive,
} from './highlight'
import { retainedIndex, stepIndex } from './matches'
import { findActions, useFindStore } from './find-store'

const QUERY_DEBOUNCE_MS = 150
const COLLECT_DELAY_MS = 50
const MUTATION_DEBOUNCE_MS = 100

export interface FindController {
  open: boolean
  query: string
  matchCount: number
  activeIndex: number
  focusNonce: number
  setQuery: (query: string) => void
  next: () => void
  previous: () => void
  close: () => void
}

/** Whether the ⌘F / Ctrl+F chord fired, with no modifier that means something else. */
function isFindChord(event: KeyboardEvent): boolean {
  if (event.key !== 'f' && event.key !== 'F') return false
  if (event.shiftKey || event.altKey) return false
  return event.metaKey || event.ctrlKey
}

export function useFind(
  sessionId: string | null,
  containerRef: RefObject<HTMLElement | null>,
  /** Told before any jump, so the scroll controller reads it as user intent. */
  onBeforeJump?: () => void,
): FindController {
  const open = useFindStore((state) => state.open && state.sessionId === sessionId)
  const query = useFindStore((state) => state.query)
  const appliedQuery = useFindStore((state) => state.appliedQuery)
  const matchCount = useFindStore((state) => state.matchCount)
  const activeIndex = useFindStore((state) => state.activeIndex)
  const focusNonce = useFindStore((state) => state.focusNonce)

  const matchesRef = useRef<HTMLElement[]>([])
  const activeRef = useRef<HTMLElement | null>(null)
  const indexRef = useRef(-1)
  // Held in a ref, not a dependency: callers pass an inline closure, and a new
  // identity per render would restart the collect debounce forever — the
  // marks would be applied and never collected.
  const beforeJumpRef = useRef(onBeforeJump)
  beforeJumpRef.current = onBeforeJump

  const activate = useCallback(
    (index: number, scroll: boolean) => {
      const previous = activeRef.current
      if (previous !== null) setMarkActive(previous, false)
      const element = matchesRef.current[index] ?? null
      activeRef.current = element
      indexRef.current = element === null ? -1 : index
      findActions().setMatches(matchesRef.current.length, indexRef.current)
      if (element === null) return
      setMarkActive(element, true)
      if (!scroll) return
      revealMatch(element)
      beforeJumpRef.current?.()
      // Instant, not smooth: a smooth jump between two matches a page apart is
      // a second of scenery on every press of Enter.
      if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' })
    },
    [],
  )

  /**
   * Rebuild the match list.
   *
   * `reason` decides one thing only: whether the viewport is allowed to move.
   */
  const collect = useCallback(
    (reason: 'query' | 'mutation') => {
      const container = containerRef.current
      if (container === null) return
      const next = collectMarks(container)
      // Retention is computed before the list is swapped in, because it is the
      // *old* active element that has to be located in the *new* list.
      const index =
        reason === 'query' ? 0 : retainedIndex(next, activeRef.current, indexRef.current)
      matchesRef.current = next
      // A new query starts from the first match and moves the page there; a
      // mutation keeps the reader where they are and never scrolls.
      activate(index, reason === 'query')
    },
    [activate, containerRef],
  )

  // Typing: query -> appliedQuery.
  useEffect(() => {
    if (!open) return
    const handle = setTimeout(() => findActions().applyQuery(query), QUERY_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [open, query])

  // appliedQuery -> marks in the DOM -> a match list.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    if (!open) {
      clearHighlights(container)
      matchesRef.current = []
      activeRef.current = null
      indexRef.current = -1
      return
    }
    applyHighlights(container, appliedQuery)
    if (appliedQuery.trim().length < MIN_QUERY_LENGTH) {
      matchesRef.current = []
      activeRef.current = null
      indexRef.current = -1
      findActions().setMatches(0, -1)
      return
    }
    const handle = setTimeout(() => collect('query'), COLLECT_DELAY_MS)
    return () => clearTimeout(handle)
  }, [appliedQuery, collect, containerRef, open])

  // The transcript moving under an open search.
  useEffect(() => {
    const container = containerRef.current
    if (container === null || !open) return
    if (appliedQuery.trim().length < MIN_QUERY_LENGTH) return
    if (typeof MutationObserver === 'undefined') return
    let handle: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (handle !== null) clearTimeout(handle)
      handle = setTimeout(() => {
        const live = containerRef.current
        if (live === null) return
        // Mark what arrived, incrementally — a full re-mark would destroy the
        // element the active match is held by, which is the whole reason it is
        // held by an element.
        observer.disconnect()
        refreshHighlights(live, appliedQuery)
        collect('mutation')
        observer.observe(live, { childList: true, subtree: true, characterData: true })
      }, MUTATION_DEBOUNCE_MS)
    })
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    return () => {
      if (handle !== null) clearTimeout(handle)
      observer.disconnect()
    }
  }, [appliedQuery, collect, containerRef, open])

  // ⌘F opens the bar on this surface.
  useEffect(() => {
    if (sessionId === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isFindChord(event)) return
      event.preventDefault()
      findActions().openFind(sessionId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sessionId])

  // A surface that goes away takes its find bar with it.
  useEffect(() => {
    if (sessionId === null) return
    return () => findActions().releaseOwner(sessionId)
  }, [sessionId])

  const step = useCallback(
    (direction: 1 | -1) => {
      const total = matchesRef.current.length
      if (total === 0) return
      activate(stepIndex(indexRef.current, total, direction), true)
    },
    [activate],
  )

  return {
    open,
    query,
    matchCount,
    activeIndex,
    focusNonce,
    setQuery: (value) => findActions().setQuery(value),
    next: () => step(1),
    previous: () => step(-1),
    close: () => findActions().closeFind(),
  }
}
