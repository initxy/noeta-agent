/**
 * The canonical URL vocabulary.
 *
 * The URL is authoritative (D9): project and session identity are route state,
 * never app-global mutable state. That only holds if there is exactly one
 * place that knows how a URL is spelled — a hand-composed path somewhere in a
 * domain is how a route table and its links drift apart.
 *
 * This lives in `app/` rather than in the shell on purpose. It is pure string
 * work with no React in it, and a domain that needs to link at another
 * project's session must be able to import it: `domains/*` may not import
 * `shell/`, so builders owned by the shell would be unreachable from exactly
 * the code that needs them most.
 */

/**
 * Route patterns, in the form the router matches on. Kept beside the builders
 * so a pattern and the function that fills it cannot drift.
 */
export const ROUTE_PATTERNS = {
  home: '/',
  project: '/project/:projectId',
  projectSessions: '/project/:projectId/session',
  projectSession: '/project/:projectId/session/:sessionId',
  projectSettings: '/project/:projectId/settings',
  projectSettingsTab: '/project/:projectId/settings/:tab',
  trace: '/trace/:sessionId',
} as const

export const HOME_ROUTE = ROUTE_PATTERNS.home

/**
 * A project's conversation surface. Omitting the session id is the "project
 * open, nothing selected" state — deliberately a distinct URL from a session,
 * so that landing on it is never confused with a session that failed to load.
 */
export function projectSessionRoute(projectId: string, sessionId?: string | null): string {
  const base = `/project/${encodeURIComponent(projectId)}/session`
  return sessionId ? `${base}/${encodeURIComponent(sessionId)}` : base
}

export function projectSettingsRoute(projectId: string, tab: string): string {
  return `/project/${encodeURIComponent(projectId)}/settings/${encodeURIComponent(tab)}`
}

/** The standalone trace page — a debug surface, outside the workbench shell. */
export function traceRoute(sessionId: string): string {
  return `/trace/${encodeURIComponent(sessionId)}`
}
