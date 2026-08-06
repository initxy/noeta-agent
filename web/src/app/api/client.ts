/**
 * The typed fetch wrapper over the product's REST surface.
 *
 * Framework-agnostic by contract (D9): nothing in `app/` may import React. The
 * layer above (`react-app/infra`) is what wraps these calls in TanStack Query;
 * this module only knows how to talk to `/api/v1` and how to fail usefully.
 *
 * The failure path is the reason this module exists. Callers need three facts
 * that a bare `fetch` throws away: whether the request reached the server at
 * all, the HTTP status, and the machine-readable error code when the backend
 * sent one. Everything is funnelled into `ApiError` so a caller never has to
 * inspect two unrelated exception families.
 */

import type { ApiErrorBody, ValidationErrorEntry } from '../types/wire'

/** Every product endpoint lives under the versioned prefix. */
export const API_BASE = '/api/v1'

/**
 * `status === 0` means the request never produced an HTTP response — DNS,
 * connection refused, the backend not up yet. It is a distinct rendering case
 * (retry) from any real status, so it gets a reserved value rather than a flag.
 */
export const NETWORK_ERROR_STATUS = 0

export class ApiError extends Error {
  readonly status: number
  /** Backend error code when one was sent; `"network"` for transport failures. */
  readonly code: string | null
  /** The parsed response body, when it was JSON. */
  readonly body: unknown

  constructor(message: string, status: number, code: string | null, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }

  /** Transport failure — the request never reached the backend. */
  get isNetworkError(): boolean {
    return this.status === NETWORK_ERROR_STATUS
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

export interface ApiRequestInit {
  method?: string
  /** Serialized as the JSON request body; sets the content type. */
  json?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}

interface ParsedJson {
  ok: boolean
  value: unknown
}

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, value: undefined }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCoded(value: unknown): { code: string | null; message: string | null } | null {
  if (!isRecord(value)) return null
  const code = typeof value.code === 'string' ? value.code : null
  const message = typeof value.message === 'string' ? value.message : null
  return code === null && message === null ? null : { code, message }
}

/**
 * The wrapper segments FastAPI puts in front of a field's own path.
 *
 * `["body", "directory"]` is about the field `directory`; leading the message
 * with "body." tells the reader nothing they did not already know.
 */
const LOC_WRAPPERS = new Set(['body', 'query', 'path', 'header', 'cookie'])

function formatValidationEntry(entry: unknown): string | null {
  if (!isRecord(entry)) return null
  const { msg, loc } = entry as ValidationErrorEntry
  if (typeof msg !== 'string' || !msg) return null
  if (!Array.isArray(loc)) return msg

  const parts = loc.map((part) => String(part))
  if (parts.length > 1 && LOC_WRAPPERS.has(parts[0])) parts.shift()
  const field = parts.join('.')
  return field ? `${field}: ${msg}` : msg
}

/**
 * Reduce whatever the backend sent to `(message, code)`.
 *
 * Exported because it is the part worth testing directly. The shapes it walks:
 *
 * - FastAPI's `{detail: "…"}` from a hand-raised `HTTPException`;
 * - **FastAPI's `{detail: [{loc, msg, type}, …]}` from a
 *   `RequestValidationError`** — the shape that made every 422 read as a bare
 *   "HTTP 422 Unprocessable Entity" and threw away the only sentence that says
 *   *which field* was wrong. `POST /projects` with a relative directory hits
 *   this on the product's very first form;
 * - our own coded errors, `{error: {code, message}}` and the legacy
 *   `{detail: {code, message}}`, and a bare `{code, message}`.
 *
 * Anything else — HTML from a proxy, an empty body — falls back to the status
 * line, which is always present.
 */
export function extractApiError(
  status: number,
  statusText: string,
  body: unknown,
): { message: string; code: string | null } {
  const fallback = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`
  if (!isRecord(body)) return { message: fallback, code: null }

  if (typeof body.detail === 'string' && body.detail) {
    return { message: body.detail, code: null }
  }
  if (Array.isArray(body.detail)) {
    const messages = body.detail
      .map(formatValidationEntry)
      .filter((m): m is string => m !== null)
    // No `code`: a validation failure is fully described by its 422 and its
    // field path, and inventing a slug here would collide with a real one the
    // backend adds later.
    return { message: messages.length ? messages.join('; ') : fallback, code: null }
  }
  const nested = readCoded(body.detail) ?? readCoded(body.error) ?? readCoded(body)
  if (nested) {
    return { message: nested.message ?? fallback, code: nested.code }
  }
  return { message: fallback, code: null }
}

/**
 * Perform one request against `/api/v1`.
 *
 * A 204 (or any empty body) resolves to `undefined`; callers that type such an
 * endpoint as `void` get exactly that. A non-2xx always throws `ApiError`.
 *
 * The response body is read as text and parsed by hand rather than through
 * `response.json()`: an error page from a dev proxy is not JSON, and the
 * failure we want to report then is the HTTP status, not a parse error.
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { method = 'GET', json, signal, headers } = init

  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...headers }
  let requestBody: string | undefined
  if (json !== undefined) {
    requestHeaders['Content-Type'] = 'application/json'
    requestBody = JSON.stringify(json)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal,
    })
  } catch (error) {
    // An abort is the caller's own decision (query cancellation, unmount) and
    // must stay distinguishable from a backend that is down.
    if (error instanceof Error && error.name === 'AbortError') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(message, NETWORK_ERROR_STATUS, 'network')
  }

  const text = await response.text()
  const parsed = text ? parseJson(text) : { ok: true, value: undefined }

  if (!response.ok) {
    const body: ApiErrorBody | unknown = parsed.ok ? parsed.value : undefined
    const { message, code } = extractApiError(response.status, response.statusText, body)
    throw new ApiError(message, response.status, code, body)
  }

  if (!parsed.ok) {
    throw new ApiError(
      'Response was not valid JSON',
      response.status,
      'invalid_response',
      undefined,
    )
  }
  return parsed.value as T
}

/**
 * Build a query string, dropping every parameter that has no value.
 *
 * `undefined` and `null` are dropped rather than serialized: `?task_id=null`
 * reaches the backend as the four-character string "null" and filters the
 * stream down to nothing, which is a long afternoon to debug.
 */
export function queryString(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

/**
 * Read a list response, accepting either a bare array or an envelope.
 *
 * The contract spells out the envelope for the lists it names (`{models: …}`,
 * `{files: …}`) but is silent on projects and sessions. Rather than guess and
 * hard-fail on integration, this accepts both and normalises. It is a small
 * seam to delete once the backend's shape is fixed — not a permanent licence
 * for the wire to be two things.
 */
export function readList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (isRecord(payload) && Array.isArray(payload[key])) return payload[key] as T[]
  return []
}
