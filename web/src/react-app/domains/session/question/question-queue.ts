/**
 * The question queue and the walk through one request.
 *
 * Two nested sequences, and conflating them is the bug this module exists to
 * prevent.
 *
 * **The queue** is requests. The engine can raise more than one
 * `UserQuestionRequested` before any of them is answered — a subtask asking
 * while the root is already parked, most obviously — and each is answered by
 * its own `question_id`. Exactly one is shown; answering it hands the slot to
 * the next. Showing two at once would let the second be answered first, and the
 * backend 409s anything sent while a question is pending, so the "race" is not
 * a rendering glitch: it is a request that can never be delivered.
 *
 * **The walk** is the questions inside one request. They are asked one at a
 * time with a counter, and the answers are submitted together, keyed by
 * question id — the contract's `answers` map, in question order.
 *
 * Pure. The panel is then a rendering of this, which is what makes "the queue
 * answers in order" a property with a test rather than a claim about a
 * component.
 *
 * The answer shape is the SDK's 0.6.x reference contract: each answer is
 * `{selected: [labels...], other}` — the labels the reader picked (at most one
 * unless the question sets `multiSelect`) plus an always-available free-text
 * "Other" slot. Options carry no id; they are identified by their label.
 */

import type { ConversationState, QuestionItem } from '@/app/fold'
import type { AnswerValue, QuestionSpec } from '@/app/types'

/**
 * A question with its unusable options removed.
 *
 * An option needs a non-empty label to be pickable at all, and a duplicate
 * label is ambiguous on the wire (the answer names labels, so two identical
 * ones cannot be told apart). Either one degrades that single option; the
 * question keeps its other options and its free-text slot, so a malformed
 * option never dead-ends the turn.
 */
export function usableQuestion(question: QuestionSpec): QuestionSpec {
  const seen = new Set<string>()
  const options = question.options.filter((option) => {
    if (option.label === '' || seen.has(option.label)) return false
    seen.add(option.label)
    return true
  })
  if (options.length === question.options.length) return question
  return { ...question, options }
}

/**
 * Every request still waiting, oldest first.
 *
 * Read off the item list rather than off `pendingQuestionId`, which holds one
 * id and is overwritten by the newer request — the older one would silently
 * stop being answerable. An answered or withdrawn request has left the queue —
 * withdrawn is the 0.6.2 Stop-on-question landing, and skipping it is what
 * clears the panel. `submitted` carries the ids this client has already
 * answered but whose `question_answered` frame has not landed yet, so the next
 * request appears the moment the answer is accepted instead of a round trip
 * later.
 */
export function questionQueue(
  conversation: ConversationState,
  submitted: ReadonlySet<string> = new Set(),
): QuestionItem[] {
  const seen = new Set<string>()
  const queue: QuestionItem[] = []
  for (const item of conversation.items) {
    if (item.kind !== 'question') continue
    if (item.answered || item.withdrawn || submitted.has(item.questionId) || seen.has(item.questionId))
      continue
    seen.add(item.questionId)
    queue.push(item)
  }
  return queue
}

/** The state of walking one request's questions. */
export interface WalkState {
  /** Which question of the request is on screen. */
  index: number
  /** Completed answers, by question id. */
  answers: Record<string, AnswerValue>
  /** The labels picked for the current question. */
  selection: string[]
  /** Text typed into the current question's "Other" slot. */
  freeform: string
  /** Which option has keyboard focus, for arrow navigation. */
  focused: number
}

export type WalkAction =
  | { type: 'toggle'; label: string; multiSelect: boolean }
  | { type: 'freeform'; value: string }
  | { type: 'focus'; index: number }
  | { type: 'moveFocus'; direction: 1 | -1; total: number }
  | { type: 'commit'; question: QuestionSpec }

export function initialWalk(): WalkState {
  return { index: 0, answers: {}, selection: [], freeform: '', focused: 0 }
}

/**
 * The answer the current question would submit, or null while it has none.
 *
 * Both halves can be present: a chosen option with a note beside it in the
 * "Other" slot is a legal answer. `null` only when neither a label is picked
 * nor any text is typed — the one state the engine rejects.
 */
export function currentAnswer(state: WalkState): AnswerValue | null {
  const typed = state.freeform.trim()
  const hasSelection = state.selection.length > 0
  if (!hasSelection && typed === '') return null
  const answer: AnswerValue = {}
  if (hasSelection) answer.selected = [...state.selection]
  answer.other = typed === '' ? null : typed
  return answer
}

export function questionWalk(state: WalkState, action: WalkAction): WalkState {
  switch (action.type) {
    case 'toggle': {
      // Multi-select toggles the label in/out of the set; single-select
      // replaces the set with the one label (re-clicking it clears it).
      if (action.multiSelect) {
        const selection = state.selection.includes(action.label)
          ? state.selection.filter((label) => label !== action.label)
          : [...state.selection, action.label]
        return { ...state, selection }
      }
      const selection = state.selection[0] === action.label ? [] : [action.label]
      return { ...state, selection }
    }
    case 'freeform':
      return { ...state, freeform: action.value }
    case 'focus':
      return state.focused === action.index ? state : { ...state, focused: action.index }
    case 'moveFocus': {
      if (action.total <= 0) return state
      const next = (state.focused + action.direction + action.total) % action.total
      return next === state.focused ? state : { ...state, focused: next }
    }
    case 'commit': {
      const answer = currentAnswer(state)
      if (answer === null) return state
      return {
        index: state.index + 1,
        answers: { ...state.answers, [action.question.id]: answer },
        selection: [],
        freeform: '',
        focused: 0,
      }
    }
  }
}

/**
 * Whether a request is fully answered once the current question is committed.
 * The panel submits at exactly that point and never before.
 */
export function isLastQuestion(state: WalkState, questions: readonly QuestionSpec[]): boolean {
  return state.index >= questions.length - 1
}

/**
 * Should picking an option move straight on?
 *
 * Only a single-select question that is not the last may auto-advance, and even
 * then the panel holds off while the "Other" slot has text in it. Multi-select
 * never auto-advances — the reader may still be picking. Auto-advancing off the
 * last question would submit the whole request on a single click, which is not
 * a thing to do to a reader who mis-clicked.
 */
export function autoAdvances(question: QuestionSpec, last: boolean): boolean {
  return !last && !question.multiSelect
}
