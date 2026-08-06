import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Project, SessionRow } from '@/app/types'
import { AppRoot } from './app-root'

/**
 * The route table, pinned through the real thing.
 *
 * The per-domain `route-resolution.test.ts` files already cover the decision
 * tables as pure functions. What can only break here is the wiring: which
 * component is mounted above which, whether a redirect replaces or pushes,
 * and whether the sidebar survives each outcome. Those are the properties D9
 * is actually made of.
 *
 * The two index hooks are stubbed because they are the network; everything
 * else in the tree is the real component.
 */

function project(id: string, name: string): Project {
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

function sessionRow(id: string, title: string): SessionRow {
  return {
    id,
    project_id: 'alpha',
    title,
    status: 'idle',
    created_at: '2026-07-31T10:00:00Z',
    updated_at: '2026-07-31T10:00:00Z',
  }
}

vi.mock('@/react-app/domains/project/project-index', () => ({
  useProjectIndex: () => ({
    status: 'ready',
    projects: [project('alpha', 'Alpha')],
    fallbackProjectId: null,
    error: null,
  }),
}))

vi.mock('@/react-app/domains/session/session-index', () => ({
  useSessionIndex: () => ({
    status: 'ready',
    sessions: [{ id: 's1', title: 'First', parentSessionId: null, branchedAtSeq: null }],
  }),
}))

vi.mock('@/react-app/domains/session/queries/session-queries', () => ({
  useSessionRows: () => ({ data: [sessionRow('s1', 'First')], isLoading: false, error: null }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteSession: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}))

/**
 * The conversation surface is stubbed to a probe. This file pins the route
 * table — which component mounts where, and with what — and a real
 * `SessionPage` would drag an SSE connection and its reconnect timers into a
 * test about URLs.
 */
vi.mock('@/react-app/domains/session/session-page', () => ({
  SessionPage: ({ session }: { session: { id: string } | null }) => (
    <span data-testid="session-page">{session ? session.id : 'nothing-selected'}</span>
  ),
}))

function RouteProbe() {
  const location = useLocation()
  const navigationType = useNavigationType()
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
      <span data-testid="navigation-type">{navigationType}</span>
    </>
  )
}

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoot />
        <RouteProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const pathname = () => screen.getByTestId('pathname').textContent
const navigationType = () => screen.getByTestId('navigation-type').textContent

beforeEach(() => {
  // `/health` is the only live request left in this tree; answer it so the
  // components that read it settle instead of retrying against nothing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        status: 'ok',
        version: '0.5.1',
        provider: 'mock',
        sandbox_available: false,
        data_dir: '/tmp/data',
      }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the canonical routes', () => {
  it('resolves a deep session link exactly as opened — the hard-refresh case', () => {
    // A fresh mount at a deep URL *is* a hard refresh: nothing navigated to
    // get here, so the URL has to resolve on its own without a rewrite.
    renderAt('/project/alpha/session/s1')

    expect(pathname()).toBe('/project/alpha/session/s1')
    expect(navigationType()).toBe('POP')
    expect(screen.getByTestId('session-page').textContent).toBe('s1')
    // The rail beside it lists the session it resolved, with its status. The
    // rail is asked for by its own row rather than by a bare text match.
    expect(screen.getByRole('link', { name: 'First' })).toBeTruthy()
    expect(screen.getByLabelText('Idle')).toBeTruthy()
  })

  it('resolves the sessionless project surface as a state, not a failure', () => {
    renderAt('/project/alpha/session')

    expect(pathname()).toBe('/project/alpha/session')
    expect(screen.getByTestId('session-page').textContent).toBe('nothing-selected')
    expect(screen.getByText('New session')).toBeTruthy()
  })

  it('redirects a bare project URL to its session surface', () => {
    renderAt('/project/alpha')

    expect(pathname()).toBe('/project/alpha/session')
    expect(navigationType()).toBe('REPLACE')
  })

  it('resolves the settings tab and renders a real panel', () => {
    renderAt('/project/alpha/settings/general')

    expect(pathname()).toBe('/project/alpha/settings/general')
    expect(navigationType()).toBe('POP')
    expect(screen.getByText('Execution tier')).toBeTruthy()
  })

  it('mounts the trace page outside the shell', () => {
    renderAt('/trace/s1')

    expect(screen.getByText('Trace')).toBeTruthy()
    expect(screen.queryByText('Projects')).toBeNull()
  })

  it('renders a card for an unrecognised path instead of redirecting somewhere', () => {
    renderAt('/nope')

    expect(pathname()).toBe('/nope')
    expect(screen.getByText('Page not found')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
  })
})

describe('missing resources', () => {
  it('renders an unknown session as a card with the sidebar still mounted', () => {
    renderAt('/project/alpha/session/ghost')

    expect(screen.getByText('Session not found')).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
    // The URL is not rewritten: a pasted session link keeps pointing where it
    // did, which is the whole reason such a link is worth trusting.
    expect(pathname()).toBe('/project/alpha/session/ghost')
    expect(navigationType()).toBe('POP')
  })

  it('redirects an unknown project, carries the session id across, and replaces', () => {
    renderAt('/project/ghost/session/s1')

    expect(pathname()).toBe('/project/alpha/session/s1')
    // `replace`, not `push`: a Back button that walks the user into the same
    // dead project id is a trap, not history.
    expect(navigationType()).toBe('REPLACE')
    // and the session it carried over resolves rather than landing on a card
    expect(screen.queryByText('Session not found')).toBeNull()
    expect(screen.getByTestId('session-page').textContent).toBe('s1')
  })

  it('rewrites an unrecognised settings tab to the default one', () => {
    renderAt('/project/alpha/settings/nope')

    expect(pathname()).toBe('/project/alpha/settings/general')
    expect(navigationType()).toBe('REPLACE')
  })
})
