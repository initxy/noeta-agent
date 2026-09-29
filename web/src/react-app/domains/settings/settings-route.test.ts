import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS_TAB, parseSettingsTab } from './settings-route'

describe('parseSettingsTab', () => {
  it('accepts a known tab without asking for a rewrite', () => {
    expect(parseSettingsTab('connections')).toEqual({ tab: 'connections', redirect: false })
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(parseSettingsTab(' Memory ')).toEqual({ tab: 'memory', redirect: false })
  })

  it('rewrites anything unrecognised to the default tab', () => {
    // `:tab` is user-editable text, so the parse has to be total: a bad tab
    // must not linger in history as a URL that renders nothing.
    expect(parseSettingsTab('nope')).toEqual({ tab: DEFAULT_SETTINGS_TAB, redirect: true })
    expect(parseSettingsTab(undefined)).toEqual({ tab: DEFAULT_SETTINGS_TAB, redirect: true })
    expect(parseSettingsTab('')).toEqual({ tab: DEFAULT_SETTINGS_TAB, redirect: true })
  })
})
