import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '@/app/types'
import { rowSignals, rowStateLabel } from './row-signals'

const STATUSES: SessionStatus[] = ['idle', 'running', 'waiting']

describe('the two activity signals', () => {
  it('never lights both edges of the same row', () => {
    // The property, exhaustively: every combination of status, unread and
    // selection. This is the rule that keeps the sidebar readable, and it is
    // the one a later renderer is most likely to break by adding "just one
    // more" indicator.
    for (const status of STATUSES) {
      for (const unread of [false, true]) {
        for (const selected of [false, true]) {
          const signals = rowSignals({ status, unread, selected })
          expect(signals.activity && signals.outcome !== null).toBe(false)
        }
      }
    }
  })

  it('gives running work the glyph lane and nothing on the right', () => {
    expect(rowSignals({ status: 'running' })).toEqual({ activity: true, outcome: null })
    // Even a session that was unread a moment ago: an unread mark on a row
    // that is visibly working again is news about the past.
    expect(rowSignals({ status: 'running', unread: true })).toEqual({
      activity: true,
      outcome: null,
    })
  })

  it('treats waiting as an outcome, not as activity', () => {
    // A session parked on a question is not working, it is asking. A living
    // animation on it says the opposite of what is true.
    expect(rowSignals({ status: 'waiting' })).toEqual({ activity: false, outcome: 'waiting' })
  })

  it('shows unread only on a row the user is not looking at', () => {
    expect(rowSignals({ status: 'idle', unread: true })).toEqual({
      activity: false,
      outcome: 'unread',
    })
    expect(rowSignals({ status: 'idle', unread: true, selected: true })).toEqual({
      activity: false,
      outcome: null,
    })
  })

  it('says nothing at all about a quiet, read session', () => {
    expect(rowSignals({ status: 'idle' })).toEqual({ activity: false, outcome: null })
  })

  it('names every state exactly once, so the label cannot disagree with the dot', () => {
    const named = (input: Parameters<typeof rowSignals>[0]) =>
      rowStateLabel(rowSignals(input), input.status)

    expect(named({ status: 'running' })).toBe('Running')
    expect(named({ status: 'waiting' })).toBe('Waiting for you')
    expect(named({ status: 'idle', unread: true })).toBe('Unread')
    expect(named({ status: 'idle' })).toBe('Idle')
    // A running row that is also unread is announced as running — the same
    // precedence the visual signals use.
    expect(named({ status: 'running', unread: true })).toBe('Running')
  })
})
