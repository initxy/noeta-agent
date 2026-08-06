import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentUrl, fetchModels } from './meta'
import { createProject, listConnectors, listProjects, updateProject } from './projects'
import {
  forkSession,
  interruptSession,
  listSessions,
  sendMessage,
  sessionEventsUrl,
} from './sessions'
import { fileRawUrl, listFiles, readFileText } from './files'
import { fetchRawEvents } from './trace'

interface Call {
  url: string
  method: string
  body: unknown
}

function stubFetch(body: unknown = {}, status = 200) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        text: () => Promise.resolve(JSON.stringify(body)),
      } as unknown as Response)
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('endpoint shapes', () => {
  it('sends a turn as a POST to the session messages path', async () => {
    const calls = stubFetch({ task_id: 't1' })

    await expect(
      sendMessage('s1', { text: 'hello', model: 'gpt', effort: 'high' }),
    ).resolves.toEqual({ task_id: 't1' })

    expect(calls[0]).toEqual({
      url: '/api/v1/sessions/s1/messages',
      method: 'POST',
      body: { text: 'hello', model: 'gpt', effort: 'high' },
    })
  })

  it('forks and returns the new child session and its root stream', async () => {
    const calls = stubFetch({ session_id: 's2', task_id: 't2' })
    const result = await forkSession('s1', { task_id: 't1', message_seq: 4 })
    expect(calls[0].url).toBe('/api/v1/sessions/s1/fork')
    expect(calls[0].body).toEqual({ task_id: 't1', message_seq: 4 })
    expect(result).toEqual({ session_id: 's2', task_id: 't2' })
  })

  it('interrupts with an empty body when no stream is named', async () => {
    const calls = stubFetch({})
    await interruptSession('s1')
    expect(calls[0]).toEqual({ url: '/api/v1/sessions/s1/interrupt', method: 'POST', body: {} })
  })

  it('patches a project without touching the fields it was not given', async () => {
    const calls = stubFetch({})
    await updateProject('p1', { tier: 'sandbox' })
    expect(calls[0]).toEqual({ url: '/api/v1/projects/p1', method: 'PATCH', body: { tier: 'sandbox' } })
  })

  it('creates a project with the tier and the directory flag', async () => {
    const calls = stubFetch({})
    await createProject({
      name: 'demo',
      directory: '/srv/demo',
      tier: 'local',
      create_directory: true,
    })
    expect(calls[0].body).toEqual({
      name: 'demo',
      directory: '/srv/demo',
      tier: 'local',
      create_directory: true,
    })
  })

  it('escapes path parameters instead of splicing them into a URL', async () => {
    const calls = stubFetch({})
    await listConnectors('p/1')
    expect(calls[0].url).toBe('/api/v1/projects/p%2F1/connectors')
  })

  it('reads a file through the text mode with the path in the query', async () => {
    const calls = stubFetch({ path: 'a.txt', content: 'x', truncated: false, mtime: 1 })
    await readFileText('s1', 'src/a.txt')
    expect(calls[0].url).toBe('/api/v1/sessions/s1/files/content?path=src%2Fa.txt&mode=text')
  })

  it('sends the trace cursor as a JSON map, and omits it when empty', async () => {
    const calls = stubFetch({ events: [], cursor: {} })

    await fetchRawEvents('s1', { root: 4, sub: 2 })
    await fetchRawEvents('s1', {})
    await fetchRawEvents('s1')

    // A map, not a scalar: each task stream counts seq independently, and a
    // single cursor read only the root stream.
    expect(calls[0].url).toBe(
      `/api/v1/trace/sessions/s1/raw-events?cursor=${encodeURIComponent('{"root":4,"sub":2}')}`,
    )
    expect(calls[1].url).toBe('/api/v1/trace/sessions/s1/raw-events')
    expect(calls[2].url).toBe('/api/v1/trace/sessions/s1/raw-events')
  })
})

describe('URL builders', () => {
  it('builds the events URL, omitting a cursor below zero', () => {
    expect(sessionEventsUrl('s1')).toBe('/api/v1/sessions/s1/events')
    expect(sessionEventsUrl('s1', -1)).toBe('/api/v1/sessions/s1/events')
    // seq space starts at 0, and the backend skips everything at or below the
    // cursor — so "nothing seen" cannot be spelled as 0.
    expect(sessionEventsUrl('s1', 0)).toBe('/api/v1/sessions/s1/events?since_seq=0')
    expect(sessionEventsUrl('s1', 12)).toBe('/api/v1/sessions/s1/events?since_seq=12')
    expect(sessionEventsUrl('s1', null)).toBe('/api/v1/sessions/s1/events')
  })

  it('builds content and raw-file URLs for direct browser use', () => {
    expect(contentUrl('abc123')).toBe('/api/v1/content/abc123')
    expect(fileRawUrl('s1', 'out/report.pdf')).toBe(
      '/api/v1/sessions/s1/files/content?path=out%2Freport.pdf&mode=raw',
    )
  })
})

describe('list responses', () => {
  it('reads an enveloped list', async () => {
    stubFetch({ projects: [{ id: 'p1' }] })
    await expect(listProjects()).resolves.toEqual([{ id: 'p1' }])
  })

  it('reads a bare array too', async () => {
    // The contract names the envelope for the lists it spells out but is
    // silent on projects and sessions; accepting both is cheaper than a
    // coin-flip that only fails on integration.
    stubFetch([{ id: 's1' }])
    await expect(listSessions('p1')).resolves.toEqual([{ id: 's1' }])
  })

  it('reads the envelopes the contract does spell out', async () => {
    stubFetch({ models: [{ id: 'm1' }] })
    await expect(fetchModels()).resolves.toEqual([{ id: 'm1' }])

    vi.unstubAllGlobals()
    stubFetch({ files: [{ path: 'a', size: 1, mtime: 2 }] })
    await expect(listFiles('s1')).resolves.toEqual([{ path: 'a', size: 1, mtime: 2 }])
  })

  it('degrades an unrecognised list payload to empty rather than throwing', async () => {
    stubFetch({ unexpected: true })
    await expect(listProjects()).resolves.toEqual([])
  })
})
