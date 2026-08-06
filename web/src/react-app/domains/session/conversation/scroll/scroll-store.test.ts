import { beforeEach, describe, expect, it } from 'vitest'
import { scrollActions, scrollStateOf, useScrollStore } from './scroll-store'

beforeEach(() => {
  useScrollStore.setState({ sessions: {} })
})

describe('the per-session scroll store', () => {
  it('starts every session at the bottom', () => {
    expect(scrollStateOf('s1')).toEqual({ mode: 'sticky', scrollTop: 0, topClippedKey: null })
  })

  it('keeps sessions apart', () => {
    // Switching conversations must not inherit the last one's mode; that reads
    // as the app losing its place at random.
    scrollActions().setManual('s1', 420)

    expect(scrollStateOf('s1').mode).toBe('manual')
    expect(scrollStateOf('s2').mode).toBe('sticky')
  })

  it('clamps and rounds a saved offset', () => {
    // A negative offset is what an overscroll bounce reports, and restoring it
    // later scrolls to a position that does not exist.
    scrollActions().setManual('s1', -12.4)
    expect(scrollStateOf('s1').scrollTop).toBe(0)

    scrollActions().setManual('s1', 99.6)
    expect(scrollStateOf('s1').scrollTop).toBe(100)
  })

  it('returns the same state object when nothing changed', () => {
    // A scroll handler fires dozens of times per gesture and almost all of
    // those decide nothing.
    scrollActions().setManual('s1', 100)
    const before = useScrollStore.getState()
    scrollActions().setManual('s1', 100)

    expect(useScrollStore.getState()).toBe(before)
  })

  it('drops the offset when it goes back to sticky', () => {
    scrollActions().setManual('s1', 100)
    scrollActions().setSticky('s1')

    expect(scrollStateOf('s1')).toMatchObject({ mode: 'sticky', scrollTop: 0 })
  })

  it('forgets a session on request and never resurrects it', () => {
    scrollActions().setManual('s1', 100)
    scrollActions().forget('s1')

    expect(scrollStateOf('s1').mode).toBe('sticky')
  })
})
