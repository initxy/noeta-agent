import { describe, expect, it } from 'vitest'
import { SseDecoder } from './decoder'

describe('SseDecoder', () => {
  it('decodes a frame with an event, data and id', () => {
    const decoder = new SseDecoder()
    const frames = decoder.push('event: turn_started\ndata: {"seq":7}\nid: 7\n\n')

    expect(frames).toEqual([{ event: 'turn_started', data: '{"seq":7}', id: '7' }])
  })

  it('reports a missing id as null instead of inheriting the previous frame', () => {
    // The contract that depends on this: `delta` frames carry no `id:` line so
    // a resume cursor cannot advance past an envelope the client never got.
    // EventSource's sticky last-event-id would hide exactly that.
    const decoder = new SseDecoder()
    const frames = decoder.push(
      'event: assistant_text\ndata: hello\nid: 12\n\nevent: delta\ndata: he\n\n',
    )

    expect(frames.map((frame) => frame.id)).toEqual(['12', null])
  })

  it('buffers across chunk boundaries, including a split line and a split terminator', () => {
    const decoder = new SseDecoder()

    expect(decoder.push('event: to')).toEqual([])
    expect(decoder.push('ol_call\ndata: {"na')).toEqual([])
    expect(decoder.push('me":"read"}\r')).toEqual([])
    expect(decoder.push('\n\r\n')).toEqual([
      { event: 'tool_call', data: '{"name":"read"}', id: null },
    ])
  })

  it('joins multiple data lines with a newline and defaults the event name', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: one\ndata: two\n\n')).toEqual([
      { event: 'message', data: 'one\ntwo', id: null },
    ])
  })

  it('ignores comment lines, including the `: connected` preamble', () => {
    const decoder = new SseDecoder()

    expect(decoder.push(': connected\n\n')).toEqual([])
    expect(decoder.push('data: after\n\n')).toEqual([{ event: 'message', data: 'after', id: null }])
  })

  it('strips only one leading space and preserves the rest of the value', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data:  padded \n\n')[0].data).toBe(' padded ')
  })

  it('dispatches nothing for a frame that carried no data', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('event: noop\nid: 3\n\n')).toEqual([])
  })

  it('emits a trailing frame on flush when the stream ends without a blank line', () => {
    const decoder = new SseDecoder()

    expect(decoder.push('event: turn_finished\ndata: {}')).toEqual([])
    expect(decoder.flush()).toEqual([{ event: 'turn_finished', data: '{}', id: null }])
    expect(decoder.flush()).toEqual([])
  })
})
