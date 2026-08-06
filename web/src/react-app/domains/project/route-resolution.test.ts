import { describe, expect, it } from 'vitest'
import { PROJECT_NOT_FOUND_MESSAGE, resolveProjectRoute } from './route-resolution'
import type { ProjectSummary } from './project-index'

function project(id: string, name: string): ProjectSummary {
  return {
    id,
    name,
    directory: `/tmp/${id}`,
    tier: 'local',
    default_model: null,
    default_effort: null,
    persona: null,
    memory_enabled: false,
  }
}

const alpha = project('alpha', 'Alpha')
const beta = project('beta', 'Beta')

describe('resolveProjectRoute', () => {
  it('resolves a known project', () => {
    expect(
      resolveProjectRoute({
        status: 'ready',
        projects: [alpha, beta],
        fallbackProjectId: null,
        routeProjectId: 'beta',
        sessionId: null,
      }),
    ).toEqual({ kind: 'ok', project: beta })
  })

  it('waits while the index is loading instead of declaring a miss', () => {
    // Otherwise every cold start flashes a not-found card before the list lands.
    expect(
      resolveProjectRoute({
        status: 'loading',
        projects: [],
        fallbackProjectId: null,
        routeProjectId: 'alpha',
        sessionId: null,
      }),
    ).toEqual({ kind: 'loading' })
  })

  it('redirects an unknown project and keeps the session id', () => {
    expect(
      resolveProjectRoute({
        status: 'ready',
        projects: [alpha, beta],
        fallbackProjectId: 'beta',
        routeProjectId: 'ghost',
        sessionId: 's1',
      }),
    ).toEqual({ kind: 'redirect', to: '/project/beta/session/s1' })
  })

  it('prefers the remembered project, but only while it still exists', () => {
    expect(
      resolveProjectRoute({
        status: 'ready',
        projects: [alpha, beta],
        fallbackProjectId: 'deleted',
        routeProjectId: 'ghost',
        sessionId: null,
      }),
    ).toEqual({ kind: 'redirect', to: '/project/alpha/session' })
  })

  it('shows not-found rather than redirecting when there is nowhere to go', () => {
    expect(
      resolveProjectRoute({
        status: 'ready',
        projects: [],
        fallbackProjectId: null,
        routeProjectId: 'ghost',
        sessionId: 's1',
      }),
    ).toEqual({ kind: 'not-found', message: PROJECT_NOT_FOUND_MESSAGE })
  })
})
