/**
 * Platform facts the UI has to branch on.
 *
 * Exactly one thing today — which key is the command modifier — because that
 * is what the shortcut table and the palette hint render. Detection is a pure
 * function over the two strings so it stays testable without a browser, and
 * the context exists so nothing below re-sniffs `navigator` at render time.
 */

import { createContext, useContext } from 'react'

export interface Platform {
  isMac: boolean
  /** How the command modifier is written in menus and hints. */
  modKeyLabel: string
}

export const DEFAULT_PLATFORM: Platform = { isMac: false, modKeyLabel: 'Ctrl' }

const MAC_PLATFORM: Platform = { isMac: true, modKeyLabel: '⌘' }

export function detectPlatform(platform: string, userAgent: string): Platform {
  const haystack = `${platform} ${userAgent}`.toLowerCase()
  // iPadOS reports a Macintosh user agent, and both want the ⌘ label — so the
  // coarse match is the correct answer here rather than a sloppy one.
  const isMac =
    haystack.includes('mac') || haystack.includes('iphone') || haystack.includes('ipad')
  return isMac ? MAC_PLATFORM : DEFAULT_PLATFORM
}

export const PlatformContext = createContext<Platform>(DEFAULT_PLATFORM)

export function usePlatform(): Platform {
  return useContext(PlatformContext)
}
