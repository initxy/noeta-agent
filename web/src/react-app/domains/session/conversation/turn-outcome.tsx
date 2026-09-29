/**
 * How the last turn ended, when that is something the user has to act on.
 *
 * This component exists for one rule, and the rule is the reason the product
 * was rebuilt: **a parked turn is not a dead session.**
 *
 * - `interrupted` — the user stopped it. The conversation is intact and the
 *   next ordinary message resumes the same task with full context.
 * - `turn_failed` — the provider failed (a 5xx, a timeout). 0.5.0 parks the
 *   turn instead of sealing the ledger, so this renders as a retriable error
 *   *inside* the conversation, with the composer enabled. Resuming is an
 *   ordinary send; there is no special retry verb. Before that change a single
 *   gateway hiccup cost the user the whole conversation, and rendering this as
 *   fatal would hand that back.
 *
 * Neither disables anything. `composerState` derives the composer's enablement
 * from `running` and `pendingQuestionId` alone, so a notice here can never
 * lock the input by accident.
 *
 * The two genuinely terminal outcomes — `cancelled` and `failed` — say so, and
 * point at the one way forward that still exists: branch at an earlier message
 * and carry on there. That is `fork`, and it is why the product ships it.
 *
 * **Phase 3 moves this inside the turn block** it describes, instead of at the
 * foot of the transcript. It takes one outcome and renders one notice, so that
 * move is a change of mount point and nothing else.
 */

import type { ReactNode } from 'react'
import type { TurnOutcome } from '@/app/fold'

export function TurnOutcomeNotice({
  outcome,
  running,
}: {
  outcome: TurnOutcome | null
  running: boolean
}) {
  // A new turn has started; whatever the last one did is history.
  if (running || outcome === null) return null

  switch (outcome.status) {
    case 'interrupted':
      return (
        <Notice status="interrupted">
          Stopped. <span className="text-ink-3">Send a message to pick up from here.</span>
        </Notice>
      )
    case 'turn_failed':
      return (
        <div
          role="status"
          data-testid="turn-outcome"
          data-outcome="turn_failed"
          className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs leading-relaxed text-warn"
        >
          <div className="font-medium">The turn did not finish.</div>
          {outcome.reason ? (
            <div className="mt-0.5 whitespace-pre-wrap opacity-90">{outcome.reason}</div>
          ) : null}
          <div className="mt-1 text-ink-3">
            Send a message to retry — the conversation keeps its full context.
          </div>
        </div>
      )
    case 'cancelled':
      // Kept as its own text node: `cancel` is terminal and the next message
      // is refused, so the way forward is a branch rather than a retry.
      return (
        <>
          <Notice status="cancelled">Cancelled.</Notice>
          <ClosedHint />
        </>
      )
    case 'failed':
      // The `error` frame that precedes this one has already rendered the
      // message; repeating it here would say the same thing twice.
      return (
        <>
          <Notice status="failed">This turn ended with an error.</Notice>
          <ClosedHint />
        </>
      )
    case 'awaiting_input':
    case 'completed':
      return null
  }
}

function Notice({ children, status }: { children: ReactNode; status: string }) {
  return (
    <div className="py-0.5 text-xs text-ink-2" data-testid="turn-outcome" data-outcome={status}>
      {children}
    </div>
  )
}

/**
 * What is left after a terminal turn.
 *
 * Deliberately not a button: the fork affordance lives on the message being
 * branched at, because a fork needs an anchor and "somewhere earlier" is not
 * one. This points at it.
 */
function ClosedHint() {
  return (
    <div className="py-0.5 text-xs text-ink-3">
      This conversation is closed. Use <span className="text-ink-2">Edit &amp; retry</span> on an
      earlier message to fork a new session from there — it shares the project directory.
    </div>
  )
}
