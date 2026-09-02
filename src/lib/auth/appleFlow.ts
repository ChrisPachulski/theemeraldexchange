import { apiUrl } from '../api/base'
import { deniedMessage } from './messages'
import {
  AuthRequestCancelledError,
  AuthRequestTimeoutError,
  boundedAuthRequest,
  AUTH_NETWORK_TIMEOUT_MS,
} from './request'
import { providerSubFromApi } from './session'
import type { SignInFlowDeps } from './flowDeps'
import type { AuthUser } from './types'

/** The web Sign in with Apple flow, lifted verbatim out of AuthProvider. The
 *  caller already holds an Apple identity token (the Apple JS SDK owns its own
 *  window), so this is a single POST plus the session confirmation. */
export async function runAppleSignIn(
  d: SignInFlowDeps,
  args: {
    identityToken: string
    nonce?: string
    inviteCode?: string
    /** Attempt returned by beginAppleSignIn for the pre-token SDK phase. */
    attemptId?: number
  },
): Promise<boolean> {
  const continuingApple =
    args.attemptId !== undefined &&
    d.signInInFlightRef.current &&
    d.activeSignInRef.current === 'apple' &&
    d.activeSignInAttemptRef.current === args.attemptId
  if (args.attemptId !== undefined && !continuingApple) return false
  if (d.rejectMalformedInvite(args.inviteCode)) {
    if (continuingApple) d.clearSignIn('apple', args.attemptId)
    return false
  }
  const appleAttemptId = continuingApple
    ? args.attemptId!
    : d.beginSignIn('apple')
  if (appleAttemptId === null) return false
  const attemptSignal = d.activeSignInAbortRef.current?.signal
  if (!attemptSignal || !d.isSignInAttemptCurrent('apple', appleAttemptId)) {
    d.clearSignIn('apple', appleAttemptId)
    return false
  }
  d.setSignInError(null)
  d.setSignOutError(null)
  // No popup for the web SIWA path — the Apple JS SDK owns its own
  // window; by the time we're called the identity token is in hand,
  // so this is a single POST. Reflect "pending" so the button can
  // show a spinner while the server verifies against Apple's JWKS.
  d.setSignInState('pending')
  try {
    const body: Record<string, string> = {
      identityToken: args.identityToken,
    }
    if (args.nonce) body.nonce = args.nonce
    if (args.inviteCode) body.inviteCode = args.inviteCode
    const { response: r, data } = await boundedAuthRequest(
      attemptSignal,
      AUTH_NETWORK_TIMEOUT_MS,
      async (signal) => {
        const response = await fetch(apiUrl('/api/auth/apple'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        })
        const data = (await response.json().catch(() => ({}))) as {
          status?: string
          user?: AuthUser
          reason?: unknown
          error?: unknown
        }
        return { response, data }
      },
    )
    if (!d.isSignInAttemptCurrent('apple', appleAttemptId)) return false
    if (r.status === 403) {
      d.setSignInState('denied')
      d.setSignInError(deniedMessage(data?.reason))
      return false
    }
    if (!r.ok) {
      d.setSignInState('error')
      d.setSignInError(
        r.status === 401
          ? 'Apple sign-in could not be verified. Try again.'
          : typeof data?.error === 'string'
            ? `Apple sign-in failed: ${data.error}`
            : 'Apple sign-in failed. Try again.',
      )
      return false
    }
    if (data.status === 'authorized' && data.user) {
      const providerSub = providerSubFromApi(data.user)
      if (!providerSub) {
        d.setSignInState('error')
        d.setSignInError('Apple sign-in returned an unexpected response.')
        return false
      }
      if (
        !(await d.confirmProviderSession(providerSub, 'apple', appleAttemptId))
      ) {
        return false
      }
      d.setDiscoveredServers(null)
      d.setSignInState('idle')
      return true
    }
    d.setSignInState('error')
    d.setSignInError('Apple sign-in returned an unexpected response.')
    return false
  } catch (e) {
    if (
      e instanceof AuthRequestCancelledError ||
      !d.isSignInAttemptCurrent('apple', appleAttemptId)
    ) {
      return false
    }
    d.setSignInState('error')
    d.setSignInError(
      e instanceof AuthRequestTimeoutError
        ? 'Apple sign-in timed out. Check your connection and try again.'
        : 'Apple sign-in is temporarily unavailable. Check your connection and try again.',
    )
    return false
  } finally {
    d.clearSignIn('apple', appleAttemptId)
  }
}
