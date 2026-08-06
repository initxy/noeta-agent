/**
 * The reconnect machine for one session's stream.
 *
 * Framework-agnostic on purpose: the React layer owns *when* a connection
 * exists (an effect keyed on the route) but not *how* it recovers, and the
 * recovery rules below are the ones that were expensive to get wrong.
 *
 * Two of them are worth stating before the code:
 *
 * - **The cursor is read at reconnect time, never captured.** `lastSeq` is a
 *   function, not a number, so a caller can hold the value in a React ref. A
 *   closure that captured the seq at effect time re-requests the session from
 *   wherever it was when the connection opened — which replays the entire
 *   conversation on every reconnect, forever, and looks like a backend bug.
 * - **A normal stream end is a reconnect trigger.** The backend closes the
 *   stream on disconnect detection and on shutdown, so "the promise resolved"
 *   means the connection is gone, not that the work is done.
 */

import { readSseStream } from './stream'
import type { ReadSseOptions } from './stream'
import { sessionEventsUrl } from '../api/sessions'
import type { RawUIEvent } from '../types/ui-events'

/** The ceiling of the backoff ladder: 1s, 2s, 4s, 8s, 8s, … */
export const SSE_MAX_BACKOFF_MS = 8000

/**
 * Delay before retry number `attempt` (1-based).
 *
 * Exported separately from the machine because it is the part with an exact
 * expected sequence, and a test that has to drive a whole connection to check
 * a multiplication is a test nobody keeps.
 */
export function sseRetryDelay(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(1000 * 2 ** Math.min(n - 1, 3), SSE_MAX_BACKOFF_MS)
}

export interface SessionStreamOptions {
  sessionId: string
  /**
   * The resume cursor, read fresh on every (re)connect. Return `-1` — or
   * anything below zero — for "nothing seen yet", which asks for a full replay.
   */
  lastSeq: () => number
  onEvent: (event: RawUIEvent) => void
  /** The connection is live. Called on every successful connect, not only the first. */
  onOpen?: () => void
  /** The connection dropped. `error` is null when the server simply closed it. */
  onClose?: (error: Error | null) => void
  /** Injected in tests. */
  read?: (url: string, options: ReadSseOptions) => Promise<void>
  /** Injected in tests. */
  schedule?: (fn: () => void, delayMs: number) => unknown
  /** Injected in tests; must pair with `schedule`. */
  unschedule?: (handle: unknown) => void
}

export interface SessionStream {
  /** Abort the connection and cancel any pending retry. Idempotent. */
  close(): void
  /** Consecutive failed attempts; reset to 0 whenever a connection opens. */
  readonly attempt: number
  /** True once `close()` has been called. */
  readonly closed: boolean
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Open a session stream that keeps itself alive.
 *
 * One `AbortController` per attempt: aborting the old one is what makes a
 * session switch instant instead of leaving the previous conversation's frames
 * arriving into a component that no longer wants them.
 */
export function openSessionStream(options: SessionStreamOptions): SessionStream {
  const {
    sessionId,
    lastSeq,
    onEvent,
    onOpen,
    onClose,
    read = readSseStream,
    schedule = (fn, delayMs) => setTimeout(fn, delayMs),
    unschedule = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options

  let closed = false
  let attempt = 0
  let controller: AbortController | null = null
  let timer: unknown = null

  const scheduleRetry = () => {
    if (closed) return
    attempt += 1
    timer = schedule(connect, sseRetryDelay(attempt))
  }

  function connect(): void {
    if (closed) return
    timer = null
    controller = new AbortController()
    const signal = controller.signal
    // Read the cursor here, at connect time. This single line is the
    // difference between resuming and replaying the whole session.
    const url = sessionEventsUrl(sessionId, lastSeq())

    read(url, {
      signal,
      onEvent: (event) => {
        if (!signal.aborted) onEvent(event)
      },
      onOpen: () => {
        if (signal.aborted) return
        attempt = 0
        onOpen?.()
      },
    }).then(
      () => {
        if (closed || signal.aborted) return
        onClose?.(null)
        scheduleRetry()
      },
      (error: unknown) => {
        if (closed || signal.aborted || isAbort(error)) return
        onClose?.(error instanceof Error ? error : new Error(String(error)))
        scheduleRetry()
      },
    )
  }

  connect()

  return {
    close() {
      if (closed) return
      closed = true
      controller?.abort()
      controller = null
      if (timer !== null) {
        unschedule(timer)
        timer = null
      }
    },
    get attempt() {
      return attempt
    },
    get closed() {
      return closed
    },
  }
}
