/**
 * What a project id in the URL resolves to.
 *
 * The rule this encodes (D9): a missing resource never silently falls back to
 * "the first project". An *unknown project* redirects — `replace`, keeping the
 * session id — because a project id is a container the user did not choose
 * from this URL, and there is a defensible place to send them. An unknown
 * session does not (see the session domain): it renders a not-found card with
 * the sidebar mounted, so the user picks.
 *
 * A pure function so the decision table is testable without a router, and so
 * the redirect target is built from the one URL vocabulary rather than spelled
 * out at the call site.
 */

import { projectSessionRoute } from '@/app/routes'
import type { ProjectIndex, ProjectSummary } from './project-index'

export type ProjectRouteResolution =
  | { kind: 'loading' }
  | { kind: 'ok'; project: ProjectSummary }
  | { kind: 'redirect'; to: string }
  | { kind: 'not-found'; message: string }

export const PROJECT_NOT_FOUND_MESSAGE =
  'Project was not found. Create or select a project from the sidebar.'

export interface ProjectRouteInput extends ProjectIndex {
  routeProjectId: string
  /** Carried through a redirect so switching projects does not lose the session. */
  sessionId: string | null
}

export function resolveProjectRoute(input: ProjectRouteInput): ProjectRouteResolution {
  const { status, projects, fallbackProjectId, routeProjectId, sessionId } = input

  if (status === 'loading') return { kind: 'loading' }

  const project = projects.find((candidate) => candidate.id === routeProjectId)
  if (project) return { kind: 'ok', project }

  // Prefer the remembered project, but only if it still exists; otherwise the
  // first of the list. With no projects at all there is nowhere to send the
  // user, so the not-found card is the honest answer.
  const fallback =
    projects.find((candidate) => candidate.id === fallbackProjectId) ?? projects[0] ?? null
  if (fallback) return { kind: 'redirect', to: projectSessionRoute(fallback.id, sessionId) }

  return { kind: 'not-found', message: PROJECT_NOT_FOUND_MESSAGE }
}
