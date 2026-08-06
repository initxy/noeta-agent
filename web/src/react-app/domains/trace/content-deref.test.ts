import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_PREVIEW_CHARS, derefContent } from './content-deref'

/**
 * Dereferencing one blob. The endpoint returns raw bytes with a sniffed
 * content type — the ContentStore has no metadata read interface — so this is
 * the one place in the domain that reads a `Response` by hand.
 */

function respond(body: BodyInit, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (_input: unknown) => {
    if (response instanceof Error) throw response
    return response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const HASH = 'b'.repeat(64)

describe('derefContent', () => {
  it('asks for the blob by hash and re-indents a JSON body', async () => {
    const fetchMock = stubFetch(respond('{"tool":"read_file","ok":true}', 'application/json'))

    const content = await derefContent(HASH)

    expect(String(fetchMock.mock.calls[0][0])).toContain(`/content/${HASH}`)
    expect(content.text).toBe('{\n  "tool": "read_file",\n  "ok": true\n}')
    expect(content.truncated).toBe(false)
    expect(content.mediaType).toBe('application/json')
  })

  it('leaves a body that is not JSON exactly as it came', async () => {
    stubFetch(respond('line one\nline two', 'text/plain; charset=utf-8'))

    const content = await derefContent(HASH)

    expect(content.text).toBe('line one\nline two')
    // The charset parameter is dropped: the media type is what the UI switches on.
    expect(content.mediaType).toBe('text/plain')
  })

  it('clips a long body and says so, keeping the whole-body link honest', async () => {
    const body = 'z'.repeat(CONTENT_PREVIEW_CHARS + 500)
    stubFetch(respond(body, 'text/plain'))

    const content = await derefContent(HASH)

    expect(content.text).toHaveLength(CONTENT_PREVIEW_CHARS)
    expect(content.truncated).toBe(true)
    expect(content.byteLength).toBe(body.length)
  })

  it('hands an image to the browser instead of decoding it as text', async () => {
    stubFetch(respond(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'))

    const content = await derefContent(HASH)

    expect(content.text).toBeNull()
    expect(content.url).toContain(HASH)
  })

  it('reports a missing blob rather than rendering an empty body', async () => {
    stubFetch(respond('', 'text/plain', 404))

    await expect(derefContent(HASH)).rejects.toThrow(/404/)
  })
})
