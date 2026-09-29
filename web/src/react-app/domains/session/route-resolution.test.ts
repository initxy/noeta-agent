import { describe, expect, it } from 'vitest'
import { SESSION_NOT_FOUND_MESSAGE, resolveSessionRoute } from './route-resolution'
import type { SessionSummary } from './session-index'

const first: SessionSummary = {
  id: 's1',
  title: 'First',
  parentSessionId: null,
  branchedAtSeq: null,
}

describe('resolveSessionRoute', () => {
  it('treats an absent session id as a state, not a failure', () => {
    expect(
      resolveSessionRoute({ status: 'ready', sessions: [first], routeSessionId: null }),
    ).toEqual({ kind: 'none' })
  })

  it('resolves a known session', () => {
    expect(
      resolveSessionRoute({ status: 'ready', sessions: [first], routeSessionId: 's1' }),
    ).toEqual({ kind: 'ok', session: first })
  })

  it('waits while the index is loading', () => {
    expect(resolveSessionRoute({ status: 'loading', sessions: [], routeSessionId: 's1' })).toEqual({
      kind: 'loading',
    })
  })

  it('reports an unknown session as not-found and never as a redirect', () => {
    // A session id is pasted, bookmarked or shared; swapping it for another
    // session silently is what makes such a link untrustworthy.
    expect(
      resolveSessionRoute({ status: 'ready', sessions: [first], routeSessionId: 'ghost' }),
    ).toEqual({ kind: 'not-found', message: SESSION_NOT_FOUND_MESSAGE })
  })
})
