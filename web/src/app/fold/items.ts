/**
 * The renderable item vocabulary.
 *
 * This is the boundary where the wire's `snake_case` stops. Wire types
 * (`app/types`) describe bytes; these describe what a conversation is made of.
 * Keeping them apart means a renderer never reads `_task` or `call_id`, and a
 * later contract addition changes one file rather than every component.
 *
 * Payloads that pass through untouched — todos, question specs, image refs —
 * keep their wire types and therefore their wire field names. Re-spelling a
 * structure the fold does not interpret would be noise with a translation bug
 * waiting inside it.
 */

import type { ImageRef, MemoryOp, QuestionSpec, Todo, TurnStatus } from '../types/ui-events'

/**
 * A tool step's lifecycle.
 *
 * `cancelled` is not a status the wire ever sends: it is what the fold writes
 * onto a step that was still running when its turn was cancelled, because a
 * cancelled tool never gets a paired result and would otherwise spin forever.
 */
export type StepStatus = 'running' | 'success' | 'failure' | 'cancelled'

export type SubtaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

interface ItemBase {
  /**
   * The render key: the frame's `seq` when it had one, otherwise a negative
   * number from a monotonically decreasing counter. Synthetic frames can
   * therefore never collide with a real seq, which is what lets an optimistic
   * bubble and its durable replacement coexist for the moment they overlap.
   *
   * Unique within one task stream, which is the unit the item list covers.
   */
  key: number
  /** The task stream this item belongs to; null for session-level frames. */
  taskId: string | null
  /**
   * The server clock the source frame carried, in epoch **seconds**.
   *
   * Optional, because it is optional on the wire and absent on every synthetic
   * frame. It is what makes "Worked for 1m 35s" the same line before and after
   * a reload; without it the fold falls back to a step count. An item keeps the
   * clock it was created with — a step's `ts` is when it started, which is what
   * the turn's duration measures from.
   */
  ts?: number
}

export interface UserItem extends ItemBase {
  kind: 'user'
  content: string
  images: ImageRef[]
  /** True while this is the optimistic echo, before the durable frame lands. */
  pending: boolean
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant'
  text: string
}

export interface ThinkingItem extends ItemBase {
  kind: 'thinking'
  text: string
}

/** Auto-recall. Renders as a "recalled" chip — never as something the user said. */
export interface RecallItem extends ItemBase {
  kind: 'recall'
  text: string
}

export interface StepItem extends ItemBase {
  kind: 'step'
  callId: string
  toolName: string
  /** Whatever the model produced. Renderers decide how much of it to show. */
  args: unknown
  status: StepStatus
  summary: string | null
  output: string | null
  /** Set when the step ran inside a subtask rather than on the main stream. */
  subtaskId: string | null
}

export interface MemoryItem extends ItemBase {
  kind: 'memory'
  callId: string
  op: MemoryOp
  name: string
}

export interface SkillItem extends ItemBase {
  kind: 'skill'
  skill: string
}

export interface TodosItem extends ItemBase {
  kind: 'todos'
  todos: Todo[]
}

export interface SubtaskItem extends ItemBase {
  kind: 'subtask'
  subtaskId: string
  agentName: string
  goal: string
  status: SubtaskStatus
  summary: string | null
}

export interface QuestionItem extends ItemBase {
  kind: 'question'
  questionId: string
  reason: string
  questions: QuestionSpec[]
  answered: boolean
  /** Stopped without an answer (0.6.2 interrupt-on-question). Mutually
   *  exclusive with `answered`: a question ends exactly one way. */
  withdrawn: boolean
}

export interface CompactionItem extends ItemBase {
  kind: 'compaction'
  replacedCount: number
}

export interface ErrorItem extends ItemBase {
  kind: 'error'
  message: string
}

export type ConversationItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | RecallItem
  | StepItem
  | MemoryItem
  | SkillItem
  | TodosItem
  | SubtaskItem
  | QuestionItem
  | CompactionItem
  | ErrorItem

/** How the last turn ended. `turn_failed` is resumable; `failed` is not. */
export interface TurnOutcome {
  status: TurnStatus
  reason: string | null
}
