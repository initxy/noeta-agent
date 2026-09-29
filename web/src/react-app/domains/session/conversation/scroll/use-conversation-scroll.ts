/**
 * The scroll controller: the machine in `scroll-machine.ts`, wired to a real
 * container.
 *
 * Three mechanisms live here and none of them is optional.
 *
 * **Gesture stamping.** A scroll event cannot tell us who caused it, so the
 * input events that *can* are stamped: wheel, touch start/move, and a pointer
 * down on the container itself (a scrollbar drag — a pointer down on a child is
 * a click on content, not a scroll). A gesture that started inside a nested
 * scrollable — a code block, a capped step run — is ignored, or scrolling a
 * tool's output would detach the whole transcript from the bottom.
 *
 * **The double-rAF release.** After we set `scrollTop` ourselves the browser
 * fires a scroll event on a later frame. Clearing the programmatic flag
 * synchronously means that event arrives with the flag already down and is read
 * as the reader scrolling away — from a scroll *we* performed. Two nested
 * `requestAnimationFrame`s outlast it.
 *
 * **Growth re-anchoring.** A `ResizeObserver` on the content follows a
 * streaming turn: growth re-anchors to the bottom only when the session is in
 * sticky mode *and* no gesture landed in the last 600 ms. The second condition
 * is what stops the observer from fighting a reader who is mid-flick.
 *
 * `overflow-anchor` is toggled to match the mode — off while we own the anchor,
 * on while the browser holds the reading position for a reader browsing back.
 */

import { useCallback, useEffect, useRef } from 'react'
import type {
  PointerEventHandler,
  RefObject,
  SyntheticEvent,
  TouchEventHandler,
  UIEventHandler,
  WheelEventHandler,
} from 'react'
import {
  decideScroll,
  gestureIsRecent,
  isExactlyAtBottom,
  modeFor,
  overflowAnchorFor,
} from './scroll-machine'
import { scrollActions, scrollStateOf, useSessionScrollState } from './scroll-store'
import type { ScrollMode } from './scroll-machine'

/** The attribute a transcript row carries so "the newest message" is findable. */
export const MESSAGE_KEY_ATTR = 'data-message-key'

/** A nested scroll area whose gestures must not detach the transcript. */
const NESTED_SCROLLABLE = '[data-scrollable]'

export interface ConversationScroll {
  containerRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  /** Spread onto the scrolling element. */
  containerProps: {
    ref: RefObject<HTMLDivElement | null>
    onScroll: UIEventHandler<HTMLDivElement>
    onWheel: WheelEventHandler<HTMLDivElement>
    onTouchStart: TouchEventHandler<HTMLDivElement>
    onTouchMove: TouchEventHandler<HTMLDivElement>
    onPointerDown: PointerEventHandler<HTMLDivElement>
  }
  mode: ScrollMode
  topClippedKey: string | null
  jumpToLatest: () => void
  /** Go to the top of the newest message — only useful while it is top-clipped. */
  jumpToTopOfLatest: () => void
  /** Declare a move as user intent, so growth does not fight it. Find uses this. */
  markGesture: () => void
}

const raf = (fn: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : Number(setTimeout(fn, 16))

const cancelRaf = (handle: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else clearTimeout(handle)
}

/**
 * The newest message, when it is taller than the viewport and its start has
 * scrolled off. Null in every other case, including "no rows carry a key" —
 * the affordance simply does not appear rather than the controller failing.
 */
function topClippedKeyOf(container: HTMLElement): string | null {
  const rows = container.querySelectorAll(`[${MESSAGE_KEY_ATTR}]`)
  const latest = rows[rows.length - 1]
  if (latest === undefined) return null
  const box = latest.getBoundingClientRect()
  const view = container.getBoundingClientRect()
  const tallerThanView = box.height > view.height + 1
  const startVisible = box.top >= view.top - 1 && box.top <= view.bottom + 1
  return tallerThanView && !startVisible ? latest.getAttribute(MESSAGE_KEY_ATTR) : null
}

export function useConversationScroll(sessionId: string | null): ConversationScroll {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const lastScrollTopRef = useRef(0)
  const gestureAtRef = useRef<number | null>(null)
  const programmaticRef = useRef(false)
  const framesRef = useRef<number[]>([])
  const observedHeightRef = useRef(0)
  const previousSessionRef = useRef<string | null>(null)

  const { mode, topClippedKey } = useSessionScrollState(sessionId)

  const clearFrames = useCallback(() => {
    for (const handle of framesRef.current) cancelRaf(handle)
    framesRef.current = []
  }, [])

  const markGesture = useCallback(() => {
    gestureAtRef.current = Date.now()
  }, [])

  const refreshTopClipped = useCallback(() => {
    const container = containerRef.current
    if (container === null || sessionId === null) return
    scrollActions().setTopClipped(sessionId, topClippedKeyOf(container))
  }, [sessionId])

  const savePosition = useCallback(() => {
    const container = containerRef.current
    if (container === null || sessionId === null) return
    const metrics = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    }
    const actions = scrollActions()
    if (modeFor(metrics) === 'sticky') actions.setSticky(sessionId)
    else actions.setManual(sessionId, metrics.scrollTop)
    actions.setTopClipped(sessionId, topClippedKeyOf(container))
  }, [sessionId])

  /**
   * Drive the container to its bottom and hold sticky through it.
   *
   * The second write inside a frame is not superstition: content that grew in
   * the same frame we scrolled leaves the first write short of the new bottom,
   * which reads as the transcript lagging one message behind a fast stream.
   */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior) => {
      const container = containerRef.current
      if (container === null) return
      if (sessionId !== null) scrollActions().setSticky(sessionId)
      programmaticRef.current = true
      clearFrames()

      const release = () => {
        framesRef.current.push(
          raf(() => {
            framesRef.current.push(
              raf(() => {
                programmaticRef.current = false
              }),
            )
          }),
        )
      }

      // `scrollTo` is guarded because a headless DOM does not implement it and
      // a transcript that throws on "jump to latest" is a worse outcome than
      // one that jumps without an animation.
      if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
        release()
        return
      }

      container.scrollTop = container.scrollHeight
      framesRef.current.push(
        raf(() => {
          const live = containerRef.current
          if (live !== null) live.scrollTop = live.scrollHeight
          refreshTopClipped()
          release()
        }),
      )
    },
    [clearFrames, refreshTopClipped, sessionId],
  )

  const onScroll = useCallback(() => {
    const container = containerRef.current
    if (container === null) return
    const scrollTop = container.scrollTop
    const delta = scrollTop - lastScrollTopRef.current
    lastScrollTopRef.current = scrollTop

    const decision = decideScroll({
      delta,
      gestured: gestureIsRecent(gestureAtRef.current, Date.now()),
      programmatic: programmaticRef.current,
      atBottom: isExactlyAtBottom({
        scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      }),
    })

    switch (decision) {
      case 'abandon-programmatic':
        programmaticRef.current = false
        clearFrames()
        savePosition()
        return
      case 'ignore':
      case 'hold':
        refreshTopClipped()
        return
      case 'rearm-sticky':
        if (sessionId !== null) scrollActions().setSticky(sessionId)
        refreshTopClipped()
        return
      case 'save':
        savePosition()
    }
  }, [clearFrames, refreshTopClipped, savePosition, sessionId])

  /** A gesture inside a nested scrollable is that element's, not the transcript's. */
  const onNestedAwareGesture = useCallback(
    (event: SyntheticEvent) => {
      const { target } = event
      const container = containerRef.current
      if (target instanceof Element && container !== null) {
        const nested = target.closest(NESTED_SCROLLABLE)
        if (nested !== null && nested !== container && container.contains(nested)) return
      }
      markGesture()
    },
    [markGesture],
  )

  const onPointerDown = useCallback(
    (event: SyntheticEvent) => {
      // Only the container itself: a pointer down on a row is a click on
      // content, while one on the container is the scrollbar.
      if (event.target === event.currentTarget) markGesture()
    },
    [markGesture],
  )

  // Follow a streaming turn. Growth re-anchors only while sticky and only when
  // the reader has not touched anything recently.
  useEffect(() => {
    const content = contentRef.current
    if (content === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const height = content.scrollHeight
      const grew = height > observedHeightRef.current + 1
      observedHeightRef.current = height
      if (
        grew &&
        scrollStateOf(sessionId).mode === 'sticky' &&
        !gestureIsRecent(gestureAtRef.current, Date.now())
      ) {
        scrollToBottom('auto')
      } else {
        refreshTopClipped()
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [refreshTopClipped, scrollToBottom, sessionId])

  // Entering a session restores its own position — never the last session's.
  useEffect(() => {
    if (previousSessionRef.current === sessionId) return
    previousSessionRef.current = sessionId
    observedHeightRef.current = 0
    lastScrollTopRef.current = 0
    gestureAtRef.current = null

    queueMicrotask(() => {
      const container = containerRef.current
      if (container === null) return
      const saved = scrollStateOf(sessionId)
      if (saved.mode === 'sticky') {
        scrollToBottom('auto')
        return
      }
      programmaticRef.current = true
      clearFrames()
      const place = () => {
        const live = containerRef.current
        if (live === null) return
        live.scrollTop = Math.min(saved.scrollTop, Math.max(0, live.scrollHeight - live.clientHeight))
        lastScrollTopRef.current = live.scrollTop
      }
      place()
      // Rows are still mounting; the height the offset was saved against does
      // not exist yet on the first pass.
      framesRef.current.push(
        raf(() => {
          place()
          refreshTopClipped()
          framesRef.current.push(
            raf(() => {
              programmaticRef.current = false
            }),
          )
        }),
      )
    })
  }, [clearFrames, refreshTopClipped, scrollToBottom, sessionId])

  useEffect(() => {
    const container = containerRef.current
    if (container !== null) container.style.overflowAnchor = overflowAnchorFor(mode)
  }, [mode])

  useEffect(() => clearFrames, [clearFrames])

  const jumpToLatest = useCallback(() => {
    markGesture()
    scrollToBottom('smooth')
  }, [markGesture, scrollToBottom])

  const jumpToTopOfLatest = useCallback(() => {
    const container = containerRef.current
    if (container === null || topClippedKey === null) return
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(topClippedKey)
        : topClippedKey
    const row = container.querySelector(`[${MESSAGE_KEY_ATTR}="${escaped}"]`)
    if (row === null || typeof row.scrollIntoView !== 'function') return
    // Save first: the jump leaves the bottom, and the mode must say so before
    // the growth observer sees the new position.
    markGesture()
    savePosition()
    row.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [markGesture, savePosition, topClippedKey])

  return {
    containerRef,
    contentRef,
    containerProps: {
      ref: containerRef,
      onScroll,
      onWheel: onNestedAwareGesture,
      onTouchStart: onNestedAwareGesture,
      onTouchMove: onNestedAwareGesture,
      onPointerDown,
    },
    mode,
    topClippedKey,
    jumpToLatest,
    jumpToTopOfLatest,
    markGesture,
  }
}
