/**
 * The composer's send-state machine: what the control cluster offers, and what
 * it says while it withholds something.
 *
 * A pure function over the conversation state because this is the rule the
 * whole 0.5.x rework exists to fix, and it has to be checkable without
 * mounting anything:
 *
 * > **`interrupted` and `turn_failed` are resumable.** A stopped turn and a
 * > provider 5xx park the conversation; they do not seal it. Both leave the
 * > composer **enabled**, and the next ordinary message resumes the same task
 * > with full context. Rendering either as a dead session is the defect this
 * > product was rebuilt to remove.
 *
 * Nothing here reads `turn_finished` directly. The fold has already turned it
 * into `running` / `pendingQuestionId`, and a second reading of the same frame
 * is a second place for the two to disagree.
 *
 * ## The table
 *
 * | mode | Run | Stop | Send (steer) | model/effort |
 * | --- | --- | --- | --- | --- |
 * | `idle`     | the only control | — | — | enabled |
 * | `busy`     | — | yes | with a draft | enabled |
 * | `steering` | — | yes | with a draft | **disabled** |
 *
 * Three shapes, and each one is a decision rather than a rendering detail:
 *
 * 1. **The primary control never becomes Stop.** While the agent works the
 *    common intent is "add more instruction", not "kill the run", so Stop is a
 *    separate outline control and Send keeps its place. A primary button that
 *    changes meaning under the cursor is how a steer becomes an abort.
 * 2. **Steering only ever differs from busy by freezing the pickers.** Swapping
 *    the model underneath an in-flight run is the one thing a steer must not
 *    do; everything else about busy stays true, which is why `steering` is a
 *    sub-state and not a fourth mode with its own affordances.
 * 3. **`waiting` withholds the steer.** A pending question makes the backend
 *    409 any message, so offering Send would be offering an error; the steer is
 *    withheld until the question is answered and the turn parks.
 */

import type { ConversationState } from '@/app/fold'

/**
 * `waiting` outranks `running` because a question is a *specific* reason the
 * turn is parked and the user can act on it, while `running` is a state they
 * can only wait out.
 */
export type ComposerPhase = 'idle' | 'sending' | 'running' | 'waiting'

/**
 * The shape of the control cluster. `busy` and `steering` share every
 * affordance; they differ only in whether the model/effort pickers are live.
 */
export type SendMode = 'idle' | 'busy' | 'steering'

export interface SendStateInput {
  conversation: ConversationState
  /** A send is in flight and the server has not spoken yet. */
  sending: boolean
  draft: string
  /**
   * The user sent into a turn that was already running, and that turn has not
   * ended yet. Held by the caller because it is a fact about an action, not
   * about the stream.
   */
  steering: boolean
}

export interface SendState {
  phase: ComposerPhase
  mode: SendMode
  /** The single idle pill: start a turn. */
  canRun: boolean
  /** The split button's primary segment. Literally the same send as `canRun`. */
  canSteer: boolean
  /** The outline Stop. Never gated on the draft — stopping is not sending. */
  canStop: boolean
  /** Model and effort. Disabled on `steering`, **never** on plain `busy`. */
  selectorsEnabled: boolean
  /** A one-line explanation of what the composer is doing, or null when idle. */
  hint: string | null
}

const HINTS: Record<Exclude<ComposerPhase, 'idle'>, string> = {
  sending: 'Sending…',
  // Overridden for `running` below: the line depends on whether there is a
  // draft, because a Send button is only present when there is one.
  running: 'Working. Type to steer it, or stop the turn.',
  waiting: 'Answer the question above to continue.',
}

/**
 * What the composer says while a turn runs.
 *
 * With a draft the Send button is on screen and steers, so the line names it;
 * with an empty box there is no Send to name — typing is what brings it in — so
 * the line says that instead. A hint that mentions a button the user cannot see
 * is a hint that sends them looking for it.
 */
function runningHint(hasDraft: boolean): string {
  return hasDraft
    ? 'Working. Send to steer it, or stop the turn.'
    : 'Working. Type to steer it, or stop the turn.'
}

export function composerPhase(input: {
  running: boolean
  pendingQuestionId: string | null
  sending: boolean
}): ComposerPhase {
  if (input.pendingQuestionId !== null) return 'waiting'
  if (input.running) return 'running'
  if (input.sending) return 'sending'
  return 'idle'
}

export function sendState({
  conversation,
  sending,
  draft,
  steering,
}: SendStateInput): SendState {
  const phase = composerPhase({
    running: conversation.running,
    pendingQuestionId: conversation.pendingQuestionId,
    sending,
  })
  const busy = phase !== 'idle'
  const hasDraft = draft.trim().length > 0

  return {
    phase,
    mode: !busy ? 'idle' : steering ? 'steering' : 'busy',
    canRun: !busy && hasDraft,
    // A question already halted the turn and the backend 409s anything sent
    // into it, so the steer is withheld while waiting.
    canSteer: busy && phase !== 'waiting' && hasDraft,
    canStop: busy,
    selectorsEnabled: !(busy && steering),
    hint: !busy ? null : phase === 'running' ? runningHint(hasDraft) : HINTS[phase],
  }
}

export interface ComposerStateInput {
  conversation: ConversationState
  sending: boolean
  draft: string
}

export interface ComposerState {
  phase: ComposerPhase
  /** The editor is live and the send control is armed. */
  canSend: boolean
  hint: string | null
}

/**
 * The narrow question — may this composer start a turn, and if not, why.
 *
 * A projection of {@link sendState} for callers that render enablement without
 * the busy cluster: there is one machine, and this is a view of it.
 */
export function composerState(input: ComposerStateInput): ComposerState {
  const state = sendState({ ...input, steering: false })
  return { phase: state.phase, canSend: state.canRun, hint: state.hint }
}
