/**
 * Resolving one `ContentRef` to bytes.
 *
 * Deliberately **on demand**. A page of envelopes can reference dozens of
 * blobs — every clipped tool output, every thinking block, every question spec
 * — and resolving them to render a list would pull megabytes for bodies nobody
 * opened. The hash is the capability: this asks for bytes the trace already
 * showed a reference to, and nothing else.
 *
 * `GET /api/v1/content/{hash}` returns raw bytes with a sniffed content type,
 * which is why this is a bare `fetch` rather than the JSON client — the URL is
 * still built by `app/api`, so no endpoint knowledge leaks into the domain.
 */

import { contentUrl } from '@/app/api'

/** Characters of a text body kept for display; the rest is a click away in the file. */
export const CONTENT_PREVIEW_CHARS = 4000

export interface DerefedContent {
  hash: string
  mediaType: string
  /** Decoded text, or `null` when the body is an image rendered from `url`. */
  text: string | null
  /** True when `text` is a prefix of the body. */
  truncated: boolean
  byteLength: number
  /** The blob's own URL, for an image or a new-tab link. */
  url: string
}

/** Re-indent a JSON body so a one-line blob reads as a structure. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export async function derefContent(hash: string, signal?: AbortSignal): Promise<DerefedContent> {
  const url = contentUrl(hash)
  const response = await fetch(url, { signal, headers: { Accept: '*/*' } })
  if (!response.ok) {
    throw new Error(`Content is not available (HTTP ${response.status})`)
  }

  const mediaType = (response.headers.get('Content-Type') ?? 'application/octet-stream')
    .split(';')[0]
    .trim()
  const buffer = await response.arrayBuffer()

  if (mediaType.startsWith('image/')) {
    return { hash, mediaType, text: null, truncated: false, byteLength: buffer.byteLength, url }
  }

  const decoded = prettyJson(new TextDecoder().decode(buffer))
  const truncated = decoded.length > CONTENT_PREVIEW_CHARS
  return {
    hash,
    mediaType,
    text: truncated ? decoded.slice(0, CONTENT_PREVIEW_CHARS) : decoded,
    truncated,
    byteLength: buffer.byteLength,
    url,
  }
}
