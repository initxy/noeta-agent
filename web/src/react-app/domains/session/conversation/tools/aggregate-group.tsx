/**
 * A run of consecutive tool calls, as one line.
 *
 * ```
 * ▸ Edited 3 files, ran 8 commands            2 failed
 *   • Now: npm run typecheck
 * ```
 *
 * This is the readability idea the whole phase is built around. An agent that
 * edits four files and runs eight commands produced twelve rows of true,
 * useless detail; the same run as "Edited 4 files, ran 8 commands" is one fact,
 * and the detail is still there under the chevron. Everything else on the line
 * follows from that:
 *
 * - **the status roll-up is deliberately minimal** — tense, plus "N failed".
 *   No aggregate success badge, no colour, no tint: a run that worked should
 *   read as quiet, and a run that did not should be the only thing that is not;
 * - **the "Now:" line replaces itself** and always shows the *latest* in-flight
 *   call. A list of in-flight rows is the thing the aggregate exists to prevent;
 * - **the expanded list is capped** at `AGGREGATE_ROW_CAP`, with a one-way
 *   "Show N more". One-way because a reader who asked for the rest is reading
 *   them, and collapsing the list under their cursor is not help.
 *
 * Expansion state is local React state keyed by the group's identity (the first
 * call's id) rather than a module-level map. The reference persists it in a
 * global map that is never cleared — expansion survives a session switch, and
 * so does every entry, forever.
 */

import { memo, useState } from 'react'
import {
  AGGREGATE_ROW_CAP,
  aggregateFailures,
  aggregateNowLabel,
  aggregateSummary,
  aggregateTense,
} from '@/app/fold/aggregate'
import type { AggregateGroup } from '@/app/fold/aggregate'
import type { StepItem } from '@/app/fold'
import { Disclosure } from '../disclosure'
import { FailureReason, RunningDot, ToolLine } from './tool-line'

function sameSteps(a: readonly StepItem[], b: readonly StepItem[]): boolean {
  return a.length === b.length && a.every((step, index) => step === b[index])
}

export const AggregateRow = memo(
  function AggregateRow({ group }: { group: AggregateGroup }) {
    const [showAll, setShowAll] = useState(false)

    const tense = aggregateTense(group.steps)
    const failures = aggregateFailures(group.steps)
    const now = aggregateNowLabel(group.steps)

    const visible = showAll ? group.steps : group.steps.slice(0, AGGREGATE_ROW_CAP)
    const hidden = group.steps.length - visible.length

    return (
      <div className="min-w-0" data-tool-aggregate={group.key}>
        <Disclosure
          summary={
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2 text-xs text-ink-2">
                <span className="min-w-0 flex-1 truncate">
                  {aggregateSummary(group.steps, tense)}
                </span>
                {failures > 0 ? (
                  <span className="shrink-0 text-[11px] text-ink-3">{`${failures} failed`}</span>
                ) : null}
              </span>
              {now !== null ? (
                <span className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-ink-3">
                  <RunningDot label={now} />
                  <span className="shrink-0">Now:</span>
                  <span className="min-w-0 truncate font-mono">{now}</span>
                </span>
              ) : null}
            </span>
          }
        >
          <ul className="flex flex-col gap-1.5">
            {visible.map((step) => (
              <li key={step.callId} className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {/* A reserved leading slot, so a running row's dot does not
                      inset its label past the rows around it. */}
                  <span className="inline-flex w-3 shrink-0 items-center justify-center self-center">
                    {step.status === 'running' ? <RunningDot /> : null}
                  </span>
                  <ToolLine step={step} tense={step.status === 'running' ? 'present' : 'past'} />
                </span>
                {step.status === 'failure' ? <FailureReason step={step} /> : null}
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-1 rounded-md text-[11px] text-ink-3 outline-none hover:text-ink-2 focus-visible:ring-2 focus-visible:ring-accent"
            >
              {`Show ${hidden} more`}
            </button>
          ) : null}
        </Disclosure>
      </div>
    )
  },
  // The group object is rebuilt on every fold, so identity would say "changed"
  // on every frame of a live turn. The steps inside it are reused by the fold
  // whenever they did not change, which is what makes this comparison cheap
  // and correct.
  (before, after) =>
    before.group.key === after.group.key && sameSteps(before.group.steps, after.group.steps),
)
