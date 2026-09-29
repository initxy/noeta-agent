/**
 * The session stream reader: `fetch` + `ReadableStream`, not `EventSource`.
 *
 * `EventSource` is rejected for three concrete reasons, not stylistic ones. It
 * cannot set request headers or credentials; it cannot be aborted cleanly, so
 * a session switch leaks a live connection until the browser feels like
 * closing it; and it reconnects on its own schedule with `Last-Event-ID`
 * semantics the backend does not implement — its "last event id" buffer is
 * *sticky* across events, so a frame with no `id:` inherits the previous one
 * and the resume cursor advances past envelopes that never arrived. The whole
 * transport is built so that omitting `id:` on an ephemeral frame makes
 * loss-on-reconnect impossible; `EventSource` would silently undo that.
 *
 * The reader is written against the narrowest possible view of a response —
 * `ok`, `status`, `statusText`, `text()` and a byte reader — so a test can
 * hand it a hand-built chunked stream without a server, a browser, or a real
 * `ReadableStream`.
 */

import { SseDecoder } from './decoder'
import { parseUIEvent } from './events'
import { ApiError, extractApiError } from '../api/client'
import type { RawUIEvent } from '../types/ui-events'

/** The slice of `ReadableStreamDefaultReader` this module actually uses. */
export interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
  cancel?(): Promise<void> | void
}

/** The slice of `Response` this module actually uses. */
export interface SseResponse {
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
  body: { getReader(): ByteStreamReader } | null
}

export type SseFetch = (url: string, init: RequestInit) => Promise<SseResponse>

export interface ReadSseOptions {
  signal?: AbortSignal
  /** Called once, as soon as the response headers arrive and the body is readable. */
  onOpen?: () => void
  /** Called for every frame that parsed. Malformed frames never reach it. */
  onEvent: (event: RawUIEvent) => void
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: SseFetch
}

const defaultFetch: SseFetch = (url, init) => fetch(url, init) as unknown as Promise<SseResponse>

/**
 * Read one SSE connection to completion.
 *
 * Resolves when the server closes the stream — which is a **normal** outcome,
 * not a success in the sense of "we are done": the backend closes on
 * disconnect detection and on shutdown, so the caller treats resolution and
 * rejection alike as "reconnect". Rejects on a non-2xx, on a bodyless
 * response, and on a transport failure mid-stream.
 */
export async function readSseStream(url: string, options: ReadSseOptions): Promise<void> {
  const { signal, onOpen, onEvent, fetchImpl = defaultFetch } = options

  const response = await fetchImpl(url, {
    headers: { Accept: 'text/event-stream' },
    // A conditional GET on an event stream is meaningless and some proxies
    // will happily serve a cached 200 with a finished body.
    cache: 'no-store',
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let body: unknown
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined
    } catch {
      body = undefined
    }
    const { message, code } = extractApiError(response.status, response.statusText, body)
    throw new ApiError(message, response.status, code, body)
  }
  if (!response.body) {
    throw new ApiError('Event stream response had no body', response.status, 'no_stream_body')
  }

  onOpen?.()

  const reader = response.body.getReader()
  const decoder = new SseDecoder()
  const textDecoder = new TextDecoder()

  const emit = (chunk: string) => {
    for (const frame of decoder.push(chunk)) {
      const event = parseUIEvent(frame)
      if (event) onEvent(event)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && value.length > 0) emit(textDecoder.decode(value, { stream: true }))
    }
    // Flush the decoder's pending bytes *and* the decoder's pending block: a
    // cleanly closed body is a complete message in this transport, so the last
    // frame of a replay must not be discarded for want of a trailing newline.
    emit(textDecoder.decode())
    for (const frame of decoder.flush()) {
      const event = parseUIEvent(frame)
      if (event) onEvent(event)
    }
  } finally {
    // Releasing the body is best-effort: on an abort the reader is already
    // errored, and letting that throw here would replace the real reason the
    // stream ended with a cancellation artefact.
    try {
      await reader.cancel?.()
    } catch {
      /* the stream is going away regardless */
    }
  }
}
