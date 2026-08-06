/**
 * The `/project/:projectId` layout route: resolve the id, then decide.
 *
 * It sits *inside* `ShellLayout`, so every outcome below — redirect, card,
 * spinner — happens with the sidebar mounted.
 *
 * The redirect is the asymmetric half of D9's not-found rule: an unknown
 * *project* redirects (`replace`, carrying the session id across), because a
 * project id is a container the user did not choose from this URL and there is
 * a defensible place to send them. An unknown *session* does not — see
 * `session-route.tsx`.
 */

import { useEffect } from 'react'
import { Navigate, Outlet, useMatch, useParams } from 'react-router-dom'
import { ROUTE_PATTERNS } from '@/app/routes'
import { CenteredNote, NotFoundCard } from '@/react-app/design-system'
import { writeLastProjectId } from '@/react-app/kernel/route-memory'
import { useProjectIndex } from '@/react-app/domains/project/project-index'
import { resolveProjectRoute } from '@/react-app/domains/project/route-resolution'

export function ProjectRoute() {
  const { projectId = '' } = useParams()
  // A layout route's `useParams` stops at its own segment, so the session id —
  // owned by a child route — is read from the pattern instead. It has to be
  // read here because the redirect carries it across the project swap.
  const sessionMatch = useMatch(ROUTE_PATTERNS.projectSession)

  const index = useProjectIndex()
  const resolution = resolveProjectRoute({
    ...index,
    routeProjectId: projectId,
    sessionId: sessionMatch?.params.sessionId ?? null,
  })

  // Remember the project only once it is known to exist. Writing the raw route
  // param would persist a typo and make the next unknown-project redirect send
  // the user to the same dead id.
  const resolvedProjectId = resolution.kind === 'ok' ? resolution.project.id : null
  useEffect(() => {
    if (resolvedProjectId) writeLastProjectId(resolvedProjectId)
  }, [resolvedProjectId])

  if (resolution.kind === 'loading') return <CenteredNote>Loading project…</CenteredNote>
  if (resolution.kind === 'redirect') return <Navigate to={resolution.to} replace />
  if (resolution.kind === 'not-found') {
    return <NotFoundCard title="Project not found" message={resolution.message} />
  }
  return <Outlet />
}
