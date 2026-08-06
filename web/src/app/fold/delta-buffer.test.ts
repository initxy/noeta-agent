import { describe, expect, it } from 'vitest'
import { applyDelta, renderDeltaBlocks, resetCall } from './delta-buffer'
import type { DeltaState } from './delta-buffer'

const delta = (callId: string, index: number, text: string, kind = 'text') => ({
  call_id: callId,
  kind,
  text,
  index,
  _task: 'task-1',
})

function buffer(...deltas: unknown[]): DeltaState {
  let state: DeltaState | null = null
  for (const d of deltas) state = applyDelta(state, d)
  if (state === null) throw new Error('expected a buffered call')
  return state
}

describe('applyDelta', () => {
  it('starts a buffer from the first delta', () => {
    const state = buffer(delta('call-1', 0, 'he'))
    expect(state.callId).toBe('call-1')
    expect(renderDeltaBlocks(state)).toEqual([{ kind: 'text', text: 'he' }])
  })

  it('appends at the same index and kind', () => {
    const state = buffer(delta('call-1', 0, 'he'), delta('call-1', 0, 'llo'))
    expect(renderDeltaBlocks(state)).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('replaces the whole state when the call_id changes', () => {
    // The retry invariant: a half-stream abandoned by a retry that re-issued
    // under a new call must not survive into the new one.
    const state = buffer(delta('call-1', 0, 'abandoned'), delta('call-2', 0, 'fresh'))
    expect(state.callId).toBe('call-2')
    expect(renderDeltaBlocks(state)).toEqual([{ kind: 'text', text: 'fresh' }])
  })

  it('replaces rather than concatenates when the kind flips at one index', () => {
    const state = buffer(delta('call-1', 0, 'thought', 'thinking'), delta('call-1', 0, 'said'))
    expect(renderDeltaBlocks(state)).toEqual([{ kind: 'text', text: 'said' }])
  })

  it('renders blocks sorted by index, dropping empty ones', () => {
    const state = buffer(
      delta('call-1', 2, 'third'),
      delta('call-1', 0, 'first'),
      delta('call-1', 1, ''),
    )
    expect(renderDeltaBlocks(state)).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'third' },
    ])
  })

  it('renders null when every block is empty', () => {
    expect(renderDeltaBlocks(buffer(delta('call-1', 0, '')))).toBeNull()
    expect(renderDeltaBlocks(null)).toBeNull()
  })

  // Forward compatibility and malformed-frame safety in one rule: an invalid
  // delta is not merely skipped, it returns the *same reference*, so a React
  // subscriber does not re-render on a frame that changed nothing.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['an array', []],
    ['an empty call_id', delta('', 0, 'x')],
    ['an unknown kind', delta('call-1', 0, 'x', 'audio')],
    ['a non-string text', { call_id: 'call-1', kind: 'text', text: 42, index: 0 }],
    ['a non-finite index', { call_id: 'call-1', kind: 'text', text: 'x', index: Number.NaN }],
    ['a missing index', { call_id: 'call-1', kind: 'text', text: 'x' }],
  ])('ignores %s by reference identity', (_label, invalid) => {
    const state = buffer(delta('call-1', 0, 'kept'))
    expect(applyDelta(state, invalid)).toBe(state)
    expect(applyDelta(null, invalid)).toBeNull()
  })

  it('returns the same reference when an append adds nothing', () => {
    const state = buffer(delta('call-1', 0, 'kept'))
    expect(applyDelta(state, delta('call-1', 0, ''))).toBe(state)
  })
})

describe('resetCall', () => {
  it('clears a matching call', () => {
    const state = buffer(delta('call-1', 0, 'partial'))
    expect(resetCall(state, 'call-1')).toBeNull()
  })

  it('returns the same object on a mismatched id — a genuine no-op', () => {
    // Not a new equal object: `llm_retry` for some other call must not
    // re-render the preview of the one that is streaming.
    const state = buffer(delta('call-1', 0, 'partial'))
    expect(resetCall(state, 'call-2')).toBe(state)
  })

  it('clears unconditionally on a null id', () => {
    const state = buffer(delta('call-1', 0, 'partial'))
    expect(resetCall(state, null)).toBeNull()
    expect(resetCall(null, null)).toBeNull()
  })
})
