/**
 * Rows that are neither speech nor work: the transcript's record of things that
 * happened *to* the conversation.
 *
 * The question row is a trace, not a control. Answering happens in the panel
 * docked above the composer, because a question blocks the turn and the answer
 * belongs where the user is already typing — but the transcript still has to
 * show that it was asked, or a reloaded conversation has an unexplained gap
 * where a decision was made.
 */

import { memo } from 'react'
import type { ReactNode } from 'react'
import type { CompactionItem, ErrorItem, QuestionItem } from '@/app/fold'

/** A centred hairline with a label — the visual grammar for "meta, not speech". */
function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-ink-3">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export const QuestionRow = memo(function QuestionRow({ item }: { item: QuestionItem }) {
  const first = item.questions[0]
  const state = item.answered ? 'Answered' : item.withdrawn ? 'Cancelled' : 'Waiting'
  return (
    <div
      className="rounded-lg border border-border bg-surface px-3 py-2 text-xs"
      data-item-kind="question"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-medium text-ink-2">Question</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">
          {first ? (first.header ?? first.question) : item.reason}
        </span>
        <span className="shrink-0 text-ink-3">{state}</span>
      </div>
    </div>
  )
})

export const CompactionRow = memo(function CompactionRow({ item }: { item: CompactionItem }) {
  return (
    <Divider>
      {item.replacedCount === 1
        ? 'Compacted 1 earlier message'
        : `Compacted ${item.replacedCount} earlier messages`}
    </Divider>
  )
})

export const ErrorRow = memo(function ErrorRow({ item }: { item: ErrorItem }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-danger"
      data-item-kind="error"
    >
      {item.message}
    </div>
  )
})
