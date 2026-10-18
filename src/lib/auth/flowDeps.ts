import type { ActiveSignIn, SignInState } from './types'

/**
 * Everything a provider sign-in flow (Apple) needs from AuthProvider.
 *
 * The flows were lifted out of the provider closure verbatim; passing the
 * closure's refs and setters through one object keeps them pure module
 * functions with no behaviour change. Every member is render-stable (a ref,
 * a `useState` setter, or a `useCallback`), so the provider's `useCallback`
 * dependency lists are unchanged from when the bodies lived inline.
 *
 * Refs are typed structurally (`{ current: T }`) rather than as
 * `RefObject<T>` so tests can drive a flow with plain objects.
 */
export type SignInFlowDeps = {
  /** True (and the error state already set) when the invite code is malformed. */
  rejectMalformedInvite: (inviteCode?: string) => boolean
  /** Reserve the single shared sign-in slot; null when one is already held. */
  beginSignIn: (provider: Exclude<ActiveSignIn, null>) => number | null
  /** Release the slot (optionally only when it still belongs to this attempt). */
  clearSignIn: (provider?: Exclude<ActiveSignIn, null>, attemptId?: number) => void
  isSignInAttemptCurrent: (
    provider: Exclude<ActiveSignIn, null>,
    attemptId: number,
  ) => boolean
  confirmProviderSession: (
    expectedSub: string,
    provider: Exclude<ActiveSignIn, null>,
    attemptId: number,
  ) => Promise<boolean>
  setSignInState: (state: SignInState) => void
  setSignInError: (error: string | null) => void
  setSignOutError: (error: string | null) => void
  signInInFlightRef: { current: boolean }
  activeSignInRef: { current: ActiveSignIn }
  activeSignInAttemptRef: { current: number | null }
  activeSignInAbortRef: { current: AbortController | null }
}
