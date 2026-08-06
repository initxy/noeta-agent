import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiRequest, extractApiError, isApiError } from './client'

/**
 * A minimal stand-in for `Response`. The client reads exactly four things —
 * `ok`, `status`, `statusText`, `text()` — so the fake states that contract
 * instead of dragging in a real fetch implementation.
 */
function fakeResponse(status: number, body: string, statusText = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

function stubFetch(impl: (input: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl)
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apiRequest', () => {
  it('prefixes the versioned API base and returns the parsed body', async () => {
    const fetchSpy = stubFetch(() => Promise.resolve(fakeResponse(200, '{"ok":true}')))

    await expect(apiRequest<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true })
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/v1/health')
  })

  it('resolves to undefined on an empty body', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(204, '')))
    await expect(apiRequest<void>('/sessions/abc', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('sends a JSON body with the content type set', async () => {
    const fetchSpy = stubFetch(() => Promise.resolve(fakeResponse(200, '{}')))

    await apiRequest('/projects', { method: 'POST', json: { name: 'demo' } })

    const init = fetchSpy.mock.calls[0][1]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"demo"}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('reports a transport failure as status 0 so it is distinguishable from any HTTP status', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))

    const error = await apiRequest('/health').catch((caught: unknown) => caught)

    expect(isApiError(error)).toBe(true)
    const apiError = error as ApiError
    expect(apiError.status).toBe(0)
    expect(apiError.code).toBe('network')
    expect(apiError.isNetworkError).toBe(true)
  })

  it('rethrows an abort untouched — a cancelled request is not a backend failure', async () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    stubFetch(() => Promise.reject(abort))

    const error = await apiRequest('/health').catch((caught: unknown) => caught)

    expect(isApiError(error)).toBe(false)
    expect(error).toBe(abort)
  })

  it('throws ApiError carrying the status and the backend code on a non-2xx', async () => {
    stubFetch(() =>
      Promise.resolve(fakeResponse(409, '{"detail":{"code":"not_forkable","message":"no"}}')),
    )

    const error = (await apiRequest('/sessions/abc/fork', { method: 'POST' }).catch(
      (caught: unknown) => caught,
    )) as ApiError

    expect(isApiError(error)).toBe(true)
    expect(error.status).toBe(409)
    expect(error.code).toBe('not_forkable')
    expect(error.message).toBe('no')
  })

  it('falls back to the status line when the error body is not JSON', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(502, '<html>bad gateway</html>', 'Bad Gateway')))

    const error = (await apiRequest('/health').catch((caught: unknown) => caught)) as ApiError

    expect(error.status).toBe(502)
    expect(error.code).toBeNull()
    expect(error.message).toBe('HTTP 502 Bad Gateway')
  })

  it('rejects a 2xx whose body is not JSON rather than handing back garbage', async () => {
    stubFetch(() => Promise.resolve(fakeResponse(200, 'not json')))

    const error = (await apiRequest('/health').catch((caught: unknown) => caught)) as ApiError

    expect(error.code).toBe('invalid_response')
  })
})

describe('extractApiError', () => {
  it("reads FastAPI's string detail", () => {
    expect(extractApiError(404, 'Not Found', { detail: 'no such session' })).toEqual({
      message: 'no such session',
      code: null,
    })
  })

  it('reads a coded error under `error`', () => {
    expect(
      extractApiError(409, 'Conflict', { error: { code: 'stale_write', message: 'changed' } }),
    ).toEqual({ message: 'changed', code: 'stale_write' })
  })

  it('reads a bare coded error', () => {
    expect(extractApiError(400, 'Bad Request', { code: 'bad_input' })).toEqual({
      message: 'HTTP 400 Bad Request',
      code: 'bad_input',
    })
  })

  it('falls back to the status alone when there is no status text', () => {
    expect(extractApiError(500, '', undefined)).toEqual({ message: 'HTTP 500', code: null })
  })

  // FastAPI's own RequestValidationError returns `detail` as an ARRAY, which
  // matched none of the shapes above and degraded every 422 to a bare "HTTP 422
  // Unprocessable Entity" — throwing away the one sentence that says which
  // field was wrong. `POST /projects` with a relative directory hits it on the
  // product's very first form.
  it("reads FastAPI's validation-error array and names the field", () => {
    expect(
      extractApiError(422, 'Unprocessable Entity', {
        detail: [
          { loc: ['body', 'directory'], msg: 'directory must be absolute', type: 'value_error' },
        ],
      }),
    ).toEqual({ message: 'directory: directory must be absolute', code: null })
  })

  it('joins several validation errors and keeps nested field paths', () => {
    expect(
      extractApiError(422, 'Unprocessable Entity', {
        detail: [
          { loc: ['body', 'images', 0, 'media_type'], msg: 'unsupported type' },
          { loc: ['body', 'name'], msg: 'field required' },
        ],
      }),
    ).toEqual({
      message: 'images.0.media_type: unsupported type; name: field required',
      code: null,
    })
  })

  it('falls back to the status line when the validation array carries nothing usable', () => {
    expect(extractApiError(422, 'Unprocessable Entity', { detail: [] })).toEqual({
      message: 'HTTP 422 Unprocessable Entity',
      code: null,
    })
    expect(extractApiError(422, 'Unprocessable Entity', { detail: [{ type: 'x' }] })).toEqual({
      message: 'HTTP 422 Unprocessable Entity',
      code: null,
    })
  })

  it('keeps a bare message when the entry has no loc', () => {
    expect(extractApiError(422, '', { detail: [{ msg: 'body is required' }] })).toEqual({
      message: 'body is required',
      code: null,
    })
  })
})
