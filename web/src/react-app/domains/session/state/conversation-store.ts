/**
 * Live conversation state, per session.
 *
 * The fold itself lives in `app/fold` and is pure; this is the store that holds
 * its output and the two pieces of interaction state that sit beside it — the
 * connection phase and the optimistic "sending" flag. Nothing here re-derives
 * anything: every transition is `foldEvents(previous, batch)`.
 *
 * **Why a store rather than the query cache.** A conversation is not a server
 * resource that can be refetched: it is a projection of an append-only stream
 * whose cursor lives in this state. Putting it in TanStack Query would mean
 * writing through `setQueryData` on every frame and inventing a "refetch" that
 * can only ever mean "reconnect", which the stream already does better.
 *
 * State is **kept when a session unmounts**. That is what makes switching back
 * to a session instant: the cursor survives, so the reconnect replays the gap
 * instead of the conversation. `LIVE_CONVERSATIONS` bounds the memory that
 * costs.
 *
 * ## One stream per session
 *
 * A session owns exactly one stream once it has been messaged — a `fork` is its
 * own child session now, not a sibling stream — so there is one fold and one
 * SSE connection, and no per-branch projection. A fork's inherited history is
 * spliced onto its own stream server-side (seq-less, on full replay only), so
 * the client just folds the frames it receives; the resume cursor is a single
 * session-level `lastSeq`.
 */

import { create } from 'zustand'
import { appendOptimisticUser, foldEvents, initialConversationState } from '@/app/fold'
import type { ConversationState, TodosItem } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'

/** How many conversations are kept in memory. Oldest touched is evicted first. */
const LIVE_CONVERSATIONS = 8

/** Whether the stream for a session is attached right now. */
export type ConnectionPhase = 'offline' | 'connecting' | 'live' | 'retrying'

export interface SessionRuntime {
  /** The folded conversation the transcript renders. */
  conversation: ConversationState
  connection: ConnectionPhase
  /**
   * A send has been dispatched and the server has not spoken yet.
   *
   * The backend pushes a synthetic `turn_started` before it queues the drive
   * job, but for a session whose first message *creates* the stream there is no
   * SSE connection yet to carry it. Without this flag the composer would be
   * enabled during the seconds `seed_start` spends allocating a container.
   */
  sending: boolean
}

/** The state a session that has never been opened renders as. Stable identity. */
const EMPTY_CONVERSATION = initialConversationState()

const EMPTY_RUNTIME: SessionRuntime = {
  conversation: EMPTY_CONVERSATION,
  connection: 'offline',
  sending: false,
}

interface ConversationStoreState {
  runtimes: Record<string, SessionRuntime>
  /** Most-recently-touched first. Only used for eviction. */
  order: string[]
  ensure: (sessionId: string) => void
  apply: (sessionId: string, events: readonly RawUIEvent[]) => void
  setConnection: (sessionId: string, connection: ConnectionPhase) => void
  markSending: (sessionId: string) => void
  clearSending: (sessionId: string) => void
  /** Show the user's message before the server has acknowledged it; returns its key. */
  appendPending: (sessionId: string, content: string) => number
  /** Take back an optimistic bubble whose send was rejected. */
  dropPending: (sessionId: string, key: number) => void
  /** Forget a session entirely — used when it is deleted, not when it unmounts. */
  forget: (sessionId: string) => void
}

function touch(
  runtimes: Record<string, SessionRuntime>,
  order: string[],
  sessionId: string,
): { runtimes: Record<string, SessionRuntime>; order: string[] } {
  const next = [sessionId, ...order.filter((id) => id !== sessionId)]
  if (next.length <= LIVE_CONVERSATIONS) return { runtimes, order: next }
  const kept = next.slice(0, LIVE_CONVERSATIONS)
  const dropped = new Set(next.slice(LIVE_CONVERSATIONS))
  const trimmed: Record<string, SessionRuntime> = {}
  for (const [id, runtime] of Object.entries(runtimes)) {
    if (!dropped.has(id)) trimmed[id] = runtime
  }
  return { runtimes: trimmed, order: kept }
}

export const useConversationStore = create<ConversationStoreState>((set, get) => {
  /**
   * Rewrite one session's runtime. Returns the same state object when the
   * update produced nothing new, so a dropped frame does not re-render the
   * transcript.
   */
  const update = (sessionId: string, patch: (runtime: SessionRuntime) => SessionRuntime) => {
    set((state) => {
      const current = state.runtimes[sessionId] ?? EMPTY_RUNTIME
      const next = patch(current)
      if (next === current && state.runtimes[sessionId] !== undefined) return state
      const { runtimes, order } = touch(state.runtimes, state.order, sessionId)
      return { runtimes: { ...runtimes, [sessionId]: next }, order }
    })
  }

  return {
    runtimes: {},
    order: [],

    ensure: (sessionId) => update(sessionId, (runtime) => runtime),

    apply: (sessionId, events) =>
      update(sessionId, (runtime) => {
        if (events.length === 0) return runtime
        const conversation = foldEvents(runtime.conversation, events)
        // The first sign of life from the server retires the optimistic flag:
        // a turn that started, a frame that landed, or a turn that finished
        // before we ever saw it start. Tying it to `turn_started` alone would
        // leave the composer locked whenever that one frame is lost.
        const sending =
          runtime.sending &&
          !conversation.running &&
          conversation.items === runtime.conversation.items &&
          conversation.lastOutcome === runtime.conversation.lastOutcome
        if (conversation === runtime.conversation && sending === runtime.sending) return runtime
        return { ...runtime, conversation, sending }
      }),

    setConnection: (sessionId, connection) =>
      update(sessionId, (runtime) =>
        runtime.connection === connection ? runtime : { ...runtime, connection },
      ),

    markSending: (sessionId) =>
      update(sessionId, (runtime) => (runtime.sending ? runtime : { ...runtime, sending: true })),

    clearSending: (sessionId) =>
      update(sessionId, (runtime) => (runtime.sending ? { ...runtime, sending: false } : runtime)),

    appendPending: (sessionId, content) => {
      const key = (get().runtimes[sessionId] ?? EMPTY_RUNTIME).conversation.nextKey
      update(sessionId, (runtime) => ({
        ...runtime,
        conversation: appendOptimisticUser(runtime.conversation, content, []),
      }))
      return key
    },

    dropPending: (sessionId, key) =>
      update(sessionId, (runtime) => {
        const { conversation } = runtime
        const items = conversation.items.filter(
          (item) => !(item.key === key && item.kind === 'user' && item.pending),
        )
        if (items.length === conversation.items.length) return runtime
        return { ...runtime, conversation: { ...conversation, items } }
      }),

    forget: (sessionId) =>
      set((state) => {
        if (state.runtimes[sessionId] === undefined) return state
        const runtimes = { ...state.runtimes }
        delete runtimes[sessionId]
        return { runtimes, order: state.order.filter((id) => id !== sessionId) }
      }),
  }
})

/**
 * Read one session's runtime.
 *
 * The `null` session id is the "project open, nothing selected" surface, which
 * renders an empty transcript rather than a special case in every consumer.
 */
export function useSessionRuntime(sessionId: string | null): SessionRuntime {
  return useConversationStore((state) =>
    sessionId === null ? EMPTY_RUNTIME : (state.runtimes[sessionId] ?? EMPTY_RUNTIME),
  )
}

export function useConversation(sessionId: string | null): ConversationState {
  return useConversationStore((state) =>
    sessionId === null
      ? EMPTY_CONVERSATION
      : (state.runtimes[sessionId]?.conversation ?? EMPTY_CONVERSATION),
  )
}

/** The store's actions, for callers outside React or outside a render. */
export function conversationActions() {
  return useConversationStore.getState()
}

/**
 * The most recent checklist the conversation produced, or null.
 *
 * The plan is pulled out of the scrolling step stream and shown as a persistent
 * strip above the composer, so progress does not scroll away. "Latest" is the
 * last `todos` item in the conversation — the fold already collapses repeated
 * `todo_update` frames onto one moving item per turn, so this is one scan for
 * the tail rather than a merge.
 */
export function useLatestTodos(sessionId: string | null): TodosItem | null {
  return useConversationStore((state) => {
    const items =
      sessionId === null
        ? EMPTY_CONVERSATION.items
        : (state.runtimes[sessionId]?.conversation.items ?? EMPTY_CONVERSATION.items)
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind === 'todos') return item
    }
    return null
  })
}
