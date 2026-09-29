/**
 * The TanStack Query singleton and its defaults.
 *
 * `infra/` owns exactly this kind of thing: React-only runtime plumbing that
 * sits below every domain and depends on none of them.
 */

import { QueryClient } from '@tanstack/react-query'
import { isApiError } from '@/app/api'

/**
 * Retry only what retrying can fix.
 *
 * A 4xx is a statement about the request; repeating it changes nothing and
 * costs the user a slower error. Transport failures and 5xx are worth one
 * retry, which is what covers a backend that is still coming up.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false
  if (!isApiError(error)) return true
  return error.isNetworkError || error.status >= 500
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        refetchOnWindowFocus: false,
        // Deliberately finite. `staleTime: Infinity` is what lets an editor
        // show bytes that another session already overwrote on the shared
        // project directory, and then fail to save without saying why.
        staleTime: 30_000,
      },
      mutations: { retry: false },
    },
  })
}

export const queryClient = createQueryClient()
