import { describe, expect, it } from 'vitest'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import {
  autoAdvances,
  currentAnswer,
  initialWalk,
  isLastQuestion,
  questionQueue,
  questionWalk,
  usableQuestion,
} from './question-queue'

const frame = (type: string, data: Record<string, unknown>, seq: number): RawUIEvent =>
  ({ seq, type, data }) as RawUIEvent

const request = (
  id: string,
  questions: unknown[] = [{ id: '0', question: 'A?', options: [], multiSelect: false }],
) => frame('question', { question_id: id, reason: '', questions }, nextSeq())

let seq = 0
const nextSeq = () => (seq += 1)

const fold = (...events: RawUIEvent[]) => foldEvents(initialConversationState(), events)

describe('the request queue', () => {
  it('shows requests oldest first, one at a time', () => {
    // The engine can park on two questions at once; `pendingQuestionId` holds
    // the newer one, so the older would silently stop being answerable.
    const queue = questionQueue(fold(request('req-1'), request('req-2')))

    expect(queue.map((item) => item.questionId)).toEqual(['req-1', 'req-2'])
  })

  it('drops a request the stream says was answered', () => {
    const conversation = fold(
      request('req-1'),
      request('req-2'),
      frame('question_answered', { question_id: 'req-1' }, nextSeq()),
    )

    expect(questionQueue(conversation).map((item) => item.questionId)).toEqual(['req-2'])
  })

  it('drops a request the stream says was withdrawn', () => {
    // 0.6.2 Stop-on-question: the withdrawn request leaves the queue so the
    // panel clears, exactly as an answered one does.
    const conversation = fold(
      request('req-1'),
      request('req-2'),
      frame('question_withdrawn', { question_id: 'req-1' }, nextSeq()),
    )

    expect(questionQueue(conversation).map((item) => item.questionId)).toEqual(['req-2'])
  })

  it('drops a request this client answered before the frame came back', () => {
    // Otherwise the next question appears a round trip late, which reads as the
    // panel hanging on an answer that was already accepted.
    const conversation = fold(request('req-1'), request('req-2'))

    expect(questionQueue(conversation, new Set(['req-1'])).map((i) => i.questionId)).toEqual([
      'req-2',
    ])
  })

  it('is empty when nothing is pending', () => {
    expect(questionQueue(initialConversationState())).toEqual([])
  })
})

describe('usable options', () => {
  it('drops an option that could never be submitted', () => {
    // The answer names labels, so a duplicate is ambiguous and an empty label
    // is unpickable — either degrades that one option.
    const question = {
      id: '0',
      question: 'Which?',
      options: [{ label: 'Fine' }, { label: 'Fine' }, { label: '' }],
      multiSelect: false,
    }

    expect(usableQuestion(question).options.map((o) => o.label)).toEqual(['Fine'])
  })

  it('returns the same object when every option is usable', () => {
    const question = { id: '0', question: '?', options: [{ label: 'A' }], multiSelect: false }

    expect(usableQuestion(question)).toBe(question)
  })
})

describe('walking one request', () => {
  const questions = [
    { id: '0', question: 'Where?', options: [{ label: 'Staging' }], multiSelect: false },
    { id: '1', question: 'When?', options: [], multiSelect: false },
  ]

  it('has no answer until something is picked or typed', () => {
    expect(currentAnswer(initialWalk())).toBeNull()
  })

  it('carries typed "Other" text alongside a picked option', () => {
    let state = questionWalk(initialWalk(), {
      type: 'toggle',
      label: 'Staging',
      multiSelect: false,
    })
    state = questionWalk(state, { type: 'freeform', value: '  now  ' })

    expect(currentAnswer(state)).toEqual({ selected: ['Staging'], other: 'now' })
  })

  it('takes only text when nothing is picked', () => {
    const state = questionWalk(initialWalk(), { type: 'freeform', value: 'typed' })

    expect(currentAnswer(state)).toEqual({ other: 'typed' })
  })

  it('replaces the single-select pick with the latest label', () => {
    let state = questionWalk(initialWalk(), { type: 'toggle', label: 'A', multiSelect: false })
    state = questionWalk(state, { type: 'toggle', label: 'B', multiSelect: false })

    expect(currentAnswer(state)).toEqual({ selected: ['B'], other: null })
  })

  it('re-clicking a single-select label clears it', () => {
    let state = questionWalk(initialWalk(), { type: 'toggle', label: 'A', multiSelect: false })
    state = questionWalk(state, { type: 'toggle', label: 'A', multiSelect: false })

    expect(currentAnswer(state)).toBeNull()
  })

  it('accumulates and toggles labels for a multi-select question', () => {
    let state = questionWalk(initialWalk(), { type: 'toggle', label: 'A', multiSelect: true })
    state = questionWalk(state, { type: 'toggle', label: 'B', multiSelect: true })
    expect(currentAnswer(state)).toEqual({ selected: ['A', 'B'], other: null })

    state = questionWalk(state, { type: 'toggle', label: 'A', multiSelect: true })
    expect(currentAnswer(state)).toEqual({ selected: ['B'], other: null })
  })

  it('commits in order and clears the slate for the next question', () => {
    let state = questionWalk(initialWalk(), { type: 'toggle', label: 'Staging', multiSelect: false })
    state = questionWalk(state, { type: 'commit', question: questions[0] })

    expect(state.index).toBe(1)
    expect(state.answers).toEqual({ '0': { selected: ['Staging'], other: null } })
    expect(state.selection).toEqual([])
    expect(state.freeform).toBe('')
  })

  it('refuses to commit an unanswered question', () => {
    const state = initialWalk()

    expect(questionWalk(state, { type: 'commit', question: questions[0] })).toBe(state)
  })

  it('wraps arrow-key focus in both directions', () => {
    const state = questionWalk(initialWalk(), { type: 'moveFocus', direction: -1, total: 3 })

    expect(state.focused).toBe(2)
    expect(questionWalk(state, { type: 'moveFocus', direction: 1, total: 3 }).focused).toBe(0)
  })

  it('knows when it is on the last question', () => {
    expect(isLastQuestion(initialWalk(), questions)).toBe(false)
    expect(isLastQuestion({ ...initialWalk(), index: 1 }, questions)).toBe(true)
  })
})

describe('auto-advance', () => {
  it('moves on for a single-select that is not the last question', () => {
    expect(autoAdvances({ id: '0', question: '?', options: [], multiSelect: false }, false)).toBe(
      true,
    )
  })

  it('never submits a whole request on one click', () => {
    expect(autoAdvances({ id: '0', question: '?', options: [], multiSelect: false }, true)).toBe(
      false,
    )
  })

  it('waits on a multi-select, where the reader may still be picking', () => {
    expect(autoAdvances({ id: '0', question: '?', options: [], multiSelect: true }, false)).toBe(
      false,
    )
  })
})
