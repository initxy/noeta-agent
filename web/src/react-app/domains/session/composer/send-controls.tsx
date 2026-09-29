/**
 * The right-hand control cluster: the state table in `state/send-state.ts`
 * made visible.
 *
 * - **Idle renders exactly one control.** A Run pill and nothing else, because
 *   a surface with nothing running has nothing to stop, and every extra control
 *   there is a control the user has to rule out.
 * - **Running with an empty box renders Stop alone.** A greyed-out Send beside
 *   it was a control offering nothing — there is no message to steer with — so
 *   it is not drawn at all until there is something to send. Typing brings it
 *   in.
 * - **Running with a draft renders Stop and Send**: an outline Stop, kept
 *   visually apart from Send so a hurried click cannot hit it by accident, and
 *   a primary Send that steers the running turn.
 * - **A pending question renders a disabled Send.** Here the button *is* drawn
 *   even though it cannot fire, because the reason is not "nothing to send" but
 *   "answer the question first" — a visible, disabled Send with that hint
 *   beside it is the signal; a vanished one would read as a lost draft.
 * - **The primary segment never becomes Stop.** See the machine's docstring.
 *
 * Sending into a running turn *steers* it — the agent adjusts mid-turn — which
 * is the whole of what Send does here. There is no "queue for later": a message
 * typed while the agent works is an instruction for the run in flight.
 */

import { Button } from '@/react-app/design-system'
import type { SendState } from '../state/send-state'

function StopGlyph() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5 fill-current">
      <rect x="0" y="0" width="10" height="10" rx="1.5" />
    </svg>
  )
}

export function SendControls({
  state,
  onRun,
  onSteer,
  onStop,
}: {
  state: SendState
  onRun: () => void
  onSteer: () => void
  onStop: () => void
}) {
  if (state.mode === 'idle') {
    return (
      <Button variant="primary" size="sm" disabled={!state.canRun} onClick={onRun}>
        Run
      </Button>
    )
  }

  // Drawn when there is a draft to steer with, or when a question is blocking a
  // draft the user already typed. Not drawn for an empty box mid-run: an
  // always-present, usually-disabled Send is a control that spends most of its
  // life offering nothing.
  const showSend = state.canSteer || state.phase === 'waiting'

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button variant="outline" size="sm" onClick={onStop} disabled={!state.canStop}>
        <StopGlyph />
        Stop
      </Button>
      {showSend ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!state.canSteer}
          title="Send now — the agent will adjust mid-turn"
          onClick={onSteer}
        >
          Send
        </Button>
      ) : null}
    </div>
  )
}
