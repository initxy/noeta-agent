import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { composerActions, useComposerStore } from '../state/composer-store'
import {
  MAX_STORED_DRAFTS,
  clearStoredDrafts,
  loadDraft,
  saveDraft,
  useDraftPersistence,
} from './drafts'

beforeEach(() => {
  clearStoredDrafts()
  useComposerStore.setState({ drafts: {}, choices: {}, steering: {} })
})

describe('storage', () => {
  it('round-trips a draft per key', () => {
    saveDraft('s1', 'half a thought')
    saveDraft('s2', 'another one')
    expect(loadDraft('s1')).toBe('half a thought')
    expect(loadDraft('s2')).toBe('another one')
    expect(loadDraft('s3')).toBe('')
  })

  it('deletes rather than storing an empty draft', () => {
    saveDraft('s1', 'text')
    saveDraft('s1', '')
    expect(loadDraft('s1')).toBe('')
    // Every session ever visited would otherwise hold a permanent empty entry
    // and spend the eviction cap on nothing.
    expect(JSON.parse(localStorage.getItem('noeta.session-drafts.v1') ?? '{}')).toEqual({})
  })

  it('evicts the oldest write past the cap, and a re-save counts as new', () => {
    for (let index = 0; index < MAX_STORED_DRAFTS; index += 1) saveDraft(`s${index}`, `d${index}`)
    // Touching the oldest moves it to the newest position.
    saveDraft('s0', 'refreshed')
    saveDraft('overflow', 'newest')

    expect(loadDraft('s0')).toBe('refreshed')
    expect(loadDraft('s1')).toBe('')
    expect(loadDraft('overflow')).toBe('newest')
  })

  it('survives a reload, and skips a malformed entry rather than losing the rest', () => {
    // `clearStoredDrafts` drops the cache back to "not hydrated", so this is
    // a real re-read of storage rather than a read of what we just wrote.
    localStorage.setItem(
      'noeta.session-drafts.v1',
      JSON.stringify({ s1: 'kept', s2: 42, s3: '', s4: 'also kept' }),
    )
    expect(loadDraft('s1')).toBe('kept')
    expect(loadDraft('s4')).toBe('also kept')
    // One bad value written by an older build must not cost every other draft.
    expect(loadDraft('s2')).toBe('')
  })

  it('treats unparseable storage as empty rather than throwing', () => {
    localStorage.setItem('noeta.session-drafts.v1', 'not json')
    expect(loadDraft('s1')).toBe('')
    expect(() => saveDraft('s1', 'fresh')).not.toThrow()
    expect(loadDraft('s1')).toBe('fresh')
  })
})

describe('useDraftPersistence', () => {
  it('restores on return and writes through on every change', () => {
    saveDraft('s1', 'where I left off')
    const { unmount } = renderHook(() => useDraftPersistence('s1'))
    expect(useComposerStore.getState().drafts.s1).toBe('where I left off')

    act(() => composerActions().setDraft('s1', 'where I left off, continued'))
    expect(loadDraft('s1')).toBe('where I left off, continued')

    unmount()
    // Unmounted means unsubscribed; a background session must not overwrite.
    act(() => composerActions().setDraft('s1', 'typed after unmount'))
    expect(loadDraft('s1')).toBe('where I left off, continued')
  })

  it('never overwrites a live draft with a stored one', () => {
    saveDraft('s1', 'stored')
    composerActions().setDraft('s1', 'what the user can see')
    renderHook(() => useDraftPersistence('s1'))
    expect(useComposerStore.getState().drafts.s1).toBe('what the user can see')
  })

  it('does not delete the stored draft while restoring it', () => {
    // The restore and the write-through are one effect for exactly this
    // reason: as two, the save of the empty box races the restore that was
    // about to replace it.
    saveDraft('s1', 'fragile')
    renderHook(() => useDraftPersistence('s1'))
    expect(loadDraft('s1')).toBe('fragile')
    expect(useComposerStore.getState().drafts.s1).toBe('fragile')
  })

  it('follows the key when the session changes', () => {
    saveDraft('s1', 'one')
    saveDraft('s2', 'two')
    const { rerender } = renderHook(({ key }: { key: string }) => useDraftPersistence(key), {
      initialProps: { key: 's1' },
    })
    expect(useComposerStore.getState().drafts.s1).toBe('one')

    rerender({ key: 's2' })
    expect(useComposerStore.getState().drafts.s2).toBe('two')

    act(() => composerActions().setDraft('s2', 'two, edited'))
    expect(loadDraft('s2')).toBe('two, edited')
    // The session left behind keeps what it had.
    expect(loadDraft('s1')).toBe('one')
  })

  it('clears the stored draft when the composer is emptied by a send', () => {
    saveDraft('s1', 'sent text')
    renderHook(() => useDraftPersistence('s1'))
    act(() => composerActions().clearDraft('s1'))
    expect(loadDraft('s1')).toBe('')
  })
})
