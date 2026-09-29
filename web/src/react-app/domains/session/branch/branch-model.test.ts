import { describe, expect, it } from 'vitest'
import { isForkableMessage, isLatestUserMessage } from './branch-model'

describe('isForkableMessage', () => {
  const messages = [
    { key: 0, taskId: 't1' },
    { key: 4, taskId: 't1' },
    { key: 0, taskId: 't2' },
  ]

  it('refuses the opening message of a stream', () => {
    // A fork folds the state through the turn boundary before its anchor, and
    // the first message has no prior turn — the engine answers 409, so the
    // affordance is not offered.
    expect(isForkableMessage(messages, { key: 0, taskId: 't1' })).toBe(false)
    expect(isForkableMessage(messages, { key: 0, taskId: 't2' })).toBe(false)
  })

  it('allows a later message on the same stream', () => {
    expect(isForkableMessage(messages, { key: 4, taskId: 't1' })).toBe(true)
  })

  it('refuses a bubble the server has not acknowledged', () => {
    // A negative key is the optimistic echo; there is no seq to anchor at.
    expect(isForkableMessage(messages, { key: -1, taskId: 't1' })).toBe(false)
  })
})

describe('isLatestUserMessage', () => {
  const messages = [
    { key: 0, taskId: 't1' },
    { key: 4, taskId: 't1' },
    { key: 0, taskId: 't2' },
  ]

  it('is true only for the last committed message on the stream', () => {
    expect(isLatestUserMessage(messages, { key: 4, taskId: 't1' })).toBe(true)
    expect(isLatestUserMessage(messages, { key: 0, taskId: 't1' })).toBe(false)
    // Last on its own stream, even though earlier in the array.
    expect(isLatestUserMessage(messages, { key: 0, taskId: 't2' })).toBe(true)
  })

  it('refuses a pending optimistic bubble — no seq to rewind to', () => {
    expect(isLatestUserMessage(messages, { key: -1, taskId: 't1' })).toBe(false)
  })
})
