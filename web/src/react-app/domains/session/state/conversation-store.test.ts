import { beforeEach, describe, expect, it } from 'vitest'
import type { RawUIEvent } from '@/app/types'
import { useConversationStore } from './conversation-store'

/**
 * The store's own rules — the ones that are not the pure fold's.
 *
 * The fold is already pinned in `app/`, so what is asserted here is the layer
 * around it: that the optimistic send flag retires on the first sign of life,
 * that a rejected send can be taken back, and that state identity is preserved
 * when nothing changed (a new-but-equal object re-renders the transcript on
 * every dropped frame).
 */

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

function reset() {
  useConversationStore.setState({ runtimes: {}, order: [] })
}

const store = () => useConversationStore.getState()

beforeEach(reset)

describe('the conversation store', () => {
  it('folds a batch into one state transition', () => {
    let notifications = 0
    const unsubscribe = useConversationStore.subscribe(() => {
      notifications += 1
    })

    store().apply('s1', [
      frame('turn_started', {}, 0),
      frame('assistant_text', { text: 'hello' }, 1),
      frame('turn_finished', { status: 'completed' }, 2),
    ])
    unsubscribe()

    expect(notifications).toBe(1)
    const conversation = store().runtimes.s1.conversation
    expect(conversation.items).toHaveLength(1)
    expect(conversation.lastSeq).toBe(2)
    expect(conversation.running).toBe(false)
  })

  it('keeps the same state object when a batch changed nothing', () => {
    store().apply('s1', [frame('assistant_text', { text: 'hi' }, 5)])
    const before = store().runtimes.s1

    // A replayed frame at or below the cursor, and a frame type this build
    // does not know: both are no-ops by design.
    store().apply('s1', [frame('assistant_text', { text: 'hi' }, 5), frame('from_the_future', {}, null)])

    expect(store().runtimes.s1).toBe(before)
  })

  it('clears the optimistic send flag on the first sign of life', () => {
    store().markSending('s1')
    expect(store().runtimes.s1.sending).toBe(true)

    store().apply('s1', [frame('turn_started', {}, 0)])

    expect(store().runtimes.s1.sending).toBe(false)
  })

  it('clears it on a turn that finished before we saw it start', () => {
    // A `turn_started` can be lost on a live stream; tying the flag to that one
    // frame would leave the composer locked for the rest of the session.
    store().markSending('s1')
    store().apply('s1', [frame('turn_finished', { status: 'completed' }, 3)])

    expect(store().runtimes.s1.sending).toBe(false)
  })

  it('holds the flag while frames that say nothing about the turn arrive', () => {
    store().markSending('s1')
    store().apply('s1', [frame('session_meta', { title: 'Renamed' })])

    expect(store().runtimes.s1.sending).toBe(true)
    expect(store().runtimes.s1.conversation.title).toBe('Renamed')
  })

  it('replaces the optimistic bubble with the durable frame rather than duplicating it', () => {
    store().appendPending('s1', 'do the thing')
    store().apply('s1', [frame('user_message', { content: 'do the thing' }, 0)])

    const { items } = store().runtimes.s1.conversation
    expect(items).toHaveLength(1)
    expect(items[0].kind === 'user' && items[0].pending).toBe(false)
    expect(items[0].key).toBe(0)
  })

  it('takes back an optimistic bubble whose send was rejected', () => {
    const key = store().appendPending('s1', 'never sent')
    expect(store().runtimes.s1.conversation.items).toHaveLength(1)

    store().dropPending('s1', key)

    expect(store().runtimes.s1.conversation.items).toHaveLength(0)
  })

  it('will not drop a durable message that happens to share the key', () => {
    store().apply('s1', [frame('user_message', { content: 'real' }, 0)])
    const before = store().runtimes.s1

    store().dropPending('s1', 0)

    expect(store().runtimes.s1).toBe(before)
  })

  it('keeps sessions apart and evicts only the oldest', () => {
    for (let i = 0; i < 10; i += 1) {
      store().apply(`s${i}`, [frame('assistant_text', { text: `m${i}` }, 0)])
    }

    // Eight live conversations; the two least recently touched are gone.
    expect(Object.keys(store().runtimes)).toHaveLength(8)
    expect(store().runtimes.s0).toBeUndefined()
    expect(store().runtimes.s9.conversation.items).toHaveLength(1)
  })
})
