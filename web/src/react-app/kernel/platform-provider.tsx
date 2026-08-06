import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_PLATFORM, PlatformContext, detectPlatform } from './platform'

/** Sniff the platform once, at the top of the tree. */
export function PlatformProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => {
    if (typeof navigator === 'undefined') return DEFAULT_PLATFORM
    return detectPlatform(navigator.platform ?? '', navigator.userAgent ?? '')
  }, [])
  return <PlatformContext value={value}>{children}</PlatformContext>
}
