/**
 * Drafts that survive leaving.
 *
 * The composer store already keeps a draft per session in memory, which covers
 * switching sessions. This covers the other three ways a person leaves: closing
 * the tab, reloading, and crashing. Losing a half-written message to a refresh
 * is the kind of loss nobody files a bug about and nobody forgives.
 *
 * It is possible at all because **the draft is one plain string** — the
 * decision made in `state/composer-store.ts` and kept through the composer's
 * whole build-out. Mentions, slash commands and pasted-text chips are bracket
 * tokens *inside* that string, so persisting a draft is `JSON.stringify` and
 * restoring one is assignment. A structured editor model here would need a
 * serializer, a version, and a migration the first time a node type changed.
 *
 * The one thing a string cannot carry is a `File`, which is why image
 * attachments are **not** persisted: a `blob:` URL is dead the moment the
 * document that minted it is gone, and restoring a preview that renders as a
 * broken image is worse than restoring nothing.
 *
 * There is deliberately **no "carry the draft across a key rename"** helper.
 * The only rename in this product is `@new` → a session id, and it happens on
 * the send that *consumes* the draft — carrying it would restore, under the new
 * key, the message that was just dispatched. The rejection path does not need
 * one either: the composer has already re-mounted under the session id by the
 * time a refusal lands, so putting the text back writes it through to storage
 * under the right key on its own.
 *
 * Storage is a plain key→text map with insertion-order eviction. `localStorage`
 * that throws — Safari private mode, a disabled-storage policy, a full quota —
 * degrades to an in-memory map: drafts then live exactly as long as the tab,
 * which is what they would have done with no persistence at all.
 */

import { useEffect } from 'react'
import { composerActions, useComposerStore } from '../state/composer-store'

const STORAGE_KEY = 'noeta.session-drafts.v1'

/**
 * How many sessions keep a stored draft.
 *
 * A cap, because `localStorage` is a few megabytes shared with everything else
 * the origin stores, and an uncapped map of every session ever opened is a
 * quota error waiting for the user with the longest history.
 */
export const MAX_STORED_DRAFTS = 100

/** Insertion-ordered; the oldest *write* is evicted first. */
let cache: Map<string, string> | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function hydrate(): Map<string, string> {
  if (cache !== null) return cache
  const map = new Map<string, string>()
  cache = map
  const store = storage()
  if (store === null) return map
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null) return map
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return map
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A malformed entry is skipped, not thrown on. One bad value written by
      // an older build must not cost the user every other draft.
      if (typeof value === 'string' && value !== '') map.set(key, value)
    }
  } catch {
    // Unparseable storage is treated as empty; the next write replaces it.
  }
  return map
}

function flush(map: Map<string, string>): void {
  const store = storage()
  if (store === null) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Over quota or storage denied. The in-memory map stays authoritative for
    // this tab; there is nothing useful to tell the user about it.
  }
}

/** The stored draft for a key, or `''`. */
export function loadDraft(key: string): string {
  if (key === '') return ''
  return hydrate().get(key) ?? ''
}

/**
 * Store a draft. Empty **deletes** rather than storing `""`.
 *
 * Otherwise every session ever visited would hold a permanent empty entry and
 * the eviction cap would be spent on sessions with nothing to restore.
 */
export function saveDraft(key: string, text: string): void {
  if (key === '') return
  const map = hydrate()
  if (text === '') {
    if (!map.delete(key)) return
    flush(map)
    return
  }
  // Delete before set so the key moves to the newest insertion position —
  // eviction is recency of write, and re-setting an existing key would
  // otherwise leave it stranded at its original position.
  map.delete(key)
  map.set(key, text)
  while (map.size > MAX_STORED_DRAFTS) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
  flush(map)
}

/**
 * Drop every stored draft and the cache over it.
 *
 * The cache goes back to "not hydrated" rather than to an empty map, so the
 * next read re-reads storage. That is what makes this the honest simulation of
 * a reload, and it is the only reason a stale in-process cache cannot outlive
 * the data it was caching.
 */
export function clearStoredDrafts(): void {
  cache = null
  const store = storage()
  if (store === null) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do; the next read will hydrate from whatever is there.
  }
}

/**
 * Keep one composer key in sync with storage, both ways.
 *
 * Restore happens once per key, and **only into an empty box**: a live draft
 * always wins, because it is what the user can see. The write-through is a
 * store subscription rather than an effect on the draft value, which keeps the
 * restore from racing a save of the empty string it was about to replace, and
 * keeps a keystroke from costing a React render it would not otherwise need.
 */
export function useDraftPersistence(key: string): void {
  useEffect(() => {
    if (key === '') return
    const stored = loadDraft(key)
    if (stored !== '' && (composerActions().drafts[key] ?? '') === '') {
      composerActions().setDraft(key, stored)
    }
    return useComposerStore.subscribe((state, previous) => {
      const next = state.drafts[key] ?? ''
      if (next === (previous.drafts[key] ?? '')) return
      saveDraft(key, next)
    })
  }, [key])
}
