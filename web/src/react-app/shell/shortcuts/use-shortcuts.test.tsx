import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { PlatformContext } from '@/react-app/kernel/platform'
import { useGlobalShortcuts, type ShortcutHandlers } from './use-shortcuts'

/**
 * The global listener. The table's matching is pinned next door; what is
 * pinned here is that one listener is installed, that it is removed, that it
 * does not swallow a key nobody claimed, and that it sees the current
 * handlers rather than the ones from the render it was installed on.
 */

function Harness({ handlers }: { handlers: ShortcutHandlers }) {
  useGlobalShortcuts(handlers)
  return null
}

function renderHarness(handlers: ShortcutHandlers, isMac = false) {
  return render(
    <PlatformContext.Provider value={{ isMac, modKeyLabel: isMac ? '⌘' : 'Ctrl' }}>
      <Harness handlers={handlers} />
    </PlatformContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('useGlobalShortcuts', () => {
  it('runs the handler for a bound keystroke and consumes it', () => {
    const toggle = vi.fn()
    renderHarness({ 'palette.toggle': toggle })

    const consumed = !fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(consumed).toBe(true)
  })

  it('leaves an unclaimed binding to the browser', () => {
    renderHarness({})
    // `shortcuts.help` is in the table but has no handler here. Swallowing it
    // anyway would break the browser's own behaviour for a feature that is
    // not mounted.
    const consumed = !fireEvent.keyDown(window, { key: '/', ctrlKey: true })
    expect(consumed).toBe(false)
  })

  it('stops listening once unmounted', () => {
    const toggle = vi.fn()
    const view = renderHarness({ 'palette.toggle': toggle })
    view.unmount()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()
  })

  it('calls the handler from the latest render, not the first', () => {
    const first = vi.fn()
    const second = vi.fn()
    const view = renderHarness({ 'palette.toggle': first })
    view.rerender(
      <PlatformContext.Provider value={{ isMac: false, modKeyLabel: 'Ctrl' }}>
        <Harness handlers={{ 'palette.toggle': second }} />
      </PlatformContext.Provider>,
    )

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('follows the platform modifier', () => {
    const toggle = vi.fn()
    renderHarness({ 'palette.toggle': toggle }, true)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(toggle).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
