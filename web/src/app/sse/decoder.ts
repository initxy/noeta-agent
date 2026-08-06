/**
 * An incremental decoder for the `text/event-stream` framing.
 *
 * We parse the wire ourselves instead of using `EventSource` because the
 * session stream needs things `EventSource` cannot express: a `since_seq`
 * cursor on reconnect, request headers, and — most of all — the ability to see
 * that a frame carried **no** `id:` line.
 *
 * That last point is the reason this is not a thin wrapper. The product's SSE
 * contract deliberately omits `id:` on ephemeral `delta` frames, so that a
 * reconnect cursor can never advance past an envelope the client never
 * received. The `EventSource` spec makes that invisible: its "last event ID"
 * buffer is *not* reset between events, so a frame without an id inherits the
 * previous one. `SseFrame.id` here is per-frame — `null` means "this frame
 * carried no id", which is the fact the resume logic is built on. Reproducing
 * the sticky behaviour would silently re-introduce the loss-on-reconnect bug
 * the contract exists to prevent.
 */

/**
 * What the SSE spec says an event is called when the block declared no
 * `event:` line. The product's vocabulary contains no frame of this name, so
 * seeing it is exactly the "block with no `event:`" case the contract says to
 * drop.
 */
export const DEFAULT_EVENT_TYPE = 'message'

export interface SseFrame {
  /** The `event:` field, or `"message"` when the frame declared none. */
  event: string
  /** The `data:` field(s), multiple lines joined by `\n`. */
  data: string
  /** The `id:` field of *this* frame; `null` when it carried none. */
  id: string | null
}

interface LineBreak {
  start: number
  end: number
}

/**
 * Find the next line terminator (LF, CRLF, or bare CR) at or after `from`.
 *
 * Returns `null` when no complete line is available — including the case of a
 * trailing CR at the very end of the buffer, which is ambiguous until the next
 * chunk shows whether an LF follows.
 */
function nextLineBreak(text: string, from: number): LineBreak | null {
  for (let i = from; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\n') return { start: i, end: i + 1 }
    if (char === '\r') {
      if (i + 1 >= text.length) return null
      return { start: i, end: text[i + 1] === '\n' ? i + 2 : i + 1 }
    }
  }
  return null
}

export class SseDecoder {
  #buffer = ''
  #eventType = ''
  #data = ''
  #id: string | null = null

  /** Feed one chunk of decoded text; returns every frame it completed. */
  push(chunk: string): SseFrame[] {
    const buffer = this.#buffer + chunk
    const frames: SseFrame[] = []
    let cursor = 0
    for (;;) {
      const lineBreak = nextLineBreak(buffer, cursor)
      if (!lineBreak) break
      const frame = this.#handleLine(buffer.slice(cursor, lineBreak.start))
      cursor = lineBreak.end
      if (frame) frames.push(frame)
    }
    this.#buffer = buffer.slice(cursor)
    return frames
  }

  /**
   * End of stream: emit a frame the terminating blank line never arrived for.
   *
   * The spec discards an unterminated trailing event; we do not, because a
   * cleanly closed response body is a complete message in our transport and
   * dropping it would lose the last frame of every replay.
   */
  flush(): SseFrame[] {
    const frames: SseFrame[] = []
    const residual = this.#buffer
    this.#buffer = ''
    if (residual) {
      const frame = this.#handleLine(residual)
      if (frame) frames.push(frame)
    }
    const pending = this.#dispatch()
    if (pending) frames.push(pending)
    return frames
  }

  #handleLine(line: string): SseFrame | null {
    if (line === '') return this.#dispatch()
    // A comment line. The backend emits `: connected` as the very first frame
    // so the browser hands the response to the reader before any real event.
    if (line.startsWith(':')) return null

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        this.#eventType = value
        break
      case 'data':
        this.#data += `${value}\n`
        break
      case 'id':
        // Per the spec an id containing NUL is ignored outright.
        if (!value.includes('\u0000')) this.#id = value
        break
      default:
        // `retry:` and anything unknown: ignored. Reconnection is driven by the
        // `since_seq` cursor, not by the transport's own backoff hint.
        break
    }
    return null
  }

  #dispatch(): SseFrame | null {
    const data = this.#data
    const eventType = this.#eventType
    const id = this.#id
    this.#data = ''
    this.#eventType = ''
    this.#id = null

    // No data means no event — a lone `event:` or `id:` line followed by a
    // blank line dispatches nothing.
    if (data === '') return null
    return {
      event: eventType || DEFAULT_EVENT_TYPE,
      data: data.endsWith('\n') ? data.slice(0, -1) : data,
      id,
    }
  }
}
