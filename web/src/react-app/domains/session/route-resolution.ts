/**
 * What a session id in the URL resolves to.
 *
 * The counterpart to the project rule, and deliberately different from it: an
 * unknown session **never redirects**. It renders a not-found card with the
 * sidebar still mounted, because a session id is something the user pasted,
 * bookmarked or shared, and silently swapping it for another session is how a
 * link becomes untrustworthy.
 *
 * `none` — no session id in the URL at all — is a first-class state, not a
 * failure: it is the project-open-nothing-selected surface.
 */

import type { SessionIndex, SessionSummary } from './session-index'

export type SessionRouteResolution =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'ok'; session: SessionSummary }
  | { kind: 'not-found'; message: string }

export const SESSION_NOT_FOUND_MESSAGE =
  'Session was not found. Select a session from the sidebar.'

export interface SessionRouteInput extends SessionIndex {
  routeSessionId: string | null
}

export function resolveSessionRoute(input: SessionRouteInput): SessionRouteResolution {
  const { status, sessions, routeSessionId } = input

  if (!routeSessionId) return { kind: 'none' }
  if (status === 'loading') return { kind: 'loading' }

  const session = sessions.find((candidate) => candidate.id === routeSessionId)
  if (session) return { kind: 'ok', session }
  return { kind: 'not-found', message: SESSION_NOT_FOUND_MESSAGE }
}
