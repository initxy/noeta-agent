import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDebouncedValue } from './use-debounced-value'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useDebouncedValue', () => {
  it('holds the first value until nothing has changed for the delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: '' },
    })

    rerender({ value: 'a' })
    expect(result.current).toBe('')

    act(() => vi.advanceTimersByTime(149))
    expect(result.current).toBe('')

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe('a')
  })

  it('coalesces a burst into ONE settle, on the last value', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: '' },
    })

    for (const value of ['s', 'sr', 'src', 'src/']) {
      rerender({ value })
      act(() => vi.advanceTimersByTime(40))
    }
    // 160 ms of typing, and nothing has settled: every keystroke re-armed.
    expect(result.current).toBe('')

    act(() => vi.advanceTimersByTime(150))
    expect(result.current).toBe('src/')
  })

  it('stops after settling instead of scheduling itself forever', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 150), {
      initialProps: { value: '' },
    })
    rerender({ value: 'done' })
    act(() => vi.advanceTimersByTime(150))
    expect(result.current).toBe('done')

    expect(vi.getTimerCount()).toBe(0)
  })
})
