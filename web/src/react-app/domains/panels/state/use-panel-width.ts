/**
 * The right panel's width — a persisted layout preference and the drag that
 * sets it.
 *
 * Width is a property of the workspace, not of a conversation, so it lives here
 * (global, `localStorage`) rather than in the per-session, deliberately
 * unpersisted panel-tab store: a reader who widened the panel wants it wide for
 * the next session too, and for the next boot.
 *
 * The drag is pointer events on `window`, not a scroll listener — a panel edge
 * the reader grabs, tracked until they let go, clamped so neither the panel nor
 * the conversation beside it can be squeezed to nothing. Persistence reuses the
 * route-memory storage helpers, so a browser that refuses `localStorage`
 * degrades to the default width rather than throwing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { readStored, writeStored } from '@/react-app/kernel/route-memory'

const WIDTH_KEY = 'noeta.panel.width'

/** The default, and the clamp. Neither pane may be squeezed below a readable width. */
export const PANEL_DEFAULT_PX = 448
export const PANEL_MIN_PX = 320
/** The panel may not take more than this fraction of the viewport. */
const PANEL_MAX_VIEWPORT_FRACTION = 0.6

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth
}

function clampWidth(px: number): number {
  const max = Math.max(PANEL_MIN_PX, Math.round(viewportWidth() * PANEL_MAX_VIEWPORT_FRACTION))
  return Math.min(max, Math.max(PANEL_MIN_PX, Math.round(px)))
}

function readWidth(): number {
  const stored = Number(readStored(WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : PANEL_DEFAULT_PX
}

export interface PanelWidth {
  /** The current width in pixels, for the panel's inline `style.width`. */
  width: number
  /** Whether a drag is in flight — the handle highlights and text selection is off. */
  dragging: boolean
  /** Attach to the drag handle's `onPointerDown`. */
  onHandlePointerDown: (event: ReactPointerEvent) => void
}

export function usePanelWidth(): PanelWidth {
  const [width, setWidth] = useState(readWidth)
  const [dragging, setDragging] = useState(false)
  const frame = useRef<number | null>(null)

  const onHandlePointerDown = useCallback((event: ReactPointerEvent) => {
    event.preventDefault()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      // The panel is docked on the right, so its width is the distance from the
      // pointer to the viewport's right edge. rAF-throttled so a fast drag does
      // not queue a setState per pointer sample.
      if (frame.current !== null) return
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null
        setWidth(clampWidth(viewportWidth() - event.clientX))
      })
    }
    const onUp = () => setDragging(false)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // A drag over an iframe (the preview/terminal tabs) would otherwise eat the
    // pointer; disabling selection keeps the drag smooth over text too.
    const previousSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = previousSelect
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
  }, [dragging])

  // Persist the settled width, not every frame of the drag.
  useEffect(() => {
    if (dragging) return
    writeStored(WIDTH_KEY, String(width))
  }, [dragging, width])

  return { width, dragging, onHandlePointerDown }
}
