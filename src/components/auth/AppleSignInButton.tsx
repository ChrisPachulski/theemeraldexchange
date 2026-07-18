import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { isAppleSignInConfigured, runAppleSignIn } from './appleSdk'
import './AppleSignInButton.css'

// "Sign in with Apple" affordance for the web SPA, sitting alongside the
// Plex button. It drives Apple's JS SDK to obtain an identity token,
// then hands it to appleSignIn() which POSTs it to /api/auth/apple for
// server-side JWKS verification. The optional invite code (lifted from
// the SignInBlock) is forwarded for first-time redemption.
//
// The button hides itself entirely when Apple sign-in isn't configured
// for this build (VITE_APPLE_CLIENT_ID unset) so a Plex-only deploy shows
// no dead control.

function appleRejectionText(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (typeof value !== 'object' || value === null || depth >= 4) return ''
  if (seen.has(value)) return ''
  seen.add(value)
  try {
    return Object.values(value as Record<string, unknown>)
      .map((nested) => appleRejectionText(nested, seen, depth + 1))
      .filter(Boolean)
      .join(' ')
  } catch {
    return ''
  }
}

function isAppleCancellation(value: unknown): boolean {
  const text = appleRejectionText(value).toLowerCase()
  return (
    text.includes('popup_closed') ||
    text.includes('user_cancelled') ||
    text.includes('user_trigger_new_signin_flow')
  )
}

export function AppleSignInButton({ inviteCode }: { inviteCode?: string }) {
  const {
    appleSignIn,
    activeSignIn,
    beginAppleSignIn,
    cancelAppleSignIn,
  } = useAuth()
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const preTokenAttemptRef = useRef<number | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const attemptId = preTokenAttemptRef.current
      preTokenAttemptRef.current = null
      if (attemptId !== null) cancelAppleSignIn(attemptId)
    }
  }, [cancelAppleSignIn])

  if (!isAppleSignInConfigured()) return null

  const pending = busy || activeSignIn !== null
  const applePending = busy || activeSignIn === 'apple'

  const onClick = async () => {
    if (pending) return
    const attemptId = beginAppleSignIn()
    if (attemptId === null) return
    preTokenAttemptRef.current = attemptId
    setLocalError(null)
    setBusy(true)
    let handedOff = false
    try {
      const { identityToken, nonce } = await runAppleSignIn()
      if (
        !mountedRef.current ||
        preTokenAttemptRef.current !== attemptId
      ) {
        return
      }
      preTokenAttemptRef.current = null
      handedOff = true
      await appleSignIn({
        identityToken,
        nonce,
        inviteCode: inviteCode?.trim() || undefined,
        attemptId,
      })
      // Success/denied/error messaging now lives in the shared auth
      // context (signInError); nothing more to do here.
    } catch (e) {
      if (
        !mountedRef.current ||
        (!handedOff && preTokenAttemptRef.current !== attemptId)
      ) {
        return
      }
      // The Apple SDK rejects with { error: 'popup_closed_by_user' } for
      // a user cancel; treat any cancel-ish failure quietly.
      if (isAppleCancellation(e)) {
        setLocalError(null)
      } else if (appleRejectionText(e).includes('apple_not_configured')) {
        setLocalError('Apple sign-in is not configured for this server.')
      } else {
        setLocalError('Could not start Apple sign-in. Try again.')
      }
    } finally {
      if (preTokenAttemptRef.current === attemptId) {
        preTokenAttemptRef.current = null
        cancelAppleSignIn(attemptId)
      }
      if (mountedRef.current) setBusy(false)
    }
  }

  return (
    <div className="apple-signin">
      <button
        type="button"
        className="apple-signin__button"
        onClick={() => void onClick()}
        disabled={pending}
        aria-label="Sign in with Apple"
      >
        <svg
          className="apple-signin__logo"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M11.182 8.51c.016 1.86 1.63 2.477 1.648 2.485-.014.044-.258.886-.85 1.755-.512.752-1.043 1.5-1.88 1.516-.823.015-1.088-.488-2.03-.488-.94 0-1.235.473-2.014.503-.808.03-1.423-.813-1.94-1.562-1.056-1.535-1.863-4.337-.78-6.23.538-.94 1.5-1.535 2.543-1.55.794-.016 1.543.534 2.028.534.485 0 1.396-.66 2.353-.563.4.017 1.526.162 2.249 1.22-.058.036-1.343.784-1.327 2.34M9.64 3.42c.43-.52.72-1.244.64-1.964-.62.025-1.37.413-1.814.933-.398.46-.747 1.197-.653 1.903.69.053 1.397-.35 1.827-.872"
          />
        </svg>
        <span>{applePending ? 'Signing in…' : 'Sign in with Apple'}</span>
      </button>
      {localError && (
        <p className="apple-signin__error" role="alert">
          {localError}
        </p>
      )}
    </div>
  )
}
