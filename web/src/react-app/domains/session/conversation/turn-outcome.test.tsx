import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { composerState } from '../state/send-state'
import { TurnOutcomeNotice } from './turn-outcome'

/**
 * The single most important rendering decision of the turn-control phase.
 *
 * `interrupted` and `turn_failed` both park the conversation and neither ends
 * it. Before 0.5.0 a provider 5xx sealed the ledger and the user lost their
 * whole context; rendering it as fatal would hand that back. So both are
 * pinned here as *notices* — never `role="alert"`, never accompanied by a
 * disabled composer.
 */

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

function outcomeAfter(...events: RawUIEvent[]) {
  return foldEvents(initialConversationState(), events)
}

function show(...events: RawUIEvent[]) {
  const conversation = outcomeAfter(...events)
  render(
    <TurnOutcomeNotice outcome={conversation.lastOutcome} running={conversation.running} />,
  )
  return conversation
}

afterEach(cleanup)

describe('a parked turn is not a dead session', () => {
  it('renders an interrupted turn as "Stopped." with the composer still live', () => {
    const conversation = show(
      frame('turn_started', {}, 0),
      frame('turn_finished', { status: 'interrupted' }, 1),
    )

    expect(screen.getByTestId('turn-outcome').getAttribute('data-outcome')).toBe('interrupted')
    expect(screen.getByText(/Stopped\./)).toBeTruthy()
    expect(screen.getByText(/pick up from here/)).toBeTruthy()
    // Not an error, and not a dead end.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/conversation is closed/)).toBeNull()
    expect(composerState({ conversation, sending: false, draft: 'go on' }).canSend).toBe(true)
  })

  it('renders turn_failed as a retriable error carrying the provider’s reason', () => {
    const conversation = show(
      frame('turn_started', {}, 0),
      frame('turn_finished', { status: 'turn_failed', reason: 'gateway 503' }, 1),
    )

    expect(screen.getByTestId('turn-outcome').getAttribute('data-outcome')).toBe('turn_failed')
    expect(screen.getByText('gateway 503')).toBeTruthy()
    expect(screen.getByText(/Send a message to retry/)).toBeTruthy()
    // `role="status"`, not `alert`: the conversation is intact and resuming it
    // is an ordinary send, so this must not read as a failure the user has to
    // recover from.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(composerState({ conversation, sending: false, draft: 'try again' }).canSend).toBe(true)
  })

  it('says nothing at all while the next turn is running', () => {
    show(
      frame('turn_finished', { status: 'interrupted' }, 0),
      frame('turn_started', {}, 1),
    )
    expect(screen.queryByTestId('turn-outcome')).toBeNull()
  })

  it('says nothing for a turn that simply finished', () => {
    show(frame('turn_finished', { status: 'completed' }, 0))
    expect(screen.queryByTestId('turn-outcome')).toBeNull()
    show(frame('turn_finished', { status: 'awaiting_input' }, 1))
    expect(screen.queryByTestId('turn-outcome')).toBeNull()
  })
})

describe('the two outcomes that really are terminal', () => {
  it('points a cancelled turn at branching, which is the way forward that exists', () => {
    // `cancel` is terminal — the next message is refused — so the honest
    // instruction is to fork at an earlier message, not to try again.
    show(frame('turn_finished', { status: 'cancelled' }, 0))
    expect(screen.getByText('Cancelled.')).toBeTruthy()
    expect(screen.getByText(/conversation is closed/)).toBeTruthy()
    expect(screen.getByText(/shares the project directory/)).toBeTruthy()
  })

  it('does not repeat the error the preceding frame already rendered', () => {
    show(
      frame('error', { message: 'the drive thread exploded' }, 0),
      frame('turn_finished', { status: 'failed' }, 1),
    )
    expect(screen.getByText('This turn ended with an error.')).toBeTruthy()
    expect(screen.queryByText('the drive thread exploded')).toBeNull()
  })
})
