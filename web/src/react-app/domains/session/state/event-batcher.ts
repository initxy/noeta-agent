/**
 * Per-animation-frame coalescing of the session event stream.
 *
 * A streaming turn delivers one `delta` frame per token. Applying each one
 * straight into the store means one store write and one transcript render per
 * token, which is the single change that measurably froze the reference
 * implementation on a fast model. The fold is a plain reduce over an array, so
 * a batch of frames costs the same as one — the whole cost was the render.
 *
 * Everything is batched, not just deltas. A frame's meaning does not depend on
 * how many other frames arrived in the same 16 ms, replay arrives as a burst of
 * hundreds, and one code path is one code path to get right.
 *
 * The batch is then **coalesced** before it is handed on: one write per frame
 * is not enough on its own, because the fold clones the preview's block map per
 * delta and a fast model sends one delta per token. `coalesceEvents` merges the
 * run into a single frame under rules that keep folding it equivalent to
 * folding the raw batch.
 *
 * **Dropping the pending batch on dispose is deliberate.** The resume cursor
 * advances only for frames the fold actually applied, so frames abandoned here
 * are re-requested by the next connect. Flushing them into a store nobody is
 * subscribed to would advance the cursor past events that never reached the
 * screen.
 */

import type { RawUIEvent } from '@/app/types'
import { coalesceEvents } from '../conversation/stream/coalesce'

export interface Scheduler {
  /** Run `fn` at the next paint. The handle is opaque to the caller. */
  schedule(fn: () => void): unknown
  cancel(handle: unknown): void
}

/**
 * The real scheduler, with a timer fallback.
 *
 * `requestAnimationFrame` does not exist in every environment this code is
 * loaded in (a headless DOM, a backgrounded tab in some browsers), and a
 * transcript that stops updating because the clock is missing is a much worse
 * failure than a coarser batch.
 */
export const frameScheduler: Scheduler = {
  schedule(fn) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn)
    return setTimeout(fn, 16)
  },
  cancel(handle) {
    if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
      cancelAnimationFrame(handle)
      return
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface EventBatcher {
  /** Queue one frame. The first call of a frame schedules the flush. */
  push(event: RawUIEvent): void
  /** Cancel a pending flush and drop whatever it held. Idempotent. */
  dispose(): void
}

export function createEventBatcher(
  flush: (events: RawUIEvent[]) => void,
  scheduler: Scheduler = frameScheduler,
): EventBatcher {
  let pending: RawUIEvent[] = []
  let handle: unknown = null
  let disposed = false

  const run = () => {
    handle = null
    if (disposed || pending.length === 0) return
    const batch = pending
    pending = []
    flush(coalesceEvents(batch))
  }

  return {
    push(event) {
      if (disposed) return
      pending.push(event)
      if (handle === null) handle = scheduler.schedule(run)
    },
    dispose() {
      if (disposed) return
      disposed = true
      pending = []
      if (handle !== null) {
        scheduler.cancel(handle)
        handle = null
      }
    },
  }
}
