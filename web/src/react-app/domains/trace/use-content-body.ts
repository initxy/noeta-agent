/**
 * Dereference one `ContentRef` to its text body, with a module-level cache.
 *
 * Distinct from `content-deref.ts` on purpose: that resolves a blob *on click*
 * for the `ContentRefChip` (fetch, abort, one-shot). This is the *automatic*
 * path a turn view needs — the LLM request/response bodies and the context plan
 * are ContentRefs the turn must read to render at all, so they resolve as soon
 * as the turn is shown, and the same hash is fetched once for the whole page.
 *
 * The cache is bounded on two axes — entry count and total decoded characters —
 * and evicts oldest-first once either ceiling is crossed (Map iteration order is
 * insertion order; a hit is moved to the tail for LRU). Eviction only touches
 * the cache: a body a component already holds is unaffected, and re-expanding
 * re-fetches. Failures are not cached, so a transient error can be retried.
 *
 * Content is addressed by hash and immutable, which is what makes caching safe.
 * `GET /api/v1/content/{hash}` returns raw bytes; the URL is still built by
 * `app/api` so no endpoint knowledge leaks into the domain.
 */
import { useEffect, useState } from 'react'
import { contentUrl } from '@/app/api'

const MAX_ENTRIES = 64
// Decoded-character budget (~32MB under UTF-16). A single body over budget is
// still shown; it just does not stay resident in the cache.
const MAX_TOTAL_CHARS = 16 * 1024 * 1024

interface CacheEntry {
  promise: Promise<string>
  /** Written to body.length on resolve; 0 while pending, not counted against budget. */
  chars: number
}

const bodyCache = new Map<string, CacheEntry>()
let totalChars = 0

function evict(): void {
  for (const [hash, entry] of bodyCache) {
    if (bodyCache.size <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) return
    bodyCache.delete(hash)
    totalChars -= entry.chars
  }
}

function drop(hash: string): void {
  const entry = bodyCache.get(hash)
  if (entry) {
    bodyCache.delete(hash)
    totalChars -= entry.chars
  }
}

function fetchBody(hash: string): Promise<string> {
  const hit = bodyCache.get(hash)
  if (hit) {
    // LRU touch: move to the tail of insertion order.
    bodyCache.delete(hash)
    bodyCache.set(hash, hit)
    return hit.promise
  }
  const entry: CacheEntry = {
    promise: fetch(contentUrl(hash), { headers: { Accept: '*/*' } }).then(async (res) => {
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'Content not found' : `Failed to load content (${res.status})`)
      }
      return res.text()
    }),
    chars: 0,
  }
  entry.promise.then(
    (body) => {
      // It may have been evicted or replaced while pending; only count a body
      // whose entry is still the one in the cache.
      if (bodyCache.get(hash) === entry) {
        entry.chars = body.length
        totalChars += body.length
        evict()
      }
    },
    () => drop(hash),
  )
  bodyCache.set(hash, entry)
  evict()
  return entry.promise
}

export interface ContentBodyState {
  body: string | null
  loading: boolean
  error: string | null
}

/** A `null` hash issues no request (lazy deref: only a shown ref resolves). */
export function useContentBody(hash: string | null): ContentBodyState {
  const [state, setState] = useState<ContentBodyState>({
    body: null,
    loading: hash != null,
    error: null,
  })

  useEffect(() => {
    if (!hash) {
      setState({ body: null, loading: false, error: null })
      return
    }
    let alive = true
    setState({ body: null, loading: true, error: null })
    fetchBody(hash).then(
      (body) => alive && setState({ body, loading: false, error: null }),
      (e: Error) => alive && setState({ body: null, loading: false, error: e.message }),
    )
    return () => {
      alive = false
    }
  }, [hash])

  return state
}
