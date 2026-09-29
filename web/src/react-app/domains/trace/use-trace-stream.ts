/**
 * Polling the raw-events endpoint, and holding what it has returned so far.
 *
 * The whole cursor contract lives in `trace-stream.ts`, which is pure. This is
 * the thin part around it: a timer, an abort controller, and one rule that is
 * easy to get wrong —
 *
 * **the cursor is read at request time, never captured when the effect ran.**
 * A closure that captured the cursor would ask for the same increment forever
 * and the page would stop advancing after its first page; the same trap the SSE
 * reconnect has with `lastSeq`. `stateRef` exists for exactly that, and is the
 * reason the accumulated state is mirrored into a ref at all.
 *
 * The loop **stops on failure** rather than retrying on the poll interval. This
 * page is opened against a session that may be finished, deleted, or served by
 * a backend that is not up; a silent retry loop against a 404 is indistinguish-
 * able from a page that is working, which on a debug surface is the worst
 * possible failure mode.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRawEvents } from '@/app/api'
import { applyRawEventsPage, initialTraceStreamState } from './trace-stream'
import type { TraceStreamState } from './trace-stream'

/** How often a live page asks for the next increment. */
export const TRACE_POLL_MS = 2000

export type TraceStatus = 'loading' | 'ready' | 'error'

export interface TraceStreamHandle {
  state: TraceStreamState
  status: TraceStatus
  /** Human text of the failure that stopped the loop; `null` while it runs. */
  error: string | null
  /** Whether the page keeps asking for increments. */
  live: boolean
  setLive: (live: boolean) => void
  /** Ask again now — after a failure, or while paused. */
  refresh: () => void
}

export function useTraceStream(sessionId: string): TraceStreamHandle {
  const [state, setState] = useState<TraceStreamState>(initialTraceStreamState)
  const [status, setStatus] = useState<TraceStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const stateRef = useRef<TraceStreamState>(initialTraceStreamState)

  // Declared before the fetch effect so that a session change has already reset
  // the accumulator by the time the fetch effect re-runs and reads the ref.
  // Without this, opening a second trace URL in the same tab would send the
  // first session's cursor and merge two sessions into one list.
  useEffect(() => {
    stateRef.current = initialTraceStreamState
    setState(initialTraceStreamState)
    setStatus('loading')
    setError(null)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const tick = async () => {
      try {
        const payload = await fetchRawEvents(sessionId, stateRef.current.cursor, controller.signal)
        if (stopped) return
        const next = applyRawEventsPage(stateRef.current, payload)
        // Same reference means the page carried nothing new; skipping the
        // setState keeps a live page from re-rendering every two seconds for
        // the whole time a session sits idle.
        if (next !== stateRef.current) {
          stateRef.current = next
          setState(next)
        }
        setStatus('ready')
        setError(null)
      } catch (failure) {
        if (stopped || controller.signal.aborted) return
        setStatus('error')
        setError(failure instanceof Error ? failure.message : String(failure))
        return
      }
      if (!stopped && live) timer = setTimeout(() => void tick(), TRACE_POLL_MS)
    }

    void tick()

    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, live, attempt])

  const refresh = useCallback(() => {
    setStatus((current) => (current === 'error' ? 'loading' : current))
    setError(null)
    setAttempt((current) => current + 1)
  }, [])

  return { state, status, error, live, setLive, refresh }
}
