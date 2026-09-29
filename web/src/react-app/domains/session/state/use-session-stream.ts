/**
 * The React binding for one session's event stream.
 *
 * Everything hard about SSE — the hand-rolled parser, the backoff ladder, the
 * abort on switch, treating a clean stream end as a reconnect trigger — already
 * lives in `app/sse` and is pure. This hook's whole job is the three things
 * only React can get wrong:
 *
 * 1. **The resume cursor is a ref, never state.** `openSessionStream` reads it
 *    through a callback at *connect* time. A cursor captured in the effect
 *    closure is frozen at the value it had when the connection opened, so every
 *    reconnect re-requests the session from that point — the whole conversation
 *    replays, forever, and it reads like a backend bug.
 * 2. **Frames are coalesced per animation frame.** One store write per token is
 *    what froze the reference implementation.
 * 3. **The cursor advances only for frames the fold applied.** It is read back
 *    out of the fold's own `lastSeq` after each batch, rather than tracked
 *    alongside it, so "received" and "applied" cannot drift.
 */

import { useEffect, useRef } from 'react'
import { openSessionStream } from '@/app/sse'
import type { SessionStream, SessionStreamOptions } from '@/app/sse'
import { createEventBatcher, frameScheduler } from './event-batcher'
import type { Scheduler } from './event-batcher'
import { useConversationStore } from './conversation-store'

/** Nothing seen yet — asks the backend for a full replay. */
const NO_CURSOR = -1

export type StreamOpener = (options: SessionStreamOptions) => SessionStream

export interface SessionStreamDeps {
  /** Injected in tests; the default is the real reconnecting reader. */
  open?: StreamOpener
  /** Injected in tests; the default batches per animation frame. */
  scheduler?: Scheduler
}

/**
 * Keep one session's conversation fed for as long as it is mounted.
 *
 * `null` is a first-class argument: the "project open, nothing selected"
 * surface has no stream, and making that a no-op here keeps the caller free of
 * a conditional hook.
 */
export function useSessionStream(sessionId: string | null, deps: SessionStreamDeps = {}): void {
  const { open = openSessionStream, scheduler = frameScheduler } = deps
  const cursorRef = useRef(NO_CURSOR)

  useEffect(() => {
    if (sessionId === null) return

    const store = useConversationStore
    store.getState().ensure(sessionId)
    // Resume where this session left off. Re-entering a session the user
    // already visited replays the gap, not the conversation.
    cursorRef.current = store.getState().runtimes[sessionId]?.conversation.lastSeq ?? NO_CURSOR

    const batcher = createEventBatcher((events) => {
      const actions = store.getState()
      actions.apply(sessionId, events)
      cursorRef.current = store.getState().runtimes[sessionId]?.conversation.lastSeq ?? NO_CURSOR
    }, scheduler)

    store.getState().setConnection(sessionId, 'connecting')

    const stream = open({
      sessionId,
      lastSeq: () => cursorRef.current,
      onEvent: batcher.push,
      onOpen: () => store.getState().setConnection(sessionId, 'live'),
      // A clean close is a reconnect too — `openSessionStream` has already
      // scheduled the retry by the time this runs.
      onClose: () => store.getState().setConnection(sessionId, 'retrying'),
    })

    return () => {
      stream.close()
      batcher.dispose()
      store.getState().setConnection(sessionId, 'offline')
    }
  }, [sessionId, open, scheduler])
}
