import { describe, expect, it } from 'vitest'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { composerPhase, composerState } from './send-state'

/**
 * The composer's enablement rule, driven through the **real fold** rather than
 * hand-built state. The rule that matters — `interrupted` and `turn_failed`
 * leave the composer enabled — is a claim about what a sequence of wire frames
 * does, and asserting it against a state object someone typed by hand would
 * pin the assumption instead of the behaviour.
 */

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

function after(...events: RawUIEvent[]) {
  return foldEvents(initialConversationState(), events)
}

describe('composerPhase', () => {
  it('ranks a pending question above a running turn', () => {
    // A question keeps `running` true — the turn is parked, not over — so the
    // more specific reason has to win or the hint tells the user to wait when
    // they are the one being waited on.
    expect(composerPhase({ running: true, pendingQuestionId: 'q1', sending: false })).toBe('waiting')
  })

  it('ranks a running turn above an optimistic send', () => {
    expect(composerPhase({ running: true, pendingQuestionId: null, sending: true })).toBe('running')
  })

  it('reports the optimistic send while the server has not spoken', () => {
    expect(composerPhase({ running: false, pendingQuestionId: null, sending: true })).toBe('sending')
  })

  it('is idle with nothing in flight', () => {
    expect(composerPhase({ running: false, pendingQuestionId: null, sending: false })).toBe('idle')
  })
})

describe('the composer after a turn ends', () => {
  const started = frame('turn_started', {}, 0)

  it('is DISABLED while the turn runs', () => {
    const state = composerState({ conversation: after(started), sending: false, draft: 'hi' })
    expect(state.phase).toBe('running')
    expect(state.canSend).toBe(false)
  })

  it('is ENABLED after an interrupted turn — stopping is not dying', () => {
    const conversation = after(started, frame('turn_finished', { status: 'interrupted' }, 1))
    const state = composerState({ conversation, sending: false, draft: 'carry on' })

    expect(state.phase).toBe('idle')
    expect(state.canSend).toBe(true)
    expect(state.hint).toBeNull()
    expect(conversation.lastOutcome).toEqual({ status: 'interrupted', reason: null })
  })

  it('is ENABLED after a turn_failed — a provider 5xx parks the turn, it does not seal it', () => {
    const conversation = after(
      started,
      frame('turn_finished', { status: 'turn_failed', reason: 'upstream 503' }, 1),
    )
    const state = composerState({ conversation, sending: false, draft: 'retry please' })

    expect(state.phase).toBe('idle')
    expect(state.canSend).toBe(true)
    expect(conversation.lastOutcome).toEqual({ status: 'turn_failed', reason: 'upstream 503' })
  })

  it('is enabled after cancelled and after failed as well', () => {
    for (const status of ['cancelled', 'failed', 'completed', 'awaiting_input']) {
      const conversation = after(started, frame('turn_finished', { status }, 1))
      expect(composerState({ conversation, sending: false, draft: 'x' }).canSend).toBe(true)
    }
  })

  it('unlocks on a bare `error` frame, without waiting for turn_finished', () => {
    // An answer-drive failure pushes only `error`, and a `turn_finished` can be
    // lost on a live stream. Depending on it alone locks the composer forever.
    const conversation = after(started, frame('error', { message: 'boom' }, 1))
    expect(composerState({ conversation, sending: false, draft: 'x' }).canSend).toBe(true)
  })

  it('is disabled while a question is pending, whatever the draft says', () => {
    const conversation = after(
      started,
      frame('question', { question_id: 'q1', reason: 'pick', questions: [] }, 1),
    )
    const state = composerState({ conversation, sending: false, draft: 'ignored' })

    expect(state.phase).toBe('waiting')
    expect(state.canSend).toBe(false)
    expect(state.hint).toBe('Answer the question above to continue.')
  })

  it('re-enables once the question is answered', () => {
    const conversation = after(
      started,
      frame('question', { question_id: 'q1', reason: 'pick', questions: [] }, 1),
      frame('question_answered', { question_id: 'q1' }, 2),
      frame('turn_finished', { status: 'completed' }, 3),
    )
    expect(composerState({ conversation, sending: false, draft: 'x' }).canSend).toBe(true)
  })

  it('will not send whitespace', () => {
    const conversation = initialConversationState()
    expect(composerState({ conversation, sending: false, draft: '   \n ' }).canSend).toBe(false)
  })
})
