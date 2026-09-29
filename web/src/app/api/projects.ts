/**
 * Projects: a directory on disk, plus the configuration the agent brings to
 * every session held against it.
 *
 * Two facts this module cannot express in a signature, so they are stated
 * here for the callers that must surface them:
 *
 * - **`directory` must be absolute.** A relative path is a 422 whose message
 *   now names the field (see `extractApiError`), so the create form has
 *   something to show without inventing its own validation.
 * - **Changing `tier` only affects sessions created afterwards.** The tier is
 *   welded into the task at seed time and every later turn resolves it from
 *   there, so an existing session keeps the tier it was born with.
 */

import { apiRequest, readList } from './client'
import type {
  AgentConfig,
  Connector,
  ConnectorInput,
  ConnectorPatch,
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from '../types/wire'

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  return readList<Project>(await apiRequest<unknown>('/projects', { signal }), 'projects')
}

export function createProject(
  body: CreateProjectRequest,
  signal?: AbortSignal,
): Promise<Project> {
  return apiRequest<Project>('/projects', { method: 'POST', json: body, signal })
}

export function getProject(projectId: string, signal?: AbortSignal): Promise<Project> {
  return apiRequest<Project>(`/projects/${encodeURIComponent(projectId)}`, { signal })
}

export function updateProject(
  projectId: string,
  body: UpdateProjectRequest,
  signal?: AbortSignal,
): Promise<Project> {
  return apiRequest<Project>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    json: body,
    signal,
  })
}

export function deleteProject(projectId: string, signal?: AbortSignal): Promise<void> {
  return apiRequest<void>(`/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
    signal,
  })
}

export function getAgentConfig(projectId: string, signal?: AbortSignal): Promise<AgentConfig> {
  return apiRequest<AgentConfig>(`/projects/${encodeURIComponent(projectId)}/agent-config`, {
    signal,
  })
}

export function putAgentConfig(
  projectId: string,
  body: AgentConfig,
  signal?: AbortSignal,
): Promise<AgentConfig> {
  return apiRequest<AgentConfig>(`/projects/${encodeURIComponent(projectId)}/agent-config`, {
    method: 'PUT',
    json: body,
    signal,
  })
}

export async function listConnectors(
  projectId: string,
  signal?: AbortSignal,
): Promise<Connector[]> {
  const payload = await apiRequest<unknown>(
    `/projects/${encodeURIComponent(projectId)}/connectors`,
    { signal },
  )
  return readList<Connector>(payload, 'connectors')
}

export function createConnector(
  projectId: string,
  body: ConnectorInput,
  signal?: AbortSignal,
): Promise<Connector> {
  return apiRequest<Connector>(`/projects/${encodeURIComponent(projectId)}/connectors`, {
    method: 'POST',
    json: body,
    signal,
  })
}

export function updateConnector(
  projectId: string,
  alias: string,
  body: ConnectorPatch,
  signal?: AbortSignal,
): Promise<Connector> {
  return apiRequest<Connector>(
    `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(alias)}`,
    { method: 'PATCH', json: body, signal },
  )
}

export function deleteConnector(
  projectId: string,
  alias: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest<void>(
    `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(alias)}`,
    { method: 'DELETE', signal },
  )
}
