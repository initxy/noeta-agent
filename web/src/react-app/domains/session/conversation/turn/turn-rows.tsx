/**
 * One row of a turn, whatever kind it is.
 *
 * The dispatch is deliberately dumb: `app/fold/aggregate` decided what the rows
 * *are*, including which consecutive calls became one aggregate line, and this
 * only picks the component. Keeping the decision in the pure layer is what lets
 * every aggregation rule be tested without mounting anything, and it is why
 * adding a per-tool renderer (Phase 3b) is a change to one branch here rather
 * than to the grouping.
 */

import type { TurnRow } from '@/app/fold/aggregate'
import type { ConversationItem } from '@/app/fold'
import { AssistantRow, RecallRow, UserRow } from '../message-rows'
import { CompactionRow, ErrorRow, QuestionRow } from '../notice-rows'
import { MemoryRow, SkillRow, StepRow, SubtaskRow } from '../step-rows'
import { AggregateRow } from '../tools/aggregate-group'

export function ItemRow({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'assistant':
      return <AssistantRow item={item} />
    case 'thinking':
      // Reasoning is lifted out of the row stream by the fold and rendered as
      // one collected `ThinkingGroup` inside the process container, so it never
      // reaches this dispatch. The case stays for exhaustiveness.
      return null
    case 'recall':
      return <RecallRow item={item} />
    case 'step':
      return <StepRow item={item} />
    case 'memory':
      return <MemoryRow item={item} />
    case 'skill':
      return <SkillRow item={item} />
    case 'todos':
      // The plan is not a step-stream row anymore: it is hoisted out of the
      // process fold into the persistent `TodoStrip` above the composer, so it
      // stays in view instead of scrolling away. Rendering nothing here keeps
      // the fold from carrying a stale copy of it.
      return null
    case 'subtask':
      return <SubtaskRow item={item} />
    case 'question':
      return <QuestionRow item={item} />
    case 'compaction':
      return <CompactionRow item={item} />
    case 'error':
      return <ErrorRow item={item} />
  }
}

export function TurnRows({ rows }: { rows: readonly TurnRow[] }) {
  return rows.map((row) => {
    if (row.kind === 'aggregate') return <AggregateRow key={row.key} group={row.group} />
    if (row.kind === 'subtask-group') {
      return (
        <SubtaskRow key={row.key} item={row.subtask}>
          {row.children.length > 0 ? <TurnRows rows={row.children} /> : null}
        </SubtaskRow>
      )
    }
    return <ItemRow key={row.key} item={row.item} />
  })
}
