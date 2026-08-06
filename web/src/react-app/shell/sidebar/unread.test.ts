import { describe, expect, it } from 'vitest'
import type { SessionStatus } from '@/app/types'
import { EMPTY_UNREAD, acknowledge, clearUnread, observeSessions } from './unread'
import type { VersionedSessionRow } from './versioned-row'

/** `version` is the row's activity mark: bumped by every write, engine's included. */
function row(id: string, status: SessionStatus, version = 1): VersionedSessionRow {
  return {
    id,
    project_id: 'p1',
    title: id,
    status,
    version,
    created_at: '2026-07-31T09:00:00Z',
    updated_at: '2026-07-31T10:00:00Z',
  }
}

describe('unread, derived from what the index reports', () => {
  it('marks a session that finished while the user was elsewhere', () => {
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'running')], 'other')
    expect(state.unread.has('a')).toBe(false)

    state = observeSessions(state, [row('a', 'idle', 4)], 'other')
    expect(state.unread.has('a')).toBe(true)
  })

  it('never marks a session on first sight', () => {
    // A cold page load sees every session at rest. Reading that as "they all
    // just finished" would light the whole sidebar up on every refresh.
    const state = observeSessions(EMPTY_UNREAD, [row('a', 'idle'), row('b', 'idle')], null)
    expect(state.unread.size).toBe(0)
  })

  it('never marks the session the user is looking at, and clears it on arrival', () => {
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'running')], null)
    state = observeSessions(state, [row('a', 'idle', 4)], null)
    expect(state.unread.has('a')).toBe(true)

    // Selecting it is reading it.
    state = observeSessions(state, [row('a', 'idle', 4)], 'a')
    expect(state.unread.has('a')).toBe(false)
  })

  it('clears on visit, before anything navigates', () => {
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'waiting')], null)
    state = observeSessions(state, [row('a', 'idle', 4)], null)
    expect(state.unread.has('a')).toBe(true)

    state = clearUnread(state, 'a')
    expect(state.unread.has('a')).toBe(false)
    // Idempotent, and the same reference when there was nothing to clear.
    expect(clearUnread(state, 'a')).toBe(state)
  })

  it('catches a whole turn that happened between two observations', () => {
    // The case a status-transition-only derivation loses: the sidebar learns
    // about background sessions by polling, and a turn that starts and
    // finishes inside one interval reads as idle → idle. The row's version
    // moved — every envelope the turn recorded bumped it — and that is the
    // evidence.
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'idle', 2)], null)
    state = observeSessions(state, [row('a', 'idle', 19)], null)
    expect(state.unread.has('a')).toBe(true)
  })

  it('does not read our own pin as a finished turn', () => {
    // Pin/archive/rename all bump the version, which the rule above would
    // otherwise treat as background work. Acknowledging the response we
    // already hold rebases the baseline.
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'idle', 2)], null)

    const patched = { ...row('a', 'idle', 3), pinned: true }
    state = acknowledge(state, patched)
    state = observeSessions(state, [patched], null)

    expect(state.unread.has('a')).toBe(false)
  })

  it('returns the same reference when a snapshot brought no news', () => {
    // A poll that found nothing must not re-render the sidebar.
    const rows = [row('a', 'idle'), row('b', 'running')]
    const first = observeSessions(EMPTY_UNREAD, rows, null)
    expect(observeSessions(first, rows, null)).toBe(first)
  })

  it('keeps what it knows about sessions outside the snapshot', () => {
    // Unread is global; a project switch delivers a snapshot that mentions
    // none of the other project's sessions, and forgetting them there would
    // silently clear marks the user has not read.
    let state = observeSessions(EMPTY_UNREAD, [row('a', 'running')], null)
    state = observeSessions(state, [row('a', 'idle', 4)], null)
    state = observeSessions(state, [row('z', 'idle')], null)

    expect(state.unread.has('a')).toBe(true)
    expect(state.seen.a).toBeDefined()
  })
})
