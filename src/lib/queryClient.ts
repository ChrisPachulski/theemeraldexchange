import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query'
import { ApiError } from './api/errors'

/**
 * Dispatched once (debounced) when a query/mutation fails with HTTP 401/403, so
 * an expired cookie session clears local auth and drops back to login instead
 * of leaving a silently broken UI (stale data + invisible failures). The auth
 * provider listens for it. We wire via a window event rather than a direct
 * import because AuthProvider renders *under* QueryClientProvider — a direct
 * import here would create a cycle.
 */
export const SESSION_EXPIRED_EVENT = 'exchange:session-expired'

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

let lastDispatch = 0
const DISPATCH_DEBOUNCE_MS = 2_000

function handleAuthError(error: unknown): void {
  if (!isAuthError(error)) return
  if (typeof window === 'undefined') return
  // Debounce: a burst of failing queries should trigger a single logout.
  const now = Date.now()
  if (now - lastDispatch < DISPATCH_DEBOUNCE_MS) return
  lastDispatch = now
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't re-fire a request that already failed auth — retrying a doomed
      // 401/403 just masks the expiry. Otherwise keep the single retry.
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false
        return failureCount < 1
      },
      refetchOnWindowFocus: false,
    },
  },
})
