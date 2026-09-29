/**
 * The question surface.
 *
 * It is docked above the composer rather than floated over the transcript, and
 * that is not a styling preference: a question **blocks the turn**. The status
 * machine flips to `waiting` on `UserQuestionRequested`, the backend 409s any
 * message sent while one is pending, and the answer is the only thing that
 * moves the conversation forward — so it belongs exactly where the user is
 * already looking to type, with the transcript still readable behind it.
 *
 * It is on the out-of-the-box path: the mock provider's demo chain opens with a
 * question, so a half-built version of this is a product that dead-ends on the
 * first turn.
 *
 * The queue and the walk live in `question-queue.ts`, pure. What is here is the
 * three things only the component can own:
 *
 * - **One request at a time, and the answer is optimistic.** The submitted id
 *   is remembered locally so the next queued request takes the slot the moment
 *   the POST is accepted, rather than a round trip later when
 *   `question_answered` arrives.
 * - **A submit in flight disables everything.** Two answers in the air at once
 *   is the race the queue exists to prevent, and it ends in a 409 the reader
 *   cannot act on.
 * - **Keyboard.** Arrow keys move between options, Enter commits. The reference
 *   implementation left this unwired; a blocking panel that can only be
 *   answered with a mouse is not one.
 */

import { useEffect, useReducer, useRef, useState } from 'react'
import type { QuestionItem } from '@/app/fold'
import type { ConversationState } from '@/app/fold'
import type { QuestionSpec } from '@/app/types'
import { Button, cn } from '@/react-app/design-system'
import { useAnswerQuestion } from '../queries/session-queries'
import {
  autoAdvances,
  currentAnswer,
  initialWalk,
  isLastQuestion,
  questionQueue,
  questionWalk,
  usableQuestion,
} from './question-queue'

/** How long the ✓ stays visible before a single-select question moves on. */
const CONFIRM_MS = 150

export function QuestionPanel({
  sessionId,
  conversation,
}: {
  sessionId: string | null
  conversation: ConversationState
}) {
  if (sessionId === null) return null
  // Keyed on the session so the optimistic "already answered" set cannot leak
  // across a switch — question ids are unique, but the state behind them is not
  // worth reasoning about twice.
  return <QuestionQueue key={sessionId} sessionId={sessionId} conversation={conversation} />
}

function QuestionQueue({
  sessionId,
  conversation,
}: {
  sessionId: string
  conversation: ConversationState
}) {
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(() => new Set())
  const queue = questionQueue(conversation, submitted)
  const head = queue[0]
  if (head === undefined) return null

  return (
    <QuestionForm
      // A new request starts clean: a fresh walk, no half-filled answers
      // inherited from the one before it.
      key={head.questionId}
      sessionId={sessionId}
      item={head}
      onAnswered={(questionId) =>
        setSubmitted((current) => new Set(current).add(questionId))
      }
      queued={queue.length - 1}
    />
  )
}

function QuestionForm({
  sessionId,
  item,
  onAnswered,
  queued,
}: {
  sessionId: string
  item: QuestionItem
  onAnswered: (questionId: string) => void
  /** How many further requests are waiting behind this one. */
  queued: number
}) {
  const [walk, dispatch] = useReducer(questionWalk, initialWalk())
  const answer = useAnswerQuestion()
  const advanceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (advanceRef.current !== null) clearTimeout(advanceRef.current)
    },
    [],
  )

  const questions = item.questions.map(usableQuestion)
  const question = questions[walk.index] ?? questions[questions.length - 1]
  const last = isLastQuestion(walk, questions)
  const ready = currentAnswer(walk) !== null
  const busy = answer.isPending

  const commit = () => {
    if (!ready || busy) return
    const value = currentAnswer(walk)
    if (value === null) return
    if (!last) {
      dispatch({ type: 'commit', question })
      return
    }
    const answers = { ...walk.answers, [question.id]: value }
    // Nothing is written into the transcript here: the `question_answered`
    // frame arrives on the stream and is what marks the card answered. The
    // local note below is only about which request the panel shows next.
    answer.mutate(
      { sessionId, body: { question_id: item.questionId, answers } },
      { onSuccess: () => onAnswered(item.questionId) },
    )
  }

  const pick = (label: string) => {
    dispatch({ type: 'toggle', label, multiSelect: question.multiSelect })
    // Only a single-select question with nothing typed in its "Other" slot
    // auto-advances — a multi-select reader may still be picking, and a
    // half-typed note must not be thrown away.
    if (!autoAdvances(question, last) || walk.freeform.trim() !== '') return
    // Re-selecting the same single-select label clears it; do not advance off
    // an empty selection.
    if (walk.selection[0] === label) return
    if (advanceRef.current !== null) clearTimeout(advanceRef.current)
    // A beat so the ✓ is seen before the question is replaced. Without it the
    // panel appears to skip a question the reader did answer.
    advanceRef.current = setTimeout(() => dispatch({ type: 'commit', question }), CONFIRM_MS)
  }

  return (
    // Matches the composer directly below: a transparent outer band with a
    // self-contained opaque card, rather than a full-width flat bar. The card
    // is what stops the transcript bleeding through a tall question (report
    // body + several option cards) — the reason the old solid backdrop existed,
    // kept without the wide, heavy bar it used to draw.
    <div className="shrink-0 px-4 pt-3 pb-2" data-testid="question-panel">
      <div className="mx-auto w-full max-w-[46rem]">
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-bg px-4 py-3 shadow-card">
          <div className="flex items-baseline gap-2">
            {item.reason ? <p className="min-w-0 flex-1 text-xs text-ink-3">{item.reason}</p> : <span className="flex-1" />}
            {questions.length > 1 ? (
              <span className="shrink-0 text-[11px] text-ink-3">
                {`Question ${walk.index + 1} of ${questions.length}`}
              </span>
            ) : null}
          </div>

          <QuestionBlock
            question={question}
            selected={walk.selection}
            freeform={walk.freeform}
            focused={walk.focused}
            disabled={busy}
            onSelect={pick}
            onFocusOption={(index) => dispatch({ type: 'focus', index })}
            onMoveFocus={(direction) =>
              dispatch({ type: 'moveFocus', direction, total: question.options.length })
            }
            onFreeform={(value) => dispatch({ type: 'freeform', value })}
            onSubmit={commit}
          />

          {answer.isError ? (
            <p role="alert" className="text-xs text-danger">
              {answer.error.message}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {queued > 0 ? (
              <span className="mr-auto text-[11px] text-ink-3">
                {queued === 1 ? '1 more question waiting' : `${queued} more questions waiting`}
              </span>
            ) : null}
            {busy ? <span className="text-xs text-ink-3">Sending…</span> : null}
            <Button variant="primary" size="sm" disabled={!ready || busy} onClick={commit}>
              {last ? 'Answer' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function QuestionBlock({
  question,
  selected,
  freeform,
  focused,
  disabled,
  onSelect,
  onFocusOption,
  onMoveFocus,
  onFreeform,
  onSubmit,
}: {
  question: QuestionSpec
  selected: string[]
  freeform: string
  focused: number
  disabled: boolean
  onSelect: (label: string) => void
  onFocusOption: (index: number) => void
  onMoveFocus: (direction: 1 | -1) => void
  onFreeform: (value: string) => void
  onSubmit: () => void
}) {
  // Single-select is a radio group; multi-select is a set of checkboxes. The
  // reference "Other" free-text slot is always available, so it is rendered
  // unconditionally below the options.
  const optionRole = question.multiSelect ? 'checkbox' : 'radio'
  return (
    <fieldset className="min-w-0">
      <legend className="w-full text-sm text-ink">{question.header ?? question.question}</legend>
      {question.header ? <p className="mt-0.5 text-xs text-ink-2">{question.question}</p> : null}

      {question.options.length > 0 ? (
        <div
          role={question.multiSelect ? 'group' : 'radiogroup'}
          aria-label={question.question}
          className="mt-2 flex flex-col gap-1.5"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            onMoveFocus(event.key === 'ArrowDown' ? 1 : -1)
          }}
        >
          {question.options.map((option, index) => {
            const isSelected = selected.includes(option.label)
            return (
              <button
                key={option.label}
                type="button"
                role={optionRole}
                aria-checked={isSelected}
                // Roving tabindex: one stop for the whole group, arrows inside.
                tabIndex={index === focused ? 0 : -1}
                ref={(node) => {
                  // Focus follows the reducer, so an arrow press moves the real
                  // focus ring and not just a class.
                  if (node !== null && index === focused && node.ownerDocument.activeElement !== node) {
                    const group = node.parentElement
                    if (group !== null && group.contains(node.ownerDocument.activeElement)) node.focus()
                  }
                }}
                disabled={disabled}
                onFocus={() => onFocusOption(index)}
                onClick={() => onSelect(option.label)}
                className={cn(
                  'rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  'outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  isSelected
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-border bg-surface text-ink-2 hover:border-border-strong hover:bg-surface-2',
                )}
              >
                <span className="block font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="mt-0.5 block text-xs text-ink-3">{option.description}</span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <input
        type="text"
        value={freeform}
        disabled={disabled}
        onChange={(event) => onFreeform(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          // IME guard: the Enter that commits a composition is not a submit.
          if (event.nativeEvent.isComposing) return
          event.preventDefault()
          // Stopped so the composer below never sees it.
          event.stopPropagation()
          onSubmit()
        }}
        placeholder={question.options.length > 0 ? 'Or type an answer' : 'Type an answer'}
        aria-label={`Answer for: ${question.question}`}
        className={cn(
          'mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink',
          'placeholder:text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:opacity-60',
        )}
      />
    </fieldset>
  )
}
