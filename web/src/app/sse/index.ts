/**
 * The SSE reader.
 *
 * Four modules in dependency order: `decoder` turns bytes into
 * `text/event-stream` frames, `events` turns one frame into a UI event (or
 * skips it), `stream` drives a single connection to its end, and `reconnect`
 * keeps one alive across the drops a local backend produces every time it
 * reloads.
 */

export { DEFAULT_EVENT_TYPE, SseDecoder } from './decoder'
export type { SseFrame } from './decoder'
export { parseUIEvent } from './events'
export { readSseStream } from './stream'
export type { ByteStreamReader, ReadSseOptions, SseFetch, SseResponse } from './stream'
export { SSE_MAX_BACKOFF_MS, openSessionStream, sseRetryDelay } from './reconnect'
export type { SessionStream, SessionStreamOptions } from './reconnect'
