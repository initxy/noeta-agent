/**
 * The client fold: wire frames to something renderable.
 *
 * Two pure reducers, no framework. `conversation` builds the item list — the
 * durable record of what happened — and `delta-buffer` holds the streaming
 * preview, which is explicitly *not* part of that record and is repainted by
 * the durable frame that follows it.
 */

export {
  appendOptimisticUser,
  foldEvent,
  foldEvents,
  initialConversationState,
} from './conversation'
export type { ConversationState } from './conversation'

export { applyDelta, renderDeltaBlocks, resetCall } from './delta-buffer'
export type { DeltaBlock, DeltaState } from './delta-buffer'

export {
  AGGREGATE_ROW_CAP,
  buildTurns,
  capToolOutput,
  formatDuration,
  itemTimeMs,
  toolFamily,
} from './aggregate'
export type { AggregateGroup, StepLine, ToolFamily, TurnBlock, TurnOptions, TurnRow } from './aggregate'

export type {
  AssistantItem,
  CompactionItem,
  ConversationItem,
  ErrorItem,
  MemoryItem,
  QuestionItem,
  RecallItem,
  SkillItem,
  StepItem,
  StepStatus,
  SubtaskItem,
  SubtaskStatus,
  ThinkingItem,
  TodosItem,
  TurnOutcome,
  UserItem,
} from './items'
