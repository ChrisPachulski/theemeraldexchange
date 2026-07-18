/* eslint-disable react-refresh/only-export-components -- this auth module
   deliberately co-locates the AuthProvider component with its useAuth hook,
   context, and the invite/member data helpers it owns. react-refresh's
   fast-refresh constraint is a dev-only DX nicety with zero runtime impact;
   splitting would fragment the auth API surface for no correctness gain. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiUrl } from './api/base'
import { throwApiError } from './api/errors'
import { SESSION_EXPIRED_EVENT } from './queryClient'
import { requestSetupChecklist } from './setupChecklistFlag'
import type {
  PublicKeyCredentialRequestOptionsJSON,
  PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser'

// Persists the admin "view-as" preview across reloads so an admin who
// chose to preview the dashboard as a regular user doesn't get bumped
// back to admin chrome on every refresh. Server-side role is still
// driven by the session cookie — this is UI-only.
const VIEW_AS_KEY = 'eex.viewAs'

function readStoredViewAs(): Role | null {
  try {
    const raw = localStorage.getItem(VIEW_AS_KEY)
    return raw === 'admin' || raw === 'user' ? raw : null
  } catch {
    return null
  }
}

function writeStoredViewAs(value: Role | null) {
  try {
    if (value === null) localStorage.removeItem(VIEW_AS_KEY)
    else localStorage.setItem(VIEW_AS_KEY, value)
  } catch {
    // localStorage unavailable — preference just stays in memory for
    // this tab.
  }
}

// Maps a server 403 `reason` from either login path to human copy.
// The new parallel model rejects a valid identity that presents no
// redeemed invite with `no_invite`; the legacy Plex path used
// `not_a_server_member`. Both mean "your identity is fine, but you're
// not on the allowlist."
export function deniedMessage(reason: unknown): string {
  switch (reason) {
    case 'no_invite':
    case 'not_authorized':
      return 'Invitation-only. Ask the owner for an invite code, then sign in again.'
    case 'access_revoked':
      return 'Your access to this library has been revoked. Ask the owner to restore it.'
    case 'not_a_server_member':
      return "You aren't a member of this Plex server."
    // First-owner claim (plan 006 Phase 1)
    case 'invalid_setup_token':
      return 'That setup token is wrong or expired. Copy it from the server log (or the .setup-token file) and try again.'
    case 'claim_source_blocked':
      return 'Claiming is only allowed from the local network. Connect to the same LAN as the server (or set SETUP_ALLOW_REMOTE=1).'
    case 'already_claimed':
      return 'Someone already claimed this server.'
    case 'server_unclaimed':
      return 'This server has not been claimed yet. Its owner must claim it with the setup token first.'
    default:
      return 'Access denied.'
  }
}

const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/
const INVALID_INVITE_CODE_MESSAGE =
  'Invite codes are 22 characters. Paste the complete code.'

/** Empty is valid for returning members; a supplied invite must be complete. */
export function inviteCodeError(code?: string): string | null {
  const value = code?.trim()
  return !value || INVITE_CODE_PATTERN.test(value) ? null : INVALID_INVITE_CODE_MESSAGE
}

// Auth state shared by the whole app. The session is server-side
// (HttpOnly cookie); we only mirror identity + role here so the UI can
// gate buttons and show the username. /api/me returns 401 when no
// session — that's our "show login screen" signal.

export type Role = 'admin' | 'user'
/** Which federated identity provider minted the session. Mirrors the
 *  server's AuthMode (session.ts). `local` is legacy/dev-only. */
export type AuthMode = 'plex' | 'apple' | 'local'
export type AuthUser = {
  /** Namespaced subject: `plex:<id>` | `apple:<subject>`. Used by the
   *  SPA to scope per-user localStorage (BYO API key, etc.) so a shared
   *  device that's been signed in as different family members reads the
   *  right state. The prefix also tells us which provider authed. */
  sub: string
  username: string
  role: Role
  /** Provider that authenticated this session, so chrome can render
   *  "Signed in with Apple" vs "Signed in with Plex". May be absent on
   *  pre-existing sessions; derive from the `sub` prefix when missing. */
  auth_mode?: AuthMode
}

/** Best-effort provider inference when the server omits `auth_mode`
 *  (older session cookies). The sub prefix is authoritative. */
export function authModeFromUser(user: Pick<AuthUser, 'sub' | 'auth_mode'>): AuthMode {
  if (user.auth_mode) return user.auth_mode
  if (user.sub.startsWith('apple:')) return 'apple'
  if (user.sub.startsWith('local:')) return 'local'
  return 'plex'
}

type SignInState = 'idle' | 'opening' | 'pending' | 'denied' | 'error'

// Plex may close its auth popup before the newly-authorized PIN is visible to
// the backend. Keep checking briefly so a successful sign-in cannot lose a
// race against the popup's close event, while still recovering quickly when a
// user intentionally cancels the window.
const PLEX_POPUP_CLOSE_GRACE_MS = 10_000
const PLEX_POLL_BASE_DELAY_MS = 2_500
const PLEX_POLL_MAX_DELAY_MS = 30_000
const PLEX_POLL_MAX_FAILURES = 4
const PLEX_POLL_DEADLINE_MS = 5 * 60 * 1000

function plexRetryDelay(retryAfter: string | null, now: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  const requestedDelay = Number.isFinite(seconds)
    ? seconds * 1000
    : retryAfter
      ? Date.parse(retryAfter) - now
      : Number.NaN
  if (!Number.isFinite(requestedDelay)) return PLEX_POLL_BASE_DELAY_MS
  return Math.min(
    PLEX_POLL_MAX_DELAY_MS,
    Math.max(PLEX_POLL_BASE_DELAY_MS, requestedDelay),
  )
}

type AuthCtx = {
  loading: boolean
  user: AuthUser | null
  /** Server-truth role from the session cookie. */
  role: Role | null
  /**
   * What the UI is currently gating against. Equals `role` unless the
   * user is an admin who's toggled the "view as user" switch in the
   * UserMenu. Server-side permissions are unchanged — this is a UI-only
   * preview so admins can sanity-check what guests see.
   */
  effectiveRole: Role | null
  /** True when effectiveRole is 'admin'. Convenience for gates. */
  isAdmin: boolean
  /** Toggle preview mode. Pass null to clear (back to actual role). */
  setViewAs: (role: Role | null) => void
  signInState: SignInState
  signInError: string | null
  signOutError: string | null
  /** Discovered Plex servers, only present when PLEX_SERVER_ID isn't set yet. */
  discoveredServers: { name: string; id: string; owned: boolean }[] | null
  /**
   * Open the Plex PIN popup and poll to completion. An optional invite
   * code is forwarded to the server for first-time redemption — a known
   * member doesn't need one, a new member must present a valid invite.
   */
  signIn: (inviteCode?: string) => Promise<void>
  /**
   * Complete the web Sign in with Apple flow. The caller has already
   * obtained an Apple identity token (JWT) from AppleID.auth.signIn();
   * we POST it to /api/auth/apple, where the server verifies it against
   * Apple's JWKS. `inviteCode` is forwarded for first-time redemption.
   * Returns true on success (session minted), false otherwise — the
   * error detail lives in `signInError` and the phase in `signInState`.
   */
  appleSignIn: (
    args: { identityToken: string; nonce?: string; inviteCode?: string },
  ) => Promise<boolean>
  /**
   * Sign in with an EXISTING passkey (WebAuthn). Usernameless — the
   * authenticator offers its discoverable resident keys, so no handle or
   * code is needed. This is the cross-platform, Plex-independent login.
   * Returns true on success (session minted), false otherwise (detail in
   * signInError / signInState).
   */
  passkeyLogin: () => Promise<boolean>
  /**
   * Register a NEW passkey for a first-time member. Mints a self-owned
   * `local:<ulid>` identity, so it needs a display handle and a valid
   * invite code (the invite is what authorizes the new identity onto the
   * members allowlist — same gate as Plex/Apple). Returns true on success.
   */
  passkeyRegister: (args: {
    handle: string
    inviteCode?: string
    /** First-owner claim (plan 006 Phase 1): the boot-minted setup token. */
    setupToken?: string
  }) => Promise<boolean>
  signOut: () => Promise<void>
  /**
   * Which login providers this install actually offers (/api/auth/methods).
   * null until fetched — render all buttons while unknown so a slow API
   * never hides the way in.
   */
  authMethods: { plex: boolean; apple: boolean; google: boolean; passkey: boolean } | null
  /** True while the server is unclaimed (plan 006 Phase 1 claim flow). */
  setupClaimable: boolean
}

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  // Per-user data (feedback dots, usage totals, BYO-key-scoped
  // suggestions) lives in the React Query cache. Without a reset on
  // identity change, a shared device leaks state across users — sign
  // out as Alice on the AppleTV, sign in as Bob, and Bob sees Alice's
  // dots until each query refetches.
  //
  // The fingerprint segment on suggestions/feedback keys helps but
  // isn't exhaustive: feedback's key is just ['feedback'], usage's
  // ['usage', ...] isn't sub-scoped, and a per-key audit grows brittle
  // as new hooks land. Cache-clear on identity transition is the
  // belt-and-suspenders fix — synchronous so the first re-render
  // under the new identity already sees an empty cache.
  const applyUser = useCallback(
    (next: AuthUser | null) => {
      qc.clear()
      setUser(next)
    },
    [qc],
  )
  const [viewAs, setViewAsState] = useState<Role | null>(() => readStoredViewAs())
  const setViewAs = useCallback((next: Role | null) => {
    setViewAsState(next)
    writeStoredViewAs(next)
  }, [])
  const [signInState, setSignInState] = useState<SignInState>('idle')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [discoveredServers, setDiscoveredServers] =
    useState<AuthCtx['discoveredServers']>(null)
  const pollRef = useRef<number | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const pollGenerationRef = useRef(0)
  const popupRef = useRef<Window | null>(null)
  const signInInFlightRef = useRef(false)
  const rejectMalformedInvite = useCallback((inviteCode?: string) => {
    const message = inviteCodeError(inviteCode)
    if (!message) return false
    setSignInState('error')
    setSignInError(message)
    setSignOutError(null)
    return true
  }, [])

  // Initial session probe.
  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/me'), { credentials: 'include' })
      .then(async (r) => {
        if (!alive) return
        if (r.status === 401) {
          applyUser(null)
        } else if (r.ok) {
          const { user } = (await r.json()) as { user: AuthUser }
          applyUser(user)
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [applyUser])

  // Provider discovery + first-owner claim state (plan 006 Phase 1).
  // Best-effort: on failure authMethods stays null (all buttons render)
  // and setupClaimable stays false (normal sign-in).
  const [authMethods, setAuthMethods] = useState<AuthCtx['authMethods']>(null)
  const [setupClaimable, setSetupClaimable] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/auth/methods'))
      .then(async (r) => {
        if (alive && r.ok) setAuthMethods((await r.json()) as AuthCtx['authMethods'])
      })
      .catch(() => {})
    fetch(apiUrl('/api/setup/status'))
      .then(async (r) => {
        if (alive && r.ok) {
          const { claimable } = (await r.json()) as { claimable?: boolean }
          setSetupClaimable(Boolean(claimable))
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Centralised 401/403 handling. queryClient dispatches SESSION_EXPIRED_EVENT
  // (debounced) when any query/mutation fails auth, so an expired cookie clears
  // local auth state — applyUser(null) also wipes the query cache — and the
  // AuthGate drops back to the login screen instead of a silently broken UI.
  useEffect(() => {
    const onExpired = () => {
      setUser((prev) => {
        if (!prev) return prev
        qc.clear()
        return null
      })
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [qc])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    pollRef.current = null
    pollGenerationRef.current += 1
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    signInInFlightRef.current = false
    popupRef.current?.close()
    popupRef.current = null
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const signIn = useCallback(async (inviteCode?: string) => {
    if (rejectMalformedInvite(inviteCode)) return
    if (signInInFlightRef.current) return
    stopPolling()
    signInInFlightRef.current = true
    setSignInError(null)
    setSignOutError(null)
    setSignInState('opening')
    const popup = window.open(
      '',
      'plex-auth',
      'width=520,height=720,menubar=no,toolbar=no',
    )
    if (!popup) {
      stopPolling()
      setSignInState('error')
      setSignInError('Popup blocked. Allow popups for this site and try again.')
      return
    }
    popupRef.current = popup
    const setupGeneration = pollGenerationRef.current
    const setupIsCurrent = () => pollGenerationRef.current === setupGeneration
    const finish = (state: SignInState, error: string | null) => {
      stopPolling()
      setSignInState(state)
      setSignInError(error)
    }
    try {
      // Fetch the PUBLIC Plex client config (the clientId is the same
      // non-secret app id already embedded in every Plex auth URL).
      const cfgRes = await fetch(apiUrl('/api/auth/plex/config'), {
        credentials: 'include',
      })
      if (!setupIsCurrent()) return
      if (!cfgRes.ok) throw new Error(`plex config failed: ${cfgRes.status}`)
      const { clientId, product } = (await cfgRes.json()) as {
        clientId: string
        product: string
      }
      if (!setupIsCurrent()) return

      // Create the PIN DIRECTLY at plex.tv from the browser so plex.tv
      // attributes the sign-in to the VISITOR's own IP — not the server's
      // home IP, which previously leaked onto Plex's "Security Alert" page
      // for everyone authenticating. The backend keeps polling with this
      // SAME clientId, so checkPin still finds the authorized token.
      const pinRes = await fetch('https://plex.tv/api/v2/pins?strong=true', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Plex-Product': product,
          'X-Plex-Client-Identifier': clientId,
        },
      })
      if (!setupIsCurrent()) return
      if (!pinRes.ok) throw new Error(`plex pin create failed: ${pinRes.status}`)
      const pin = (await pinRes.json()) as { id: number; code: string }
      if (!setupIsCurrent()) return
      const pinId = pin.id

      // Mirror of the old server-side buildAuthUrl: the PIN `code` (not the
      // id) goes into the auth-page hash params with the same clientId.
      const authUrl =
        'https://app.plex.tv/auth#?' +
        new URLSearchParams({
          clientID: clientId,
          code: pin.code,
          'context[device][product]': product,
        }).toString()

      popup.location.href = authUrl
      setSignInState('pending')

      const deadline = Date.now() + PLEX_POLL_DEADLINE_MS
      let nextCheckAt = Date.now() + PLEX_POLL_BASE_DELAY_MS
      let popupClosedAt: number | null = null
      let consecutiveFailures = 0

      const terminalPollError = () => {
        const now = Date.now()
        if (popup.closed) popupClosedAt ??= now
        if (
          popupClosedAt !== null &&
          now - popupClosedAt >= PLEX_POPUP_CLOSE_GRACE_MS
        ) {
          return 'Plex sign-in window was closed before authorization finished.'
        }
        return now >= deadline ? 'Plex sign-in expired. Try again.' : null
      }

      const scheduleTick = () => {
        const generation = pollGenerationRef.current
        const now = Date.now()
        let delay = Math.min(
          PLEX_POLL_BASE_DELAY_MS,
          Math.max(0, nextCheckAt - now),
          Math.max(0, deadline - now),
        )
        if (popupClosedAt !== null) {
          delay = Math.min(
            delay,
            Math.max(0, PLEX_POPUP_CLOSE_GRACE_MS - (now - popupClosedAt)),
          )
        }
        pollRef.current = window.setTimeout(() => {
          if (pollGenerationRef.current !== generation) return
          pollRef.current = null
          void poll()
        }, delay)
      }

      const scheduleNextCheck = (delay: number) => {
        nextCheckAt = Date.now() + delay
        scheduleTick()
      }

      const poll = async () => {
        const now = Date.now()
        const terminalError = terminalPollError()
        if (terminalError) {
          finish('error', terminalError)
          return
        }
        if (now < nextCheckAt) {
          scheduleTick()
          return
        }

        const attemptGeneration = ++pollGenerationRef.current
        const controller = new AbortController()
        pollAbortRef.current = controller
        const attemptIsCurrent = () =>
          pollGenerationRef.current === attemptGeneration &&
          pollAbortRef.current === controller &&
          !controller.signal.aborted
        const releaseAttempt = () => {
          if (pollRef.current !== null) window.clearTimeout(pollRef.current)
          pollRef.current = null
          if (pollAbortRef.current === controller) pollAbortRef.current = null
        }
        const watchAttempt = () => {
          const watchNow = Date.now()
          let delay = Math.min(
            PLEX_POLL_BASE_DELAY_MS,
            Math.max(0, deadline - watchNow),
          )
          if (popupClosedAt !== null) {
            delay = Math.min(
              delay,
              Math.max(
                0,
                PLEX_POPUP_CLOSE_GRACE_MS - (watchNow - popupClosedAt),
              ),
            )
          }
          pollRef.current = window.setTimeout(() => {
            if (!attemptIsCurrent()) return
            pollRef.current = null
            const error = terminalPollError()
            if (error) {
              finish('error', error)
              return
            }
            watchAttempt()
          }, delay)
        }
        const retryTransientFailure = () => {
          consecutiveFailures += 1
          if (consecutiveFailures >= PLEX_POLL_MAX_FAILURES) {
            finish('error', 'Plex sign-in is temporarily unavailable. Try again.')
            return
          }
          releaseAttempt()
          scheduleNextCheck(
            Math.min(
              PLEX_POLL_MAX_DELAY_MS,
              PLEX_POLL_BASE_DELAY_MS * 2 ** (consecutiveFailures - 1),
            ),
          )
        }

        watchAttempt()
        try {
          // POST (not GET) so the CSRF middleware gates the cookie-
          // setting branch. Otherwise an attacker page could trigger a
          // cross-site GET with their own pinId and overwrite the
          // victim's session.
          const r = await fetch(apiUrl('/api/auth/plex/check'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              inviteCode ? { pinId, inviteCode } : { pinId },
            ),
            signal: controller.signal,
          })
          if (!attemptIsCurrent()) return
          if (r.status === 403) {
            const data = await r.json().catch(() => ({}))
            if (!attemptIsCurrent()) return
            finish('denied', deniedMessage(data?.reason))
            return
          }
          if (r.status === 429) {
            consecutiveFailures = 0
            releaseAttempt()
            scheduleNextCheck(plexRetryDelay(r.headers.get('Retry-After'), Date.now()))
            return
          }
          if (r.status >= 500) {
            retryTransientFailure()
            return
          }
          if (!r.ok) {
            if (r.status >= 400 && r.status < 500) {
              const data = await r.json().catch(() => ({}))
              if (!attemptIsCurrent()) return
              finish(
                'error',
                typeof data?.error === 'string'
                  ? `Plex sign-in failed: ${data.error}`
                  : 'Plex sign-in expired. Try again.',
              )
            } else {
              retryTransientFailure()
            }
            return
          }
          const data = await r.json()
          if (!attemptIsCurrent()) return
          if (data.status === 'authorized') {
            finish('idle', null)
            applyUser(data.user as AuthUser)
            setDiscoveredServers(data.discoveredServers ?? null)
            return
          }
          consecutiveFailures = 0
          releaseAttempt()
          scheduleNextCheck(PLEX_POLL_BASE_DELAY_MS)
        } catch {
          if (!attemptIsCurrent()) return
          retryTransientFailure()
        }
      }

      scheduleTick()
    } catch (e) {
      if (!setupIsCurrent()) return
      finish('error', e instanceof Error ? e.message : String(e))
    }
  }, [applyUser, rejectMalformedInvite, stopPolling])

  const appleSignIn = useCallback(
    async (args: {
      identityToken: string
      nonce?: string
      inviteCode?: string
    }): Promise<boolean> => {
      if (rejectMalformedInvite(args.inviteCode)) return false
      if (signInInFlightRef.current) return false
      signInInFlightRef.current = true
      setSignInError(null)
      setSignOutError(null)
      // No popup for the web SIWA path — the Apple JS SDK owns its own
      // window; by the time we're called the identity token is in hand,
      // so this is a single POST. Reflect "pending" so the button can
      // show a spinner while the server verifies against Apple's JWKS.
      setSignInState('pending')
      try {
        const body: Record<string, string> = {
          identityToken: args.identityToken,
        }
        if (args.nonce) body.nonce = args.nonce
        if (args.inviteCode) body.inviteCode = args.inviteCode
        const r = await fetch(apiUrl('/api/auth/apple'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (r.status === 403) {
          const data = await r.json().catch(() => ({}))
          setSignInState('denied')
          setSignInError(deniedMessage(data?.reason))
          return false
        }
        if (!r.ok) {
          const data = await r.json().catch(() => ({}))
          setSignInState('error')
          setSignInError(
            r.status === 401
              ? 'Apple sign-in could not be verified. Try again.'
              : typeof data?.error === 'string'
                ? `Apple sign-in failed: ${data.error}`
                : 'Apple sign-in failed. Try again.',
          )
          return false
        }
        const data = (await r.json()) as { status?: string; user?: AuthUser }
        if (data.status === 'authorized' && data.user) {
          applyUser(data.user)
          setDiscoveredServers(null)
          setSignInState('idle')
          return true
        }
        setSignInState('error')
        setSignInError('Apple sign-in returned an unexpected response.')
        return false
      } catch (e) {
        setSignInState('error')
        setSignInError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        signInInFlightRef.current = false
      }
    },
    [applyUser, rejectMalformedInvite],
  )

  const passkeyLogin = useCallback(async (): Promise<boolean> => {
    if (signInInFlightRef.current) return false
    signInInFlightRef.current = true
    setSignInError(null)
    setSignOutError(null)
    setSignInState('pending')
    try {
      const optRes = await fetch(apiUrl('/api/auth/passkey/login/options'), {
        method: 'POST',
        credentials: 'include',
      })
      if (!optRes.ok) throw new Error(`passkey options failed: ${optRes.status}`)
      const { options, challengeId } = (await optRes.json()) as {
        options: PublicKeyCredentialRequestOptionsJSON
        challengeId: string
      }
      const { startAuthentication } = await import('@simplewebauthn/browser')
      let assertion
      try {
        assertion = await startAuthentication({ optionsJSON: options })
      } catch {
        // User cancelled the OS prompt, no passkey for this site, or the
        // authenticator errored. Not a server failure — soft message.
        setSignInState('error')
        setSignInError('Passkey sign-in was cancelled or no passkey was found on this device.')
        return false
      }
      const verifyRes = await fetch(apiUrl('/api/auth/passkey/login/verify'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, response: assertion }),
      })
      if (verifyRes.status === 403) {
        const data = await verifyRes.json().catch(() => ({}))
        setSignInState('denied')
        setSignInError(deniedMessage(data?.error))
        return false
      }
      if (!verifyRes.ok) {
        setSignInState('error')
        setSignInError('Passkey sign-in failed. Try again.')
        return false
      }
      const data = (await verifyRes.json()) as { ok?: boolean; user?: AuthUser }
      if (data.ok && data.user) {
        applyUser(data.user)
        setDiscoveredServers(null)
        setSignInState('idle')
        return true
      }
      setSignInState('error')
      setSignInError('Passkey sign-in returned an unexpected response.')
      return false
    } catch (e) {
      setSignInState('error')
      setSignInError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      signInInFlightRef.current = false
    }
  }, [applyUser])

  const passkeyRegister = useCallback(
    async ({
      handle,
      inviteCode,
      setupToken,
    }: {
      handle: string
      inviteCode?: string
      setupToken?: string
    }): Promise<boolean> => {
      if (rejectMalformedInvite(inviteCode)) return false
      if (signInInFlightRef.current) return false
      signInInFlightRef.current = true
      setSignInError(null)
      setSignOutError(null)
      setSignInState('pending')
      try {
        const optRes = await fetch(apiUrl('/api/auth/passkey/register/options'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle }),
        })
        if (optRes.status === 400) {
          setSignInState('error')
          setSignInError('Enter a display name to create a passkey.')
          return false
        }
        if (!optRes.ok) throw new Error(`passkey register options failed: ${optRes.status}`)
        const { options, challengeId } = (await optRes.json()) as {
          options: PublicKeyCredentialCreationOptionsJSON
          challengeId: string
        }
        const { startRegistration } = await import('@simplewebauthn/browser')
        let attestation
        try {
          attestation = await startRegistration({ optionsJSON: options })
        } catch {
          setSignInState('error')
          setSignInError('Passkey setup was cancelled.')
          return false
        }
        const verifyRes = await fetch(apiUrl('/api/auth/passkey/register/verify'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challengeId,
            response: attestation,
            inviteCode,
            setupToken,
            deviceLabel: handle,
          }),
        })
        if (verifyRes.status === 403) {
          const data = await verifyRes.json().catch(() => ({}))
          setSignInState('denied')
          setSignInError(deniedMessage(data?.error))
          return false
        }
        if (!verifyRes.ok) {
          setSignInState('error')
          setSignInError('Could not create the passkey. Try again.')
          return false
        }
        const data = (await verifyRes.json()) as {
          ok?: boolean
          user?: AuthUser
          claimed?: boolean
        }
        if (data.ok && data.user) {
          applyUser(data.user)
          setDiscoveredServers(null)
          if (data.claimed) {
            setSetupClaimable(false)
            // Surface the first-run setup checklist to the fresh owner
            // (plan 006 Phase 3).
            requestSetupChecklist()
          }
          setSignInState('idle')
          return true
        }
        setSignInState('error')
        setSignInError('Passkey setup returned an unexpected response.')
        return false
      } catch (e) {
        setSignInState('error')
        setSignInError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        signInInFlightRef.current = false
      }
    },
    [applyUser, rejectMalformedInvite],
  )

  const signOut = useCallback(async () => {
    setSignOutError(null)
    let response: Response
    try {
      response = await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'include',
      })
    } catch (err) {
      setSignOutError('Sign-out failed. Check your connection and try again.')
      throw err
    }
    if (!response.ok) {
      const error = new Error(`logout failed: ${response.status}`)
      setSignOutError('Sign-out failed. Try again.')
      throw error
    }
    applyUser(null)
    setViewAs(null)
    setDiscoveredServers(null)
  }, [applyUser, setViewAs])

  const role = user?.role ?? null
  // Only admins can preview as user. Anyone else gets their actual role
  // even if they somehow set viewAs (e.g. devtools).
  const effectiveRole: Role | null =
    role === 'admin' && viewAs ? viewAs : role
  const isAdmin = effectiveRole === 'admin'

  return (
    <AuthContext.Provider
      value={{
        loading,
        user,
        role,
        effectiveRole,
        isAdmin,
        setViewAs,
        signInState,
        signInError,
        signOutError,
        discoveredServers,
        signIn,
        appleSignIn,
        passkeyLogin,
        passkeyRegister,
        signOut,
        authMethods,
        setupClaimable,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// Co-located with AuthProvider — standard context+hook idiom. The two are
// coupled by the private AuthContext and shouldn't be moved apart. (No
// react-refresh disable is needed: eslint does not flag this export under
// the current config; a disable here is reported as an unused directive.)
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

// ── Admin allowlist API — invites + members ────────────────────────
//
// These are owner-only (requireAdmin server-side) management calls. They
// are plain credentialed fetches, mirroring DevicesPanel's standalone
// fetch-function style rather than living on the auth context — they are
// only ever called from the admin InvitesPanel, not on the hot auth path.
// The server contract is the parallel-model authZ layer: members are the
// allowlist; invites are the owner-issued grant that creates a member on
// first Apple/Plex login.

export type InviteStatus = 'active' | 'expired' | 'exhausted' | 'revoked'

/** A redacted invite row as listed for the owner. The plaintext code is
 *  NEVER returned by the list endpoint — only the freshly-created one is,
 *  exactly once, by createInvite(). */
export type InviteView = {
  code_hash_prefix: string
  issued_by: string
  label: string | null
  expires_at: string | null
  max_uses: number
  used_count: number
  created_at: string
  revoked_at: string | null
  status: InviteStatus
}

/** The one-time create response — `code` is the plaintext shown ONCE. */
export type CreatedInvite = {
  code: string
  code_hash_prefix: string
  label: string | null
  expires_at: string | null
  max_uses: number
}

export type MemberView = {
  sub: string
  display_name: string | null
  role: Role
  auth_mode: AuthMode
  invited_by: string | null
  joined_at: string
  revoked_at: string | null
  is_admin: boolean
}

async function adminJson<T>(
  path: string,
  scope: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!r.ok) await throwApiError(r, scope)
  return (await r.json()) as T
}

export async function listInvites(): Promise<InviteView[]> {
  const body = await adminJson<{ invites: InviteView[] }>(
    '/api/admin/invites',
    'list invites',
  )
  return body.invites
}

export async function createInvite(args: {
  label?: string
  expiresInDays?: number
  maxUses?: number
}): Promise<CreatedInvite> {
  return adminJson<CreatedInvite>('/api/admin/invites', 'create invite', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export async function revokeInvite(codeHashPrefix: string): Promise<void> {
  await adminJson<{ ok: boolean }>(
    `/api/admin/invites/${encodeURIComponent(codeHashPrefix)}`,
    'revoke invite',
    { method: 'DELETE' },
  )
}

export async function listMembers(): Promise<MemberView[]> {
  const body = await adminJson<{ members: MemberView[] }>(
    '/api/admin/members',
    'list members',
  )
  return body.members
}

export async function revokeMember(sub: string): Promise<void> {
  await adminJson<{ ok: boolean }>(
    `/api/admin/members/${encodeURIComponent(sub)}`,
    'revoke member',
    { method: 'DELETE' },
  )
}
