import { describe, expect, it } from 'vitest'
import { detectPlatform } from './platform'

describe('detectPlatform', () => {
  it('reads macOS from the platform string', () => {
    expect(detectPlatform('MacIntel', 'Mozilla/5.0 (Macintosh)')).toEqual({
      isMac: true,
      modKeyLabel: '⌘',
    })
  })

  it('reads iPadOS, which reports a desktop Macintosh user agent', () => {
    expect(detectPlatform('iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0)').isMac).toBe(true)
  })

  it('defaults to Ctrl everywhere else, including when nothing is known', () => {
    expect(detectPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux)')).toEqual({
      isMac: false,
      modKeyLabel: 'Ctrl',
    })
    expect(detectPlatform('', '').isMac).toBe(false)
  })
})
