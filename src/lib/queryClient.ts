import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query'
import { errorStatus } from './api/errors'
import { notifySessionExpired } from './sessionExpiry'

export {
  SESSION_EXPIRED_EVENT,
  notifySessionExpired,
  notifySessionExpiredResponse,
} from './sessionExpiry'

/**
 * Dispatched once (debounced) when a query/mutation fails with an *expired
 * session* (HTTP 401 plus an explicit `unauthenticated` code), so a stale cookie
 * clears local auth and drops back to login instead of leaving a silently
 * broken UI (stale data + invisible failures). The auth provider listens for
 * it. We wire via a window event rather than a direct import because
 * AuthProvider renders *under* QueryClientProvider — a direct import here would
 * create a cycle.
 */
function isAuthError(error: unknown): boolean {
  // Retry policy only: a doomed 401 (expired) or 403 (forbidden) will fail
  // again identically, so don't burn the single retry on either.
  const status = errorStatus(error)
  return status === 401 || status === 403
}

function handleAuthError(error: unknown): void {
  notifySessionExpired(error)
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Don't re-fire a request that already failed auth or authorization —
      // retrying a doomed 401/403 only adds noise. Otherwise keep one retry.
      retry: (failureCount, error) => {
        if (isAuthError(error)) return false
        return failureCount < 1
      },
      refetchOnWindowFocus: false,
    },
  },
})
