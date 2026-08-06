import { describe, expect, it } from 'vitest'
import { applyDelta } from '@/app/fold'
import type { DeltaState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { coalesceEvents } from './coalesce'

/**
 * The contract this pass has to keep is equivalence: whatever the fold would
 * have produced frame by frame, it must still produce from the merged batch.
 * Every rule below is a way that equivalence gets lost, so each is pinned
 * twice — once as a shape assertion, once by replaying both batches through
 * `applyDelta` and comparing the buffer.
 */

const delta = (
  text: string,
  extra: { call?: string; index?: number; kind?: string; task?: string } = {},
): RawUIEvent => ({
  seq: null,
  type: 'delta',
  data: {
    call_id: extra.call ?? 'c1',
    kind: extra.kind ?? 'text',
    text,
    index: extra.index ?? 0,
    ...(extra.task === undefined ? {} : { _task: extra.task }),
  },
})

const durable = (type: string, seq: number, data: Record<string, unknown> = {}): RawUIEvent => ({
  seq,
  type,
  data,
})

/** What the fold's preview buffer looks like after a batch of frames. */
function preview(events: readonly RawUIEvent[]): DeltaState | null {
  let state: DeltaState | null = null
  for (const event of events) {
    if (event.type === 'delta') state = applyDelta(state, event.data)
    // The four frames that clear the preview, plus `llm_retry`. Modelled here
    // rather than imported so this test states its own assumption.
    else if (event.type !== 'todo_update') state = null
  }
  return state
}

function equivalent(events: readonly RawUIEvent[]) {
  expect(preview(coalesceEvents(events))).toEqual(preview(events))
}

describe('per-frame delta coalescing', () => {
  it('merges a burst into one frame carrying the concatenation', () => {
    const batch = [delta('Hel'), delta('lo '), delta('world')]
    const merged = coalesceEvents(batch)

    expect(merged).toHaveLength(1)
    expect(merged[0].data.text).toBe('Hello world')
    equivalent(batch)
  })

  it('appends rather than keeping the longer text — the wire is incremental', () => {
    // The reference implementation's producer was cumulative, so its rule was
    // "keep whichever is longer". Inheriting it here would spell "aa" as "a".
    const batch = [delta('a'), delta('a')]

    expect(coalesceEvents(batch)[0].data.text).toBe('aa')
    equivalent(batch)
  })

  it('keeps one frame per block and never reorders them', () => {
    const batch = [
      delta('think ', { index: 0, kind: 'thinking' }),
      delta('answer ', { index: 1 }),
      delta('more', { index: 0, kind: 'thinking' }),
      delta('text', { index: 1 }),
    ]
    const merged = coalesceEvents(batch)

    expect(merged.map((event) => event.data.text)).toEqual(['think more', 'answer text'])
    expect(merged.map((event) => event.data.index)).toEqual([0, 1])
    equivalent(batch)
  })

  it('drops an empty delta appended to an open block', () => {
    const batch = [delta('hi'), delta(''), delta('!')]

    expect(coalesceEvents(batch)).toHaveLength(1)
    expect(coalesceEvents(batch)[0].data.text).toBe('hi!')
    equivalent(batch)
  })

  it('keeps an empty delta that opens a block, because it is not a no-op', () => {
    // A different call id resets the whole buffer even when it carries no
    // characters — that is how an abandoned half-stream is discarded.
    const batch = [delta('stale'), delta('', { call: 'c2' })]

    expect(coalesceEvents(batch)).toHaveLength(2)
    equivalent(batch)
  })

  it('starts a new frame when the kind at one index changes', () => {
    // A different kind replaces the block rather than appending to it.
    const batch = [delta('was text'), delta('now thinking', { kind: 'thinking' })]

    expect(coalesceEvents(batch)).toHaveLength(2)
    equivalent(batch)
  })

  it('never merges across a durable frame', () => {
    // `assistant_text` clears the preview. Merging across it would resurrect
    // bytes that frame just discarded.
    const batch = [delta('half'), durable('assistant_text', 4, { text: 'half done' }), delta('next')]
    const merged = coalesceEvents(batch)

    expect(merged).toHaveLength(3)
    expect(merged[1].type).toBe('assistant_text')
    equivalent(batch)
  })

  it('never merges across an llm_retry, which resets the same call', () => {
    const batch = [delta('garba'), durable('llm_retry', 7, { call_id: 'c1' }), delta('clean')]

    expect(coalesceEvents(batch)).toHaveLength(3)
    equivalent(batch)
  })

  it('does not merge a later frame of a call that was already displaced', () => {
    // One call is buffered at a time, so `c1`'s tail must stay *after* `c2`.
    const batch = [delta('one'), delta('two', { call: 'c2' }), delta('three')]
    const merged = coalesceEvents(batch)

    expect(merged.map((event) => event.data.text)).toEqual(['one', 'two', 'three'])
    equivalent(batch)
  })

  it('keeps streams apart', () => {
    const batch = [delta('root', { task: 't1' }), delta('branch', { task: 't2' })]

    expect(coalesceEvents(batch)).toHaveLength(2)
  })

  it('leaves a malformed delta for the fold to reject', () => {
    const bad: RawUIEvent = { seq: null, type: 'delta', data: { call_id: 'c1', kind: 'audio' } }
    const batch = [delta('a'), bad, delta('b')]

    expect(coalesceEvents(batch)).toHaveLength(3)
    equivalent(batch)
  })

  it('never touches a frame carrying a seq, even one typed delta', () => {
    // A delta with an SSE id is a contract violation, not something to fold
    // into its neighbours.
    const impossible: RawUIEvent = { ...delta('x'), seq: 3 }

    expect(coalesceEvents([delta('a'), impossible, delta('b')])).toHaveLength(3)
  })

  it('returns a batch with no deltas untouched, frame for frame', () => {
    const batch = [durable('user_message', 0, { content: 'hi' }), durable('turn_started', 1)]

    expect(coalesceEvents(batch)).toEqual(batch)
  })
})
