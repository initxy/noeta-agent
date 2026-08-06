import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { conflictMtime, isWriteConflict } from './artifacts'

/**
 * The 409 is the point of this module. The reference had no error branch at
 * all, so a save that lost the optimistic lock was indistinguishable from a
 * save that worked — these two predicates are what make it a rendering
 * decision instead of silence.
 */

describe('isWriteConflict', () => {
  it('is true for a 409, whatever code came with it', () => {
    expect(isWriteConflict(new ApiError('stale', 409, 'stale_write'))).toBe(true)
    expect(isWriteConflict(new ApiError('stale', 409, null))).toBe(true)
  })

  it('is false for every other failure, including a lost backend', () => {
    expect(isWriteConflict(new ApiError('bad path', 400, 'invalid_path'))).toBe(false)
    expect(isWriteConflict(new ApiError('down', 0, 'network'))).toBe(false)
    expect(isWriteConflict(new Error('boom'))).toBe(false)
    expect(isWriteConflict(null)).toBe(false)
  })
})

describe('conflictMtime', () => {
  it('reads the current mtime out of the coded envelope', () => {
    const error = new ApiError('stale', 409, 'stale_write', {
      error: { code: 'stale_write', message: 'stale', current_mtime: 1712345678.5 },
    })
    expect(conflictMtime(error)).toBe(1712345678.5)
  })

  it('reads it off a flat body too', () => {
    expect(conflictMtime(new ApiError('stale', 409, null, { mtime: 42 }))).toBe(42)
  })

  it('is null when the server sent no hint — the conflict still stands', () => {
    // The recovery ("reload theirs" / "re-read then overwrite") does not need
    // this field, so its absence must never turn a handled conflict into an
    // unhandled one.
    expect(conflictMtime(new ApiError('stale', 409, 'stale_write'))).toBeNull()
    expect(conflictMtime(new ApiError('stale', 409, null, 'not json'))).toBeNull()
  })
})
