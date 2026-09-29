import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { RawEnvelope, RawEventsPayload } from '@/app/types'
import { TracePage } from './trace-page'

/**
 * The page's wiring, which is where the two defects this surface exists to
 * avoid actually live: fetching only the root stream, and rendering only the
 * envelope types this build has heard of.
 *
 * The fold algebra (turn grouping, compaction pairing, totals) is pinned as pure
 * functions in `model.test.ts`; what can only break here is whether the page
 * passes the accumulated cursor back, switches scope between streams, and lets
 * an unrecognised envelope survive the trip through the component tree.
 */

const { fetchRawEvents } = vi.hoisted(() => ({ fetchRawEvents: vi.fn() }))

vi.mock('@/app/api', () => ({
  fetchRawEvents,
  contentUrl: (hash: string) => `/api/v1/content/${hash}`,
}))

function env(taskId: string, seq: number, type: string, payload: unknown = {}): RawEnvelope {
  return { task_id: taskId, seq, type, payload, occurred_at: 1_700_000_000 + seq }
}

function page(events: RawEnvelope[], cursor: Record<string, number>): RawEventsPayload {
  return { events, cursor }
}

/** Queue one response per call, then keep returning an empty increment. */
function serve(...pages: RawEventsPayload[]) {
  let call = 0
  fetchRawEvents.mockImplementation(() => {
    const next = pages[call] ?? { events: [], cursor: pages[pages.length - 1]?.cursor ?? {} }
    call += 1
    return Promise.resolve(next)
  })
}

function renderTrace(sessionId = 's1') {
  return render(
    <MemoryRouter initialEntries={[`/trace/${sessionId}`]}>
      <Routes>
        <Route path="/trace/:sessionId" element={<TracePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  fetchRawEvents.mockReset()
  vi.unstubAllGlobals()
})

describe('the trace page', () => {
  it('renders an envelope type it has never heard of instead of going blank', async () => {
    serve(
      page(
        [
          env('root', 0, 'TaskStarted'),
          env('root', 1, 'SomeFutureEnvelope', { shape: ['not', { modelled: true }] }),
        ],
        { root: 1 },
      ),
    )

    renderTrace()

    // The unknown type is the one a developer opened this page to find. It is a
    // non-drawer, non-LLM row so it sits directly in the (auto-open last) group.
    expect(await screen.findByText('SomeFutureEnvelope')).toBeTruthy()
  })

  it('passes the accumulated cursor map back on the next request', async () => {
    serve(
      page([env('root', 0, 'LLMRequestStarted', { call_id: 'c', model: 'm' }), env('sub-a', 0, 'ToolCallStarted')], {
        root: 0,
        'sub-a': 0,
      }),
      page([env('root', 1, 'TaskCompleted')], { root: 1, 'sub-a': 0 }),
    )

    renderTrace()
    await screen.findByText('Turn 1')

    // The first request asks for everything; the second must carry *both*
    // streams. A scalar cursor here is the shipped defect: the subagent's
    // stream would restart from zero, or never advance at all.
    expect(fetchRawEvents.mock.calls[0][1]).toEqual({})

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(fetchRawEvents).toHaveBeenCalledTimes(2))
    expect(fetchRawEvents.mock.calls[1][1]).toEqual({ root: 0, 'sub-a': 0 })
    expect(await screen.findByText('TaskCompleted')).toBeTruthy()
  })

  it('switches the timeline between the root stream and a subagent stream', async () => {
    serve(
      page(
        [
          env('root', 0, 'LLMRequestStarted', { call_id: 'c', model: 'm' }),
          env('root', 1, 'SubtaskSpawned', { subtask_id: 'sub-a', agent_name: 'worker' }),
          env('sub-a', 0, 'ToolCallStarted'),
          env('sub-a', 1, 'ToolResultRecorded'),
        ],
        { root: 1, 'sub-a': 1 },
      ),
    )

    renderTrace()
    await screen.findByText('SubtaskSpawned')

    // The subagent's events belong to its own stream; the execution tree scopes to it.
    expect(screen.queryByText('ToolResultRecorded')).toBeNull()
    // "#1 worker" appears both as the timeline row's owner badge and the tree
    // button; the tree entry alone also carries the stream's event count.
    const treeButton = screen
      .getAllByRole('button', { name: /#1 worker/ })
      .find((b) => /events/.test(b.textContent ?? ''))
    fireEvent.click(treeButton!)

    expect(await screen.findByText('ToolCallStarted')).toBeTruthy()
    expect(screen.getByText('ToolResultRecorded')).toBeTruthy()
    expect(screen.queryByText('SubtaskSpawned')).toBeNull()

    // Back to the main stream.
    fireEvent.click(screen.getByRole('button', { name: /^main/ }))
    expect(await screen.findByText('SubtaskSpawned')).toBeTruthy()
  })

  it('summarises a compaction in the inspector with the reason of the request', async () => {
    serve(
      page(
        [
          env('root', 0, 'LLMRequestStarted', { call_id: 'c', model: 'm' }),
          env('root', 4, 'CompactionRequested', { reason: 'proactive' }),
          env('root', 5, 'Compacted', { replaced_count: 42 }),
        ],
        { root: 5 },
      ),
    )

    renderTrace()
    // The "folded N messages" detail surfaces in two places on purpose: the
    // Inspector's per-compaction card and the "Context & cache" panel's aggregate
    // "summary compaction" line. Both carry the request's reason. The timeline row
    // says "folded N" without "messages", so "messages" pins it to those two surfaces.
    expect((await screen.findAllByText(/folded 42 messages/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/proactive/).length).toBeGreaterThan(0)
  })

  it('says the log is empty rather than looking like it is still loading', async () => {
    serve(page([], {}))

    renderTrace()

    expect(await screen.findByText('No events yet.')).toBeTruthy()
  })

  it('surfaces a failure and retries on demand instead of polling into the void', async () => {
    fetchRawEvents.mockRejectedValueOnce(new Error('HTTP 404 Not Found'))
    fetchRawEvents.mockResolvedValue(
      page([env('root', 0, 'LLMRequestStarted', { call_id: 'c', model: 'm' })], { root: 0 }),
    )

    renderTrace()

    expect(await screen.findByText('HTTP 404 Not Found')).toBeTruthy()
    // The loop stopped: a silent retry against a 404 is indistinguishable from
    // a page that is working.
    expect(fetchRawEvents).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('Turn 1')).toBeTruthy()
    expect(screen.queryByText('HTTP 404 Not Found')).toBeNull()
  })
})
