/**
 * The backend health query.
 *
 * Cross-cutting rather than domain state — the shell renders it, and nothing
 * about it belongs to a project or a session — so it lives in `infra/` with
 * the query client rather than under `domains/`.
 *
 * It carries two facts the rest of the UI reads rather than guesses: whether
 * the sandbox tier can actually run on this machine (Docker reachable), and
 * where the backend keeps its data, which is what lets "create the directory
 * for me" propose a real path instead of an invented one.
 */

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { fetchHealth } from '@/app/api'
import type { HealthPayload } from '@/app/types'

export const HEALTH_QUERY_KEY = ['health'] as const

/**
 * `/health` plus the one field the create-project form needs.
 *
 * `projects_dir` is where "create the directory for me" puts a new project
 * (`PROJECTS_DIR`, defaulting to `DATA_DIR/projects`). It is optional here
 * because the client must not require it: without it the form derives the
 * same default from `data_dir`, and either way the path is a suggestion the
 * user can overwrite.
 */
export interface HealthInfo extends HealthPayload {
  projects_dir?: string
}

export function useHealth(): UseQueryResult<HealthInfo, Error> {
  return useQuery({
    queryKey: HEALTH_QUERY_KEY,
    queryFn: ({ signal }) => fetchHealth(signal),
    // The backend can restart under a running tab (`make dev` reloads it), so
    // this one query is worth re-checking periodically.
    refetchInterval: 30_000,
  })
}

/**
 * Where a "create it for me" project directory should go.
 *
 * `projects_dir` when the backend reports it; otherwise `data_dir/projects`,
 * which is the backend's own default for an unset `PROJECTS_DIR`. Empty when
 * neither is known — the form then has no suggestion, which costs a
 * convenience rather than breaking the flow.
 */
export function projectsRoot(health: HealthInfo | undefined): string {
  if (!health) return ''
  if (health.projects_dir) return health.projects_dir
  if (!health.data_dir) return ''
  return `${health.data_dir.replace(/\/+$/, '')}/projects`
}
