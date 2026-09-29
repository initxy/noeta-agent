/**
 * The files tree column's width — a persisted layout preference and the drag
 * that sets it.
 *
 * A sibling of `use-panel-width`, not a reuse of it, because the geometry is
 * different: the panel is docked on the viewport's right edge, so its width is
 * `viewportWidth - clientX`; the tree column is docked on the *left* of the
 * files pane, so its width is `clientX - paneLeft` and depends on where the
 * pane happens to sit — which is why this hook takes the container element
 * rather than reading `window` alone. Both drags share the shape (pointer on
 * `window`, rAF-throttled, `localStorage` on release), and both refuse to let
 * either side be squeezed to nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { readStored, writeStored } from '@/react-app/kernel/route-memory'

const WIDTH_KEY = 'noeta.files.tree.width'

/** The default, and the low clamp. Below this the names are unreadable. */
export const TREE_DEFAULT_PX = 240
export const TREE_MIN_PX = 160
/** The preview beside the tree may never be squeezed below this. */
const PREVIEW_MIN_PX = 320

function clampWidth(px: number, containerWidth: number): number {
  // The tree may grow until the preview would drop below its floor, but never
  // past that and never below its own floor. A container narrower than both
  // floors combined still yields TREE_MIN_PX rather than a negative width.
  const max = Math.max(TREE_MIN_PX, containerWidth - PREVIEW_MIN_PX)
  return Math.min(max, Math.max(TREE_MIN_PX, Math.round(px)))
}

function readWidth(): number {
  const stored = Number(readStored(WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : TREE_DEFAULT_PX
}

export interface TreeWidth {
  /** The current width in pixels, for the tree column's inline `style.width`. */
  width: number
  /** Whether a drag is in flight — the handle highlights and text selection is off. */
  dragging: boolean
  /** Attach to the drag handle's `onPointerDown`. */
  onHandlePointerDown: (event: ReactPointerEvent) => void
}

export function useTreeWidth(containerRef: RefObject<HTMLElement | null>): TreeWidth {
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
      // The tree is docked on the pane's left edge, so its width is the distance
      // from that edge to the pointer. rAF-throttled so a fast drag does not
      // queue a setState per pointer sample.
      if (frame.current !== null) return
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null
        const container = containerRef.current
        if (container === null) return
        const rect = container.getBoundingClientRect()
        setWidth(clampWidth(event.clientX - rect.left, rect.width))
      })
    }
    const onUp = () => setDragging(false)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    // Disabling selection keeps the drag smooth over the tree's text.
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
  }, [dragging, containerRef])

  // Persist the settled width, not every frame of the drag.
  useEffect(() => {
    if (dragging) return
    writeStored(WIDTH_KEY, String(width))
  }, [dragging, width])

  return { width, dragging, onHandlePointerDown }
}
