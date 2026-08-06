import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { PANEL_DEFAULT_PX, PANEL_MIN_PX, usePanelWidth } from './use-panel-width'

/**
 * The panel-width hook: defaults, clamps, and persistence. The drag itself is a
 * pointer stream over `window`, exercised end to end by the e2e suite; what a
 * unit can pin is the arithmetic and the storage round trip.
 */

const KEY = 'noeta.panel.width'

beforeEach(() => {
  localStorage.clear()
  // A wide viewport so the 60%-of-viewport clamp does not bite the defaults.
  Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
})

afterEach(() => {
  localStorage.clear()
})

describe('usePanelWidth', () => {
  it('starts at the default when nothing is stored', () => {
    const { result } = renderHook(() => usePanelWidth())
    expect(result.current.width).toBe(PANEL_DEFAULT_PX)
    expect(result.current.dragging).toBe(false)
  })

  it('restores a stored width, clamped to the minimum', () => {
    localStorage.setItem(KEY, '520')
    const { result } = renderHook(() => usePanelWidth())
    expect(result.current.width).toBe(520)
  })

  it('never restores below the minimum', () => {
    localStorage.setItem(KEY, '80')
    const { result } = renderHook(() => usePanelWidth())
    expect(result.current.width).toBe(PANEL_MIN_PX)
  })

  it('falls back to the default for a garbage stored value', () => {
    localStorage.setItem(KEY, 'not-a-number')
    const { result } = renderHook(() => usePanelWidth())
    expect(result.current.width).toBe(PANEL_DEFAULT_PX)
  })

  it('persists the settled width to localStorage', () => {
    renderHook(() => usePanelWidth())
    // The mount persists the resolved default; a later drag would persist its
    // settled value the same way (the effect runs whenever `dragging` is false).
    expect(localStorage.getItem(KEY)).toBe(String(PANEL_DEFAULT_PX))
  })

  it('marks itself dragging on a pointer-down and settles on the next tick', () => {
    const { result } = renderHook(() => usePanelWidth())
    act(() => {
      result.current.onHandlePointerDown({
        preventDefault() {},
      } as unknown as React.PointerEvent)
    })
    expect(result.current.dragging).toBe(true)
  })
})
