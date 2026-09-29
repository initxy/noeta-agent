import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLastProjectId, readStored, writeLastProjectId, writeStored } from './route-memory'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('route memory', () => {
  it('round-trips the last project id', () => {
    writeLastProjectId('alpha')
    expect(readLastProjectId()).toBe('alpha')
  })

  it('starts empty and treats blank as absent', () => {
    expect(readLastProjectId()).toBeNull()
    writeLastProjectId('   ')
    expect(readLastProjectId()).toBeNull()
  })

  it('clears on null rather than storing the string "null"', () => {
    writeLastProjectId('alpha')
    writeLastProjectId(null)
    expect(localStorage.getItem('noeta.route.lastProject')).toBeNull()
    expect(readLastProjectId()).toBeNull()
  })

  it('survives a storage that throws on write', () => {
    // Safari private mode. The shell has to render without its memory, so a
    // failed write must not propagate.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeStored('k', 'v')).not.toThrow()
  })

  it('survives a storage that throws on read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readStored('k')).toBeNull()
  })
})
