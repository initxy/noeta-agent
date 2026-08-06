/**
 * The project index — the list the sidebar renders and the route resolves ids
 * against.
 *
 * The shape is what `route-resolution.ts` is written against, and that is
 * structural: it decides what happens to a URL naming something that does not
 * exist.
 *
 * `status` is explicit rather than derived from an empty array, because
 * "still loading" and "loaded, and there are none" must never render the same
 * way — conflating them is how a not-found flashes on every cold start. A
 * *failed* fetch reports `ready` with an `error`, deliberately: a backend that
 * is down must not leave the shell spinning forever, and either way the route
 * cannot confirm the project exists.
 */

import { readLastProjectId } from '@/react-app/kernel/route-memory'
import { sortProjects, useProjects } from './project-queries'
import type { Project } from '@/app/types'

/**
 * What the routing rules need from a project — which is `Project` itself
 * rather than a narrower view: the sidebar wants the directory for its
 * tooltip and the tier for its badge, and a second near-identical type is one
 * more thing to keep in step with the wire.
 */
export type ProjectSummary = Project

export interface ProjectIndex {
  status: 'loading' | 'ready'
  projects: ProjectSummary[]
  /**
   * The project to fall back to when the URL names an unknown one. Restore
   * memory only — never authoritative while a project-scoped URL is active.
   */
  fallbackProjectId: string | null
  error?: Error | null
}

export function useProjectIndex(): ProjectIndex {
  const query = useProjects()
  return {
    status: query.isPending ? 'loading' : 'ready',
    projects: query.data ? sortProjects(query.data) : [],
    fallbackProjectId: readLastProjectId(),
    error: query.error,
  }
}
