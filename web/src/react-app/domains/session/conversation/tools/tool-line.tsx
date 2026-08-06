/**
 * One tool call, rendered as a sentence.
 *
 * The sentence is computed in `app/fold/aggregate` and only *typeset* here:
 * the label is prose, a path becomes a chip, a shell command becomes code, a
 * query becomes a quotation. Nothing on this line is ever a raw payload — the
 * arguments and the output live under "Technical details", one click away, for
 * the reader who wants them.
 *
 * That split is what makes an MCP call legible. It arrives as an ordinary tool
 * named `mcp__<alias>__<tool>` carrying an arbitrary JSON object, and printing
 * that object is how a transcript turns into a log file.
 */

import { describeStep } from '@/app/fold/aggregate'
import type { Tense } from '@/app/fold/aggregate'
import type { StepItem, StepStatus } from '@/app/fold'
import { cn } from '@/react-app/design-system'
import { FileChip } from './file-chip'

/** The status glyphs a standalone tool row carries. */
const STEP_GLYPH: Record<StepStatus, string> = {
  running: '◌',
  success: '✓',
  failure: '✕',
  cancelled: '⊘',
}

const STEP_TONE: Record<StepStatus, string> = {
  running: 'text-ink-3',
  success: 'text-accent',
  failure: 'text-danger',
  cancelled: 'text-ink-3',
}

export function StepGlyph({ status }: { status: StepStatus }) {
  return (
    <span
      className={cn('inline-block w-3 shrink-0 text-center', STEP_TONE[status])}
      aria-hidden="true"
    >
      {STEP_GLYPH[status]}
    </span>
  )
}

/**
 * The empty leading cell that keeps a glyphless work row aligned.
 *
 * A `Disclosure` opens with a `w-3` chevron and a `gap-1.5`, and a `StepRow`
 * opens with a `w-3` `StepGlyph`; a row that carries neither (a memory op, a
 * skill activation) reserves the same `w-3` so its label starts on the very
 * column the glyph and chevron rows do, and the whole work stream reads as one
 * left edge rather than a staircase.
 */
export function LeadCell() {
  return <span className="inline-block w-3 shrink-0" aria-hidden="true" />
}

/**
 * The living mark for work in progress.
 *
 * Only running rows carry one. A finished row's status is already in its tense,
 * and a glyph per row turns a run of eight calls into a column of noise.
 */
export function RunningDot({ label }: { label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? 'running'}
      className="size-1.5 shrink-0 animate-pulse self-center rounded-full bg-accent"
    />
  )
}

export function ToolLine({
  step,
  tense,
  className,
}: {
  step: StepItem
  tense?: Tense
  className?: string
}) {
  const line = describeStep(step, tense)

  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5 text-xs', className)}>
      <span className="shrink-0 text-ink-2">{line.label}</span>
      {line.path !== null ? <FileChip path={line.path} /> : null}
      {line.command !== null ? (
        <code className="min-w-0 truncate font-mono text-[11px] text-ink-3">{line.command}</code>
      ) : null}
      {line.quote !== null ? (
        <span className="min-w-0 truncate text-ink-3">{`“${line.quote}”`}</span>
      ) : null}
    </span>
  )
}

/** Characters of a failure reason shown under a row. */
const FAILURE_REASON_CHARS = 120

/**
 * Why a call failed, in one line.
 *
 * The first line only: a stack trace under every failed row would bury the run
 * it belongs to, and the whole error is under "Technical details".
 */
export function FailureReason({ step }: { step: StepItem }) {
  const raw = (step.summary ?? step.output ?? '').trim()
  if (raw === '') return null
  const first = raw.split('\n')[0]
  const reason =
    first.length > FAILURE_REASON_CHARS ? `${first.slice(0, FAILURE_REASON_CHARS - 1)}…` : first
  return <span className="min-w-0 truncate text-[11px] text-danger">{`failed — ${reason}`}</span>
}
