import { describe, expect, it } from 'vitest'
import {
  GESTURE_WINDOW_MS,
  MANUAL_UPWARD_THRESHOLD_PX,
  decideScroll,
  gestureIsRecent,
  isExactlyAtBottom,
  modeFor,
  overflowAnchorFor,
} from './scroll-machine'

/**
 * Every constant in the machine is a scar, so each is pinned at its boundary
 * rather than somewhere comfortably inside it — a threshold nobody tests at the
 * edge is a threshold that quietly becomes a different number.
 */

const signals = (over: Partial<Parameters<typeof decideScroll>[0]> = {}) =>
  decideScroll({ delta: 0, gestured: false, programmatic: false, atBottom: false, ...over })

describe('the scroll decision', () => {
  it('lets a gesture escape a scroll we are driving', () => {
    // This is the branch that lets the reader leave the tail while streaming
    // content is still re-anchoring underneath them.
    expect(signals({ programmatic: true, gestured: true })).toBe('abandon-programmatic')
  })

  it('lets a large upward move escape a scroll we are driving', () => {
    expect(signals({ programmatic: true, delta: -MANUAL_UPWARD_THRESHOLD_PX })).toBe(
      'abandon-programmatic',
    )
  })

  it('ignores its own uncontested scroll', () => {
    expect(signals({ programmatic: true, delta: 400 })).toBe('ignore')
    expect(signals({ programmatic: true, delta: -15 })).toBe('ignore')
  })

  it('treats an upward move under 16px as anchoring jitter', () => {
    // 15px up with no gesture is layout settling, not a reader leaving.
    expect(signals({ delta: -15, atBottom: true })).toBe('rearm-sticky')
    expect(signals({ delta: -15, atBottom: false })).toBe('hold')
  })

  it('treats 16px up as intent', () => {
    expect(signals({ delta: -MANUAL_UPWARD_THRESHOLD_PX })).toBe('save')
  })

  it('saves any movement made during a gesture, including downward', () => {
    expect(signals({ gestured: true, delta: 200 })).toBe('save')
  })

  it('re-arms sticky when settling leaves the container exactly at the bottom', () => {
    expect(signals({ atBottom: true })).toBe('rearm-sticky')
  })
})

describe('the gesture window', () => {
  it('counts a gesture as recent for 600ms and not a millisecond longer', () => {
    expect(gestureIsRecent(1000, 1000 + GESTURE_WINDOW_MS - 1)).toBe(true)
    expect(gestureIsRecent(1000, 1000 + GESTURE_WINDOW_MS)).toBe(false)
  })

  it('reads "no gesture yet" as not recent', () => {
    expect(gestureIsRecent(null, 5)).toBe(false)
  })
})

describe('bottom detection', () => {
  it('allows one pixel and no more', () => {
    expect(isExactlyAtBottom({ scrollTop: 199, scrollHeight: 300, clientHeight: 100 })).toBe(true)
    expect(isExactlyAtBottom({ scrollTop: 198, scrollHeight: 300, clientHeight: 100 })).toBe(false)
  })

  it('decides the saved mode from geometry alone', () => {
    expect(modeFor({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 })).toBe('sticky')
    expect(modeFor({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 })).toBe('manual')
  })
})

describe('overflow-anchor', () => {
  it('is off while we own the anchor and on while the browser does', () => {
    expect(overflowAnchorFor('sticky')).toBe('none')
    expect(overflowAnchorFor('manual')).toBe('auto')
  })
})
