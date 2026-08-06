import { describe, expect, it } from 'vitest'
import { SSE_MAX_BACKOFF_MS, openSessionStream, sseRetryDelay } from './reconnect'
import type { ReadSseOptions } from './stream'

/** Let queued microtasks (the reader promise's handlers) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A harness that hands back control of both halves the machine depends on:
 * the reader promise and the retry timer. Nothing here is asynchronous by
 * accident — every step is driven explicitly, so a failing test names the
 * transition that broke.
 */
function harness(lastSeq: () => number) {
  const urls: string[] = []
  const delays: number[] = []
  const pending: { settle: (error?: unknown) => void; options: ReadSseOptions }[] = []
  let timer: (() => void) | null = null

  const stream = openSessionStream({
    sessionId: 's1',
    lastSeq,
    onEvent: () => {},
    read: (url, options) => {
      urls.push(url)
      return new Promise<void>((resolve, reject) => {
        pending.push({
          settle: (error?: unknown) => (error === undefined ? resolve() : reject(error)),
          options,
        })
      })
    },
    schedule: (fn, delayMs) => {
      delays.push(delayMs)
      timer = fn
      return delays.length
    },
    unschedule: () => {
      timer = null
    },
  })

  return {
    stream,
    urls,
    delays,
    open: () => pending[pending.length - 1].options.onOpen?.(),
    /** End the live connection: `undefined` is a normal close, anything else an error. */
    end: async (error?: unknown) => {
      pending[pending.length - 1].settle(error)
      await flush()
    },
    runTimer: async () => {
      const fn = timer
      timer = null
      fn?.()
      await flush()
    },
    hasTimer: () => timer !== null,
  }
}

describe('sseRetryDelay', () => {
  it('doubles to a ceiling of 8s and stays there', () => {
    expect([1, 2, 3, 4, 5, 6].map(sseRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000])
    expect(sseRetryDelay(100)).toBe(SSE_MAX_BACKOFF_MS)
  })

  it('clamps a zero or negative attempt to the first step', () => {
    expect(sseRetryDelay(0)).toBe(1000)
    expect(sseRetryDelay(-3)).toBe(1000)
  })
})

describe('openSessionStream', () => {
  it('omits since_seq for a cursor of -1 so the first envelope is replayed', () => {
    const h = harness(() => -1)
    expect(h.urls[0]).toBe('/api/v1/sessions/s1/events')
    h.stream.close()
  })

  it('reads the cursor at reconnect time, not when the stream was opened', async () => {
    // The defect this pins: capturing the seq in the reconnect closure replays
    // the entire session on every reconnect, forever, and reads as a backend bug.
    let cursor = -1
    const h = harness(() => cursor)
    h.open()

    cursor = 12
    await h.end()
    await h.runTimer()

    expect(h.urls).toEqual([
      '/api/v1/sessions/s1/events',
      '/api/v1/sessions/s1/events?since_seq=12',
    ])
    h.stream.close()
  })

  it('treats a normal stream end as a reconnect trigger', async () => {
    const h = harness(() => 3)
    h.open()

    await h.end()

    expect(h.delays).toEqual([1000])
    h.stream.close()
  })

  it('backs off across consecutive failures and resets once a connection opens', async () => {
    const h = harness(() => 3)

    await h.end(new Error('refused'))
    await h.runTimer()
    await h.end(new Error('refused'))
    await h.runTimer()
    await h.end(new Error('refused'))
    expect(h.delays).toEqual([1000, 2000, 4000])

    await h.runTimer()
    h.open()
    expect(h.stream.attempt).toBe(0)

    await h.end()
    expect(h.delays).toEqual([1000, 2000, 4000, 1000])
    h.stream.close()
  })

  it('reads the cursor fresh on every attempt', async () => {
    // The cursor is a function read at connect time, not a captured value: a
    // reconnect resumes from where the client actually is, not from where it
    // was when the stream first opened.
    let cursor = -1
    const h = harness(() => cursor)
    cursor = 7
    await h.end()
    await h.runTimer()
    expect(h.urls).toEqual([
      '/api/v1/sessions/s1/events',
      '/api/v1/sessions/s1/events?since_seq=7',
    ])
    h.stream.close()
  })

  it('stops reconnecting once closed, whatever the connection does afterwards', async () => {
    const h = harness(() => 3)
    h.open()
    h.stream.close()

    await h.end()
    expect(h.hasTimer()).toBe(false)
    expect(h.delays).toEqual([])
    expect(h.stream.closed).toBe(true)

    // A pending retry is cancelled too, not merely ignored on arrival.
    const other = harness(() => 3)
    await other.end()
    expect(other.hasTimer()).toBe(true)
    other.stream.close()
    expect(other.hasTimer()).toBe(false)
  })
})
