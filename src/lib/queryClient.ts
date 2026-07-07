import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query'
import { errorCode, errorStatus } from './api/errors'

/**
 * Dispatched once (debounced) when a query/mutation fails with an *expired
 * session* (HTTP 401, or an explicit `unauthenticated` code), so a stale cookie
 * clears local auth and drops back to login instead of leaving a silently
 * broken UI (stale data + invisible failures). The auth provider listens for
 * it. We wire via a window event rather than a direct import because
 * AuthProvider renders *under* QueryClientProvider — a direct import here would
 * create a cycle.
 */
export const SESSION_EXPIRED_EVENT = 'exchange:session-expired'

function isSessionExpired(error: unknown): boolean {
  // ONLY an actually-unauthenticated response forces a logout. A 403 means the
  // cookie is still valid but the action/section is forbidden — parental
  // `section_blocked` (a downloads/live section the admin restricted),
  // `rating_blocked`, or `admin_only` mutations. Treating those as expiry dumps
  // a signed-in user to the login walkthrough mid-session (and loops forever,
  // since re-login can't grant the blocked section). Duck-type on `status`/
  // `code` rather than `instanceof ApiError` so private status-carrying error
  // classes (e.g. SuggestionsError) still participate.
  if (errorStatus(error) === 401) return true
  return errorCode(error) === 'unauthenticated'
}

function isAuthError(error: unknown): boolean {
  // Retry policy only: a doomed 401 (expired) or 403 (forbidden) will fail
  // again identically, so don't burn the single retry on either.
  const status = errorStatus(error)
  return status === 401 || status === 403
}

let lastDispatch = 0
const DISPATCH_DEBOUNCE_MS = 2_000

function handleAuthError(error: unknown): void {
  if (!isSessionExpired(error)) return
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
