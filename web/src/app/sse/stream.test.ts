import { describe, expect, it, vi } from 'vitest'
import { readSseStream } from './stream'
import type { SseFetch, SseResponse } from './stream'
import { parseUIEvent } from './events'
import type { RawUIEvent } from '../types/ui-events'

/**
 * A response whose body arrives in exactly the chunks given — which is the
 * only way to test the two things that actually break: a frame split across a
 * network boundary, and a malformed frame in the middle of a good stream.
 */
function chunkedResponse(chunks: string[], status = 200): SseResponse {
  const encoder = new TextEncoder()
  let index = 0
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: () => Promise.resolve(chunks.join('')),
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            index < chunks.length
              ? { done: false, value: encoder.encode(chunks[index++]) }
              : { done: true, value: undefined },
          ),
      }),
    },
  }
}

const fetchOf = (response: SseResponse): SseFetch => () => Promise.resolve(response)

async function collect(chunks: string[]): Promise<RawUIEvent[]> {
  const events: RawUIEvent[] = []
  await readSseStream('/api/v1/sessions/s1/events', {
    onEvent: (event) => events.push(event),
    fetchImpl: fetchOf(chunkedResponse(chunks)),
  })
  return events
}

describe('readSseStream', () => {
  it('reads a hand-built chunked stream, including a split frame boundary', async () => {
    const events = await collect([
      ': connected\n\n',
      'id: 0\nevent: turn_started\ndata: {"_task":"t1"}\n\nid: 1\nevent: assist',
      'ant_text\ndata: {"text":"hel',
      'lo","_task":"t1"}\n\n',
    ])

    expect(events).toEqual([
      { seq: 0, type: 'turn_started', data: { _task: 't1' } },
      { seq: 1, type: 'assistant_text', data: { text: 'hello', _task: 't1' } },
    ])
  })

  it('skips a malformed JSON frame and keeps the stream alive', async () => {
    // Never tear down a connection over one bad frame: the same frame is in
    // the replay, so a reconnect would hit it again and the session would be
    // permanently unopenable.
    const events = await collect([
      'id: 1\nevent: assistant_text\ndata: {"text":"before"}\n\n',
      'id: 2\nevent: assistant_text\ndata: {"text":\n\n',
      'id: 3\nevent: assistant_text\ndata: {"text":"after"}\n\n',
    ])

    expect(events.map((event) => event.seq)).toEqual([1, 3])
    expect(events[1].data).toEqual({ text: 'after' })
  })

  it('flushes a trailing partial buffer at stream end', async () => {
    const events = await collect(['id: 9\nevent: turn_finished\ndata: {"status":"completed"}'])
    expect(events).toEqual([
      { seq: 9, type: 'turn_finished', data: { status: 'completed' } },
    ])
  })

  it('reports a frame with no id as seq null', async () => {
    // The property the whole transport rests on: a `delta` carries no `id:`,
    // so the resume cursor can never advance past an envelope never received.
    const events = await collect([
      'event: delta\ndata: {"call_id":"c1","kind":"text","text":"he","index":0}\n\n',
    ])
    expect(events[0].seq).toBeNull()
  })

  it('calls onOpen once the body is readable, before any frame', async () => {
    const seen: string[] = []
    await readSseStream('/api/v1/sessions/s1/events', {
      onOpen: () => seen.push('open'),
      onEvent: () => seen.push('event'),
      fetchImpl: fetchOf(chunkedResponse(['event: turn_started\ndata: {}\n\n'])),
    })
    expect(seen).toEqual(['open', 'event'])
  })

  it('rejects with the status on a non-2xx instead of opening', async () => {
    const onOpen = vi.fn()
    const failing: SseResponse = {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: () => Promise.resolve('{"error":{"code":"no_session","message":"gone"}}'),
      body: null,
    }

    await expect(
      readSseStream('/api/v1/sessions/nope/events', {
        onOpen,
        onEvent: () => {},
        fetchImpl: fetchOf(failing),
      }),
    ).rejects.toMatchObject({ status: 404, code: 'no_session', message: 'gone' })
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('parseUIEvent', () => {
  it('drops a block that declared no event type', () => {
    expect(parseUIEvent({ event: 'message', data: '{"text":"x"}', id: '1' })).toBeNull()
  })

  it('drops a block whose data is not a JSON object', () => {
    expect(parseUIEvent({ event: 'assistant_text', data: '"just a string"', id: null })).toBeNull()
    expect(parseUIEvent({ event: 'assistant_text', data: '[1,2]', id: null })).toBeNull()
  })

  it('treats a non-numeric id as no id rather than dropping the frame', () => {
    const event = parseUIEvent({ event: 'assistant_text', data: '{"text":"x"}', id: 'oops' })
    expect(event).toEqual({ seq: null, type: 'assistant_text', data: { text: 'x' } })
  })
})
