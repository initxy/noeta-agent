import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { ConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { QuestionPanel } from './question-panel'

/**
 * The question surface is the difference between a usable product and a
 * dead-end on the first turn: the mock provider's demo chain opens with a
 * question, and a pending question 409s every message the composer could send.
 *
 * The answer shape is the SDK's 0.6.x reference contract: each answer is
 * `{selected: [labels...], other}`, options carry no id, and the free-text
 * "Other" slot is always available.
 */

vi.mock('@/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api')>()
  return { ...actual, answerQuestion: vi.fn(async () => undefined) }
})

const api = await import('@/app/api')
const answerQuestion = vi.mocked(api.answerQuestion)

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

const ONE_QUESTION = {
  question_id: 'req-1',
  reason: 'I need a target before I start.',
  questions: [
    {
      id: '0',
      question: 'Which environment should I ship to?',
      header: 'Pick a deploy target',
      options: [
        { label: 'Staging', description: 'Deploys to stage.example.com' },
        { label: 'Production' },
      ],
      multiSelect: false,
    },
  ],
}

function asked(...events: RawUIEvent[]): ConversationState {
  return foldEvents(initialConversationState(), [
    frame('turn_started', {}, 0),
    frame('question', ONE_QUESTION, 1),
    ...events,
  ])
}

function show(conversation: ConversationState) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <QuestionPanel sessionId="s1" conversation={conversation} />
    </QueryClientProvider>,
  )
}

const answerButton = () => screen.getByRole('button', { name: 'Answer' }) as HTMLButtonElement

beforeEach(() => {
  answerQuestion.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('the question panel', () => {
  it('shows nothing when no question is pending', () => {
    show(initialConversationState())
    expect(screen.queryByTestId('question-panel')).toBeNull()
  })

  it('disappears once the answer is acknowledged on the stream', () => {
    show(asked(frame('question_answered', { question_id: 'req-1' }, 2)))
    expect(screen.queryByTestId('question-panel')).toBeNull()
  })

  it('renders the reason, the question and its options', () => {
    show(asked())

    expect(screen.getByText('I need a target before I start.')).toBeTruthy()
    expect(screen.getByText('Pick a deploy target')).toBeTruthy()
    expect(screen.getByText('Which environment should I ship to?')).toBeTruthy()
    expect(screen.getByText('Deploys to stage.example.com')).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
  })

  it('submits the chosen option label under the question id', async () => {
    show(asked())
    expect(answerButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: /Staging/ }))
    expect(answerButton().disabled).toBe(false)
    fireEvent.click(answerButton())

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0][0]).toBe('s1')
    expect(answerQuestion.mock.calls[0][1]).toEqual({
      question_id: 'req-1',
      answers: { '0': { selected: ['Staging'], other: null } },
    })
  })

  it('carries typed "Other" text alongside a picked option', async () => {
    show(asked())
    fireEvent.click(screen.getByRole('radio', { name: /Production/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  canary  ' } })

    // The picked option stays picked — the "Other" slot is additive, not a
    // replacement — and both ride the answer.
    expect(screen.getByRole('radio', { name: /Production/ }).getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.click(answerButton())

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0][1]).toEqual({
      question_id: 'req-1',
      answers: { '0': { selected: ['Production'], other: 'canary' } },
    })
  })

  it('multi-select keeps several options and submits them together', async () => {
    show(
      foldEvents(initialConversationState(), [
        frame(
          'question',
          {
            question_id: 'req-multi',
            reason: 'pick any',
            questions: [
              {
                id: '0',
                question: 'Which checks?',
                options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }],
                multiSelect: true,
              },
            ],
          },
          0,
        ),
      ]),
    )

    // Checkboxes, not radios, and no auto-advance: several can be picked.
    fireEvent.click(screen.getByRole('checkbox', { name: /Lint/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Tests/ }))
    fireEvent.click(answerButton())

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0][1]).toEqual({
      question_id: 'req-multi',
      answers: { '0': { selected: ['Lint', 'Tests'], other: null } },
    })
  })

  it('walks a multi-question request one at a time and submits them together', async () => {
    show(
      foldEvents(initialConversationState(), [
        frame(
          'question',
          {
            question_id: 'req-2',
            reason: 'two things',
            questions: [
              { id: '0', question: 'First?', options: [], multiSelect: false },
              { id: '1', question: 'Second?', options: [], multiSelect: false },
            ],
          },
          0,
        ),
      ]),
    )

    // One question on screen, counted, with a Next rather than an Answer.
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getByText('Question 1 of 2')).toBeTruthy()

    const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement
    expect(next.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one' } })
    fireEvent.click(next)

    expect(screen.getByText('Question 2 of 2')).toBeTruthy()
    // The slate is clean: the second question does not inherit the first's text.
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'two' } })
    fireEvent.click(answerButton())

    await waitFor(() => expect(answerQuestion).toHaveBeenCalledTimes(1))
    expect(answerQuestion.mock.calls[0][1]).toEqual({
      question_id: 'req-2',
      answers: { '0': { other: 'one' }, '1': { other: 'two' } },
    })
  })

  it('shows one request at a time and answers them in order', async () => {
    // The engine can park on two questions at once. Rendering both would let
    // the second be answered first, and the backend 409s anything sent while a
    // question is pending — so the second request is unanswerable, not just
    // untidy.
    show(
      foldEvents(initialConversationState(), [
        frame('question', { ...ONE_QUESTION, question_id: 'req-a' }, 0),
        frame(
          'question',
          {
            question_id: 'req-b',
            reason: 'and then this',
            questions: [{ id: '0', question: 'Anything else?', options: [], multiSelect: false }],
          },
          1,
        ),
      ]),
    )

    expect(screen.getByText('I need a target before I start.')).toBeTruthy()
    expect(screen.queryByText('and then this')).toBeNull()
    expect(screen.getByText('1 more question waiting')).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: /Staging/ }))
    fireEvent.click(answerButton())

    // The next request takes the slot as soon as the answer is accepted —
    // without waiting for its `question_answered` frame to come back.
    await screen.findByText('and then this')
    expect(answerQuestion.mock.calls[0][1].question_id).toBe('req-a')
  })

  it('moves between options with the arrow keys', () => {
    show(asked())
    const [staging, production] = screen.getAllByRole('radio')

    staging.focus()
    fireEvent.keyDown(staging, { key: 'ArrowDown' })

    expect(document.activeElement).toBe(production)
    expect(staging.getAttribute('tabindex')).toBe('-1')
    expect(production.getAttribute('tabindex')).toBe('0')
  })

  it('does not offer an option that could never be submitted', () => {
    // A duplicate label is ambiguous on the wire (the answer names labels), and
    // an empty label is unpickable; either degrades that one option.
    show(
      foldEvents(initialConversationState(), [
        frame(
          'question',
          {
            question_id: 'req-3',
            reason: '',
            questions: [
              {
                id: '0',
                question: 'Which?',
                options: [
                  { label: 'Fine' },
                  { label: 'Fine' },
                  { label: '' },
                ],
                multiSelect: false,
              },
            ],
          },
          0,
        ),
      ]),
    )

    expect(screen.getAllByRole('radio')).toHaveLength(1)
  })

  it('keeps the panel and says why when the answer is rejected', async () => {
    answerQuestion.mockRejectedValueOnce(new Error('the turn was already cancelled'))
    show(asked())
    fireEvent.click(screen.getByRole('radio', { name: /Staging/ }))
    fireEvent.click(answerButton())

    await screen.findByText('the turn was already cancelled')
    expect(screen.getByTestId('question-panel')).toBeTruthy()
  })
})
