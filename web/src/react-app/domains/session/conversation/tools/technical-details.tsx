/**
 * Where the raw payload lives.
 *
 * Every rule about the transcript above this point — sentences instead of JSON,
 * chips instead of paths, one line instead of a run — is only affordable
 * because nothing is lost: the arguments, the output and the ids are always one
 * click away, on every tool. A reader who is debugging their agent expands the
 * row; a reader following a conversation never has to.
 *
 * **There is no "Technical details" summary line of its own.** The tool row *is*
 * the disclosure — clicking the sentence (`Read index.html`) opens the payload
 * beneath it — so the payload here is the disclosure's *body* and nothing else.
 * A second summary under a one-line row was a chevron under a chevron.
 *
 * Output is capped before it is rendered. The interaction reference leaves
 * shell output in an unbounded, unscrolled block, which is how one `find /`
 * makes a conversation unreadable — see `capToolOutput`.
 */

import { capToolOutput } from '@/app/fold/aggregate'
import type { StepItem } from '@/app/fold'
import { PayloadBlock } from '../disclosure'

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    // A model can produce anything; a transcript row is not the place to find
    // out that it produced something unserializable.
    return String(value)
  }
}

function outputNote(hiddenLines: number, clipped: boolean): string | null {
  if (hiddenLines > 0) return `… ${hiddenLines} more lines not shown`
  return clipped ? '… output clipped' : null
}

/**
 * Whether a step has anything to reveal. A row with no arguments and no output
 * is not made a button — a control that opens nothing is worse than a label.
 */
export function hasTechnicalDetails(step: StepItem): boolean {
  const hasArgs = step.args !== undefined && step.args !== null
  const hasOutput = step.output !== null && step.output !== ''
  return hasArgs || hasOutput
}

/** The raw payload itself: the ids, the arguments, the (capped) output. */
export function TechnicalDetails({ step }: { step: StepItem }) {
  const hasArgs = step.args !== undefined && step.args !== null
  const hasOutput = step.output !== null && step.output !== ''
  const output = hasOutput ? capToolOutput(step.output as string) : null

  return (
    <>
      <div className="font-mono text-[10px] break-all text-ink-3">
        {step.toolName} · {step.callId}
      </div>
      {hasArgs ? <PayloadBlock label="Arguments" body={safeJson(step.args)} /> : null}
      {output !== null ? (
        <PayloadBlock
          label="Output"
          body={output.text}
          note={outputNote(output.hiddenLines, output.clipped)}
        />
      ) : null}
    </>
  )
}
