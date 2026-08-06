/**
 * The rail, driven: the pure folds wired to real clicks.
 *
 * `organisation-protocol.test.ts` and `unread.test.ts` pin the rules; this file
 * pins that the sidebar is actually holding them — that a pin moves the row
 * before the network answers, that the two activity signals reach opposite
 * edges of the DOM, and that opening a session clears its mark.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { updateSession } from '@/app/api'
import type { SessionDetail, SessionStatus } from '@/app/types'
import { SessionRail } from '../session-rail'
import { EMPTY_ORGANISATION } from './organisation-protocol'
import { useOrganisationStore } from './organisation-store'
import type { VersionedSessionRow } from './organisation-store'
import { EMPTY_UNREAD } from './unread'

/**
 * Rows carry `version` because the wire does — `app/types/wire.ts` has not
 * declared it yet, which is why the sidebar names the widened shape itself.
 */
function sessionRow(
  id: string,
  status: SessionStatus = 'idle',
  extra: Partial<VersionedSessionRow> = {},
): VersionedSessionRow {
  return {
    id,
    project_id: 'alpha',
    title: id,
    status,
    created_at: '2026-07-31T09:00:00Z',
    updated_at: '2026-07-31T10:00:00Z',
    ...extra,
  }
}

let rows: VersionedSessionRow[] = []

vi.mock('@/react-app/domains/session/queries/session-queries', () => ({
  useSessionRows: () => ({ data: rows, isLoading: false, error: null }),
  useCreateSession: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteSession: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}))

vi.mock('@/app/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/api')>()),
  updateSession: vi.fn(),
}))

const patched = vi.mocked(updateSession)

function renderRail(selectedSessionId: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/project/alpha/session']}>
        <SessionRail projectId="alpha" selectedSessionId={selectedSessionId} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // The store is process-global on purpose (unread outlives a project switch),
  // so each test starts it clean rather than inheriting the last one's.
  useOrganisationStore.setState({ organisation: EMPTY_ORGANISATION, unread: EMPTY_UNREAD })
  patched.mockReset()
  rows = []
})

afterEach(cleanup)

describe('pin and archive, from the row', () => {
  it('moves the row into Pinned before the server has answered', async () => {
    rows = [sessionRow('alpha-1')]
    // A request that never settles: everything asserted below happens while
    // the PATCH is still in flight, which is the whole point of optimistic.
    patched.mockReturnValue(new Promise<SessionDetail>(() => {}))

    renderRail()
    expect(screen.queryByText('Pinned')).toBeNull()

    await userEvent.click(screen.getByLabelText('Pin session'))

    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(patched).toHaveBeenCalledWith('alpha-1', { pinned: true })
    expect(useOrganisationStore.getState().organisation.pending).toBe(1)
  })

  it('keeps the row pinned once the response confirms it', async () => {
    rows = [sessionRow('alpha-1', 'idle', { version: 3 })]
    patched.mockResolvedValue({
      ...sessionRow('alpha-1', 'idle', { pinned: true, version: 4 }),
      task_streams: [],
    } as SessionDetail)

    renderRail()
    await userEvent.click(screen.getByLabelText('Pin session'))

    await waitFor(() => expect(useOrganisationStore.getState().organisation.pending).toBe(0))
    expect(screen.getByText('Pinned')).toBeTruthy()
    expect(screen.getByLabelText('Unpin session')).toBeTruthy()
  })

  it('puts the row back when the write fails', async () => {
    rows = [sessionRow('alpha-1')]
    patched.mockRejectedValue(new Error('offline'))

    renderRail()
    await userEvent.click(screen.getByLabelText('Pin session'))

    await waitFor(() => expect(useOrganisationStore.getState().organisation.pending).toBe(0))
    expect(screen.queryByText('Pinned')).toBeNull()
  })

  it('folds an archived session away behind a collapsed section', async () => {
    rows = [sessionRow('alpha-1'), sessionRow('alpha-2')]
    patched.mockReturnValue(new Promise<SessionDetail>(() => {}))

    renderRail()
    const archive = screen.getAllByLabelText('Archive session')[0]
    await userEvent.click(archive)

    // The archived section exists, is collapsed, and the row is not in the
    // active list any more.
    const toggle = screen.getByRole('button', { name: /Archived/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alpha-1')).toBeNull()

    await userEvent.click(toggle)
    expect(screen.getByText('alpha-1')).toBeTruthy()
  })
})

describe('the activity signals, rendered', () => {
  it('gives a running row the glyph lane and leaves the trailing edge empty', () => {
    rows = [sessionRow('busy', 'running')]
    const view = renderRail()

    expect(screen.getByLabelText('Running')).toBeTruthy()
    const outcome = view.container.querySelector('[data-session-outcome-indicator]')
    expect(outcome?.getAttribute('data-session-outcome-indicator')).toBe('')
    expect(outcome?.childElementCount).toBe(0)
  })

  it('gives a waiting row the trailing dot and no living glyph', () => {
    rows = [sessionRow('asking', 'waiting')]
    const view = renderRail()

    expect(view.container.querySelector('[data-session-activity-indicator]')).toBeNull()
    expect(
      view.container
        .querySelector('[data-session-outcome-indicator]')
        ?.getAttribute('data-session-outcome-indicator'),
    ).toBe('waiting')
    expect(screen.getByLabelText('Waiting for you')).toBeTruthy()
  })
})

describe('unread', () => {
  it('marks a background session that finished, and clears it when opened', async () => {
    // The baseline: last time the sidebar looked, this session was working.
    act(() => {
      useOrganisationStore.getState().observe([sessionRow('alpha-1', 'running')], null)
    })
    rows = [sessionRow('alpha-1', 'idle', { updated_at: '2026-07-31T10:09:00Z' })]

    const view = renderRail()

    await waitFor(() => expect(screen.getByLabelText('Unread')).toBeTruthy())
    expect(
      view.container
        .querySelector('[data-session-outcome-indicator]')
        ?.getAttribute('data-session-outcome-indicator'),
    ).toBe('unread')

    await userEvent.click(screen.getByText('alpha-1'))
    expect(useOrganisationStore.getState().unread.unread.has('alpha-1')).toBe(false)
  })
})
