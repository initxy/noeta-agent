/**
 * The work rows: tool calls, memory operations, skill activations, the
 * checklist, and subtasks.
 *
 * All of them are one line until asked otherwise, and every one of those lines
 * is a **sentence** — never a tool name followed by its JSON. A call that could
 * not be said in words is a call the reader cannot follow, and the payload is
 * one click away under "Technical details" for the times that matters.
 *
 * Each row still takes exactly one item and knows nothing about its
 * neighbours: consecutive calls of the four aggregatable families are merged by
 * `app/fold/aggregate` before they get here, so aggregation is a pass over the
 * item list rather than a rule inside a component. Phase 3b's per-tool
 * renderers attach at `StepRow` for the same reason.
 */

import { memo } from 'react'
import type { ReactNode } from 'react'
import type { MemoryItem, SkillItem, StepItem, SubtaskItem, SubtaskStatus } from '@/app/fold'
import { cn } from '@/react-app/design-system'
import { Disclosure } from './disclosure'
import { TechnicalDetails, hasTechnicalDetails } from './tools/technical-details'
import { StepGlyph, ToolLine } from './tools/tool-line'

/**
 * One tool call that did not join an aggregate run.
 *
 * A lone call keeps its own row on purpose: a summary of one thing is not a
 * summary, it is the same row with its detail hidden behind a chevron.
 *
 * **The row itself is the disclosure.** Clicking the sentence (`Read
 * index.html`) opens the raw payload; there is no separate "Technical details"
 * line, because a chevron under a one-line row is a chevron under a chevron.
 * When the call carries nothing to reveal — no arguments, no output — the row
 * stays a plain line rather than a button that opens emptiness.
 */
export const StepRow = memo(function StepRow({ item }: { item: StepItem }) {
  const summary = (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <StepGlyph status={item.status} />
      <ToolLine step={item} className="flex-1" />
    </span>
  )

  if (!hasTechnicalDetails(item)) {
    return (
      <div className="flex min-w-0 flex-col" data-item-kind="step">
        {summary}
      </div>
    )
  }

  return (
    <div className="min-w-0" data-item-kind="step">
      <Disclosure summary={summary}>
        <TechnicalDetails step={item} />
      </Disclosure>
    </div>
  )
})

const MEMORY_VERB: Record<MemoryItem['op'], string> = {
  write: 'Remembered',
  read: 'Read memory',
  search: 'Searched memory',
  archive: 'Archived memory',
}

export const MemoryRow = memo(function MemoryRow({ item }: { item: MemoryItem }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs text-ink-3" data-item-kind="memory">
      <span className="font-medium text-ink-2">{MEMORY_VERB[item.op]}</span>
      <span className="min-w-0 truncate font-mono">{item.name}</span>
    </div>
  )
})

export const SkillRow = memo(function SkillRow({ item }: { item: SkillItem }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs" data-item-kind="skill">
      <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
        Skill
      </span>
      <span className="min-w-0 truncate text-ink-2">{item.skill}</span>
    </div>
  )
})

const SUBTASK_TONE: Record<SubtaskStatus, string> = {
  running: 'text-ink-3',
  completed: 'text-accent',
  failed: 'text-danger',
  cancelled: 'text-ink-3',
}

const SUBTASK_LABEL: Record<SubtaskStatus, string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * A subagent node, with its own work nested inside it.
 *
 * The always-visible line is the node itself — agent, status, goal. Its steps
 * (`children`, already aggregated by the fold) and its answer (`summary`) fold
 * away behind the disclosure, collapsed by default: a subagent is read for the
 * fact that it ran and what it concluded, and its internal steps are available
 * rather than imposed, the same contract a finished turn keeps.
 *
 * With neither steps nor an answer the node is a plain line — a disclosure that
 * opens onto nothing is a chevron under a chevron. A child step that arrived
 * before this anchor, or on a later turn, is rendered inline by the fold and
 * never reaches here, so an empty node is genuinely empty, not a dropped step.
 */
export const SubtaskRow = memo(function SubtaskRow({
  item,
  children,
}: {
  item: SubtaskItem
  children?: ReactNode
}) {
  const summary = (
    <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="shrink-0 font-medium text-ink-2">{item.agentName || 'Subagent'}</span>
      <span className={cn('shrink-0', SUBTASK_TONE[item.status])}>
        {SUBTASK_LABEL[item.status]}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-3">{item.goal}</span>
    </span>
  )

  const hasSummary = item.summary !== null && item.summary !== ''
  if (children == null && !hasSummary) {
    return (
      <div className="py-0.5" data-item-kind="subtask">
        {summary}
      </div>
    )
  }
  return (
    <div className="min-w-0" data-item-kind="subtask">
      <Disclosure summary={summary}>
        {children != null ? <div className="flex min-w-0 flex-col">{children}</div> : null}
        {hasSummary ? (
          // Never clipped by the translator — this is the subtask's answer.
          <div className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-ink-2">
            {item.summary}
          </div>
        ) : null}
      </Disclosure>
    </div>
  )
})
