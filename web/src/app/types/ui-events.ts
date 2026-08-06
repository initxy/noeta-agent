/**
 * The UI-event vocabulary carried by the session SSE stream.
 *
 * These are wire shapes, hand-derived from the frozen wire contract. The
 * backend translates one engine envelope into zero or more of these frames;
 * this file is the client half of that agreement and nothing here may be
 * changed unilaterally.
 *
 * Two structural facts drive the shape of this module:
 *
 * 1. **A frame's `seq` may be `null`.** Durable frames carry the seq of the
 *    envelope they were derived from and are replayable; synthetic frames
 *    (`delta`, `replay_done`, `session_meta`, the cascade frames on a subtask
 *    stream) carry no seq, are never replayed, and must never advance the
 *    resume cursor.
 * 2. **A later phase may add a frame type without a protocol bump.** So the
 *    union below is exhaustive over what *this build* understands, and
 *    everything off the wire arrives as `RawUIEvent` first — an unknown type
 *    is a value this client can hold and ignore, never a crash.
 */

/**
 * The task-stream tag every frame's `data` carries.
 *
 * A session owns one or more task streams (`fork` mints siblings inside one
 * session), so a frame without this tag is session-level and reaches every
 * consumer regardless of the active `?task_id=` filter.
 */
export interface TaskScope {
  _task?: string
}

/**
 * A durable frame's `data`: the task tag plus the server's clock.
 *
 * `ts` is the source envelope's `occurred_at` in epoch **seconds** — optional
 * by contract, so a consumer that does not find it must degrade rather than
 * fail. It exists because a finished turn folds behind "Worked for 1m 35s",
 * and a duration measured by a browser stopwatch restarts at every reload; the
 * label has to be re-derived from the log like everything else on the screen.
 *
 * Synthetic frames extend `TaskScope` and not this: no envelope produced them,
 * so they have no clock to carry.
 */
export interface DurableScope extends TaskScope {
  ts?: number
}

/** An image attached to a user message. Bytes never travel the stream. */
export interface ImageRef {
  /** Content hash; fetch the bytes from `GET /api/v1/content/{hash}`. */
  hash: string
  media_type: string
}

export interface UserMessageData extends DurableScope {
  content: string
  /** Attached only when non-empty — a text-only turn has no `images` key. */
  images?: ImageRef[]
}

export interface TextData extends DurableScope {
  text: string
}

export interface ToolCallData extends DurableScope {
  call_id: string
  tool_name: string
  /** Whatever the model produced; deliberately not narrowed. */
  arguments: unknown
  /** Present only on a subtask stream's frames. */
  subtask_id?: string
}

export interface ToolResultData extends DurableScope {
  call_id: string
  success: boolean
  summary: string
  /** Clipped by the translator; the raw output lives in the trace surface. */
  output: string
  subtask_id?: string
}

export type MemoryOp = 'write' | 'read' | 'search' | 'archive'

export interface MemoryOpData extends DurableScope {
  call_id: string
  op: MemoryOp
  /** The object of the operation: the query for a search, the name otherwise. */
  name: string
}

export interface SkillActivatedData extends DurableScope {
  skill: string
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  id: string
  content: string
  status: TodoStatus
}

export interface TodoUpdateData extends DurableScope {
  todos: Todo[]
}

export interface SubtaskStartedData extends DurableScope {
  subtask_id: string
  agent_name: string
  goal: string
}

export type SubtaskOutcome = 'completed' | 'failed' | 'cancelled'

export interface SubtaskFinishedData extends DurableScope {
  subtask_id: string
  status: SubtaskOutcome
  /** The subtask's answer — never clipped. */
  summary: string
}

export interface OptionSpec {
  label: string
  description?: string
}

export interface QuestionSpec {
  id: string
  question: string
  header?: string
  options: OptionSpec[]
  multiSelect: boolean
}

export interface QuestionData extends DurableScope {
  question_id: string
  reason: string
  questions: QuestionSpec[]
}

export interface QuestionAnsweredData extends DurableScope {
  question_id: string
}

export interface QuestionWithdrawnData extends DurableScope {
  question_id: string
}

export interface CompactionData extends DurableScope {
  replaced_count: number
}

/**
 * `rewind` re-bases the stream to before the user message at `target_seq`.
 *
 * A durable frame (it carries the real seq of the engine's `TaskRewound`
 * marker, the highest on the stream). The client folds it into a truncation:
 * every item keyed past `target_seq` is dropped, and the conversation lands
 * back at that turn boundary, live. The workspace file restore is the engine's
 * server-side half and has no wire payload.
 */
export interface RewindData extends DurableScope {
  target_seq: number
}

export interface LlmRetryData extends DurableScope {
  call_id: string
}

/** `turn_started` and `replay_done` carry no payload beyond the task tag. */
export type TurnStartedData = DurableScope

/**
 * `turn_failed` is **resumable** and `failed` is not. That distinction is the
 * whole point of the 0.5.x suspend rework: a provider 5xx parks the turn
 * instead of sealing the ledger, so the composer stays enabled and the next
 * ordinary message resumes the same task with full context.
 */
export type TurnStatus =
  | 'awaiting_input'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'turn_failed'

export interface TurnFinishedData extends DurableScope {
  status: TurnStatus
  /** The parsed suspend detail, present on `turn_failed`. */
  reason?: string
}

export interface ErrorData extends DurableScope {
  message: string
}

export type DeltaKind = 'text' | 'thinking'

export interface DeltaData extends TaskScope {
  call_id: string
  kind: DeltaKind
  text: string
  index: number
}

export type ReplayDoneData = TaskScope

export interface SessionMetaData extends TaskScope {
  title: string
}

/**
 * One frame on the wire.
 *
 * `seq` is `null` for every synthetic frame, and for every frame produced on a
 * subtask stream — a subtask counts seq independently of its parent, so
 * carrying it would collide with the parent-stream dedup and silently swallow
 * root events.
 */
export interface UIEventFrame<T extends string, D> {
  seq: number | null
  type: T
  data: D
}

export type UserMessageEvent = UIEventFrame<'user_message', UserMessageData>
export type AssistantTextEvent = UIEventFrame<'assistant_text', TextData>
export type ThinkingEvent = UIEventFrame<'thinking', TextData>
/** Auto-recall, recorded as an `origin="memory"` message. Never the user's words. */
export type RecallEvent = UIEventFrame<'recall', TextData>
export type ToolCallEvent = UIEventFrame<'tool_call', ToolCallData>
export type ToolResultEvent = UIEventFrame<'tool_result', ToolResultData>
export type MemoryOpEvent = UIEventFrame<'memory_op', MemoryOpData>
export type SkillActivatedEvent = UIEventFrame<'skill_activated', SkillActivatedData>
export type TodoUpdateEvent = UIEventFrame<'todo_update', TodoUpdateData>
export type SubtaskStartedEvent = UIEventFrame<'subtask_started', SubtaskStartedData>
export type SubtaskFinishedEvent = UIEventFrame<'subtask_finished', SubtaskFinishedData>
export type QuestionEvent = UIEventFrame<'question', QuestionData>
export type QuestionAnsweredEvent = UIEventFrame<'question_answered', QuestionAnsweredData>
export type QuestionWithdrawnEvent = UIEventFrame<'question_withdrawn', QuestionWithdrawnData>
export type CompactionEvent = UIEventFrame<'compaction', CompactionData>
export type RewindEvent = UIEventFrame<'rewind', RewindData>
/** Renders nothing; its only job is clearing the delta buffer for that call. */
export type LlmRetryEvent = UIEventFrame<'llm_retry', LlmRetryData>
export type TurnStartedEvent = UIEventFrame<'turn_started', TurnStartedData>
export type TurnFinishedEvent = UIEventFrame<'turn_finished', TurnFinishedData>
export type ErrorEvent = UIEventFrame<'error', ErrorData>
export type DeltaEvent = UIEventFrame<'delta', DeltaData>
export type ReplayDoneEvent = UIEventFrame<'replay_done', ReplayDoneData>
export type SessionMetaEvent = UIEventFrame<'session_meta', SessionMetaData>

/** Every frame type this build understands. Exhaustive by construction. */
export type UIEvent =
  | UserMessageEvent
  | AssistantTextEvent
  | ThinkingEvent
  | RecallEvent
  | ToolCallEvent
  | ToolResultEvent
  | MemoryOpEvent
  | SkillActivatedEvent
  | TodoUpdateEvent
  | SubtaskStartedEvent
  | SubtaskFinishedEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | QuestionWithdrawnEvent
  | CompactionEvent
  | RewindEvent
  | LlmRetryEvent
  | TurnStartedEvent
  | TurnFinishedEvent
  | ErrorEvent
  | DeltaEvent
  | ReplayDoneEvent
  | SessionMetaEvent

export type UIEventType = UIEvent['type']

/**
 * A frame as it comes off the wire, before it is recognised.
 *
 * The wire may legally carry a `type` this build has never heard of, so the
 * boundary between "bytes" and "the union above" is a real step rather than a
 * cast at the fetch site. Everything downstream that must not crash on an
 * unknown frame takes `RawUIEvent`; everything that renders takes `UIEvent`.
 */
export interface RawUIEvent {
  seq: number | null
  type: string
  data: Record<string, unknown>
}

/**
 * Every known type, as a runtime set.
 *
 * Spelled out rather than derived, because the union above is erased at
 * compile time and the recognition step needs a value. The two are kept in
 * step by `UIEventType` on the const: adding a union member without adding it
 * here fails the typecheck.
 */
export const UI_EVENT_TYPES: readonly UIEventType[] = [
  'user_message',
  'assistant_text',
  'thinking',
  'recall',
  'tool_call',
  'tool_result',
  'memory_op',
  'skill_activated',
  'todo_update',
  'subtask_started',
  'subtask_finished',
  'question',
  'question_answered',
  'question_withdrawn',
  'compaction',
  'rewind',
  'llm_retry',
  'turn_started',
  'turn_finished',
  'error',
  'delta',
  'replay_done',
  'session_meta',
]

const KNOWN_TYPES = new Set<string>(UI_EVENT_TYPES)

export function isUIEventType(value: string): value is UIEventType {
  return KNOWN_TYPES.has(value)
}

/**
 * Recognise a wire frame, or `null` when this build does not know its type.
 *
 * The cast is deliberate and is the only one in the layer: the frame's `type`
 * is checked against the known set, and the `data` shape is then trusted
 * because it is the backend's half of a frozen contract. Validating every
 * field would buy nothing a contract test does not already buy, and would
 * turn every future optional field into a client-side rejection.
 */
export function asUIEvent(raw: RawUIEvent): UIEvent | null {
  return isUIEventType(raw.type) ? (raw as unknown as UIEvent) : null
}
