import { describe, expect, it, vi } from 'vitest'
import type { RawUIEvent } from '@/app/types'
import { createEventBatcher } from './event-batcher'
import type { Scheduler } from './event-batcher'

/**
 * The batcher is the whole reason a streaming turn does not melt the
 * transcript, so what is pinned here is exactly that: one flush per frame,
 * whatever the arrival rate, and nothing flushed after dispose.
 */

function manualScheduler() {
  let queued: (() => void)[] = []
  const scheduler: Scheduler = {
    schedule(fn) {
      queued.push(fn)
      return queued.length
    },
    cancel() {
      queued = []
    },
  }
  return {
    scheduler,
    get pending() {
      return queued.length
    },
    tick() {
      const due = queued
      queued = []
      for (const fn of due) fn()
    },
  }
}

const delta = (index: number): RawUIEvent => ({
  seq: null,
  type: 'delta',
  data: { call_id: 'c1', kind: 'text', text: `t${index}`, index: 0 },
})

describe('the per-frame event batcher', () => {
  it('flushes a burst exactly once, in arrival order', () => {
    const flush = vi.fn()
    const clock = manualScheduler()
    const batcher = createEventBatcher(flush, clock.scheduler)

    for (let i = 0; i < 20; i += 1) batcher.push(delta(i))

    // Nothing has been applied yet: 20 frames, still one scheduled flush.
    expect(flush).not.toHaveBeenCalled()
    expect(clock.pending).toBe(1)

    clock.tick()

    // One flush, and — because all 20 deltas are the same block of the same
    // call — one frame carrying the concatenation. `coalesce.test.ts` owns why
    // that is equivalent to folding them one by one.
    expect(flush).toHaveBeenCalledTimes(1)
    const batch = flush.mock.calls[0][0] as RawUIEvent[]
    expect(batch).toHaveLength(1)
    expect(batch[0].data.text).toBe(
      Array.from({ length: 20 }, (_, i) => `t${i}`).join(''),
    )
  })

  it('keeps unrelated frames in arrival order', () => {
    const flush = vi.fn()
    const clock = manualScheduler()
    const batcher = createEventBatcher(flush, clock.scheduler)

    batcher.push(delta(1))
    batcher.push({ seq: 3, type: 'assistant_text', data: { text: 'done' } })
    batcher.push(delta(2))
    clock.tick()

    const batch = flush.mock.calls[0][0] as RawUIEvent[]
    expect(batch.map((event) => event.type)).toEqual(['delta', 'assistant_text', 'delta'])
  })

  it('schedules again for the next frame', () => {
    const flush = vi.fn()
    const clock = manualScheduler()
    const batcher = createEventBatcher(flush, clock.scheduler)

    batcher.push(delta(1))
    clock.tick()
    batcher.push(delta(2))
    clock.tick()

    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('does not schedule a flush for an empty frame', () => {
    const flush = vi.fn()
    const clock = manualScheduler()
    createEventBatcher(flush, clock.scheduler)

    clock.tick()

    expect(flush).not.toHaveBeenCalled()
  })

  it('drops the pending batch on dispose rather than flushing it', () => {
    // The cursor advances only for frames the fold applied, so an abandoned
    // batch must stay unapplied: the next connect replays it.
    const flush = vi.fn()
    const clock = manualScheduler()
    const batcher = createEventBatcher(flush, clock.scheduler)

    batcher.push(delta(1))
    batcher.dispose()
    clock.tick()

    expect(flush).not.toHaveBeenCalled()
  })

  it('ignores pushes after dispose', () => {
    const flush = vi.fn()
    const clock = manualScheduler()
    const batcher = createEventBatcher(flush, clock.scheduler)

    batcher.dispose()
    batcher.push(delta(1))
    clock.tick()

    expect(flush).not.toHaveBeenCalled()
  })
})
