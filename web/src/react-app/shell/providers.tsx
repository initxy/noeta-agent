/**
 * The provider stack, composed once.
 *
 * Order is the contract: the query client is outermost because everything
 * below may read server state, platform facts sit above the router because
 * they do not change with the URL, and the router wraps only what needs to
 * re-render on navigation.
 *
 * The `<Toaster />` is mounted here exactly once and driven imperatively via
 * `toast()`. No feature mounts its own toast host — a second one means two
 * stacking contexts and duplicated toasts.
 */

import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { PlatformProvider } from '@/react-app/kernel/platform-provider'
import { initTheme, useTheme } from '@/react-app/kernel/theme'
import { queryClient } from '@/react-app/infra/query-client'

// Reconcile the shipped `class="dark"` default with the user's persisted choice
// at module load — before the first render — so a returning light-theme user
// never sees the dark default flash. The shell is the layer allowed to reach
// the kernel; `main.tsx` mounts only the shell (see the layering rules).
initTheme()

/** The toast host, following the workbench theme so it matches in light mode. */
function ThemedToaster() {
  const theme = useTheme()
  return <Toaster theme={theme} position="bottom-right" closeButton />
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <PlatformProvider>
        <BrowserRouter>{children}</BrowserRouter>
        <ThemedToaster />
      </PlatformProvider>
    </QueryClientProvider>
  )
}
