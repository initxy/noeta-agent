/**
 * Server state for the project domain: the list, one project, its agent
 * configuration and its MCP connectors.
 *
 * Everything the domain reads or writes goes through here, so cache
 * invalidation is decided in one place. The rule it follows: a mutation
 * invalidates what it could have changed and nothing else — a blanket
 * `invalidateQueries()` refetches the session list and the model catalog to
 * rename a project, which on a slow first run is visible.
 *
 * Credential values appear in exactly one direction. `ConnectorInput` can
 * carry `headers` / `env`; every read path returns `Connector`, which has only
 * the sorted *names*. That asymmetry is the API's, and it is repeated here so
 * that no cache in this app is ever holding a secret to re-render.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  createConnector,
  createProject,
  deleteConnector,
  deleteProject,
  getAgentConfig,
  listConnectors,
  listProjects,
  putAgentConfig,
  updateProject,
} from '@/app/api'
import type {
  AgentConfig,
  Connector,
  ConnectorInput,
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from '@/app/types'

export const projectKeys = {
  all: ['projects'] as const,
  list: () => ['projects', 'list'] as const,
  agentConfig: (projectId: string) => ['projects', 'agent-config', projectId] as const,
  connectors: (projectId: string) => ['projects', 'connectors', projectId] as const,
}

/** Sidebar order: by name, case-insensitively, on a copy of the cache array. */
export function sortProjects(projects: readonly Project[]): Project[] {
  return projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function useProjects(): UseQueryResult<Project[], Error> {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: ({ signal }) => listProjects(signal),
  })
}

export function useCreateProject() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => createProject(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.list() })
    },
  })
}

export function useUpdateProject(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) => updateProject(projectId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.list() })
      // The agent-config view overlaps the project row (persona, model,
      // effort, memory), so a PATCH that touched any of them invalidates it
      // too — otherwise the two settings tabs disagree until a reload.
      void client.invalidateQueries({ queryKey: projectKeys.agentConfig(projectId) })
    },
  })
}

export function useDeleteProject() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.list() })
    },
  })
}

export function useAgentConfig(projectId: string): UseQueryResult<AgentConfig, Error> {
  return useQuery({
    queryKey: projectKeys.agentConfig(projectId),
    queryFn: ({ signal }) => getAgentConfig(projectId, signal),
    enabled: Boolean(projectId),
  })
}

export function usePutAgentConfig(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: AgentConfig) => putAgentConfig(projectId, body),
    onSuccess: (config) => {
      client.setQueryData(projectKeys.agentConfig(projectId), config)
      void client.invalidateQueries({ queryKey: projectKeys.list() })
    },
  })
}

export function useConnectors(projectId: string): UseQueryResult<Connector[], Error> {
  return useQuery({
    queryKey: projectKeys.connectors(projectId),
    queryFn: ({ signal }) => listConnectors(projectId, signal),
    enabled: Boolean(projectId),
  })
}

export function useCreateConnector(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: ConnectorInput) => createConnector(projectId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.connectors(projectId) })
    },
  })
}

export function useDeleteConnector(projectId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (alias: string) => deleteConnector(projectId, alias),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: projectKeys.connectors(projectId) })
    },
  })
}
