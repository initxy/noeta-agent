import { describe, expect, it } from 'vitest'
import { ROUTE_PATTERNS, projectSessionRoute, projectSettingsRoute, traceRoute } from './routes'

describe('route builders', () => {
  it('builds the canonical session URL, with and without a session', () => {
    expect(projectSessionRoute('p1', 's1')).toBe('/project/p1/session/s1')
    expect(projectSessionRoute('p1')).toBe('/project/p1/session')
  })

  it('treats a null session id as "nothing selected" rather than as a path segment', () => {
    expect(projectSessionRoute('p1', null)).toBe('/project/p1/session')
  })

  it('encodes ids so a path-like id cannot forge extra segments', () => {
    expect(projectSessionRoute('a/b', 'c d')).toBe('/project/a%2Fb/session/c%20d')
    expect(traceRoute('a/b')).toBe('/trace/a%2Fb')
  })

  it('builds the settings URL for a tab', () => {
    expect(projectSettingsRoute('p1', 'connections')).toBe('/project/p1/settings/connections')
  })

  it('keeps each pattern and its builder in agreement', () => {
    // The pattern is what the router matches; the builder is what everything
    // links with. Drift between them is the failure this pins.
    expect(ROUTE_PATTERNS.projectSession).toBe(
      projectSessionRoute(':projectId', ':sessionId').replaceAll('%3A', ':'),
    )
    expect(ROUTE_PATTERNS.projectSettingsTab).toBe(
      projectSettingsRoute(':projectId', ':tab').replaceAll('%3A', ':'),
    )
    expect(ROUTE_PATTERNS.trace).toBe(traceRoute(':sessionId').replaceAll('%3A', ':'))
  })
})
