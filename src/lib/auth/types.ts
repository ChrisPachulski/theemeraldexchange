// Auth state shared by the whole app. The session is server-side
// (HttpOnly cookie); we only mirror identity + role here so the UI can
// gate buttons and show the username. /api/me returns 401 when no
// session — that's our "show login screen" signal.

export type Role = 'admin' | 'user'
/** Which federated identity provider minted the session. Mirrors the
 *  gateway's AuthMode (crates/auth). `local` is the passkey-era owner. */
export type AuthMode = 'apple' | 'google' | 'workos' | 'local'
export type AuthUser = {
  /** Namespaced subject: `apple:<subject>` | `workos:user_…` | …. Used by the
   *  SPA to scope per-user localStorage (BYO API key, etc.) so a shared
   *  device that's been signed in as different family members reads the
   *  right state. The prefix also tells us which provider authed. */
  sub: string
  username: string
  role: Role
  /** Provider that authenticated this session, so chrome can render
   *  "Signed in with Apple" vs "Signed in with WorkOS". May be absent on
   *  pre-existing sessions; derive from the `sub` prefix when missing. */
  auth_mode?: AuthMode
}

/** Best-effort provider inference when the server omits `auth_mode`. The
 *  sub prefix is authoritative; authUserFromApi admits only these four. */
export function authModeFromUser(user: Pick<AuthUser, 'sub' | 'auth_mode'>): AuthMode {
  if (user.auth_mode) return user.auth_mode
  if (user.sub.startsWith('apple:')) return 'apple'
  if (user.sub.startsWith('google:')) return 'google'
  if (user.sub.startsWith('workos:')) return 'workos'
  return 'local'
}

export type SessionState =
  | 'loading'
  | 'authenticated'
  | 'anonymous'
  | 'unavailable'

export type SessionReadResult =
  | { status: 'authenticated'; user: AuthUser }
  | { status: 'anonymous' }
  | { status: 'unavailable' }
  | { status: 'aborted' }

export type SignInState = 'idle' | 'opening' | 'pending' | 'denied' | 'error'
export type ActiveSignIn = 'apple' | null

export type AuthCtx = {
  loading: boolean
  sessionState: SessionState
  sessionError: string | null
  /** Re-read the HttpOnly-cookie session with a fresh bounded attempt set. */
  retrySession: () => Promise<void>
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
  activeSignIn: ActiveSignIn
  signInError: string | null
  signOutError: string | null
  /**
   * Complete the web Sign in with Apple flow. The caller has already
   * obtained an Apple identity token (JWT) from AppleID.auth.signIn();
   * we POST it to /api/auth/apple, where the server verifies it against
   * Apple's JWKS. `inviteCode` is forwarded for first-time redemption.
   * Returns true on success (session minted), false otherwise — the
   * error detail lives in `signInError` and the phase in `signInState`.
   */
  appleSignIn: (
    args: {
      identityToken: string
      nonce?: string
      inviteCode?: string
      /** Attempt returned by beginAppleSignIn for the pre-token SDK phase. */
      attemptId?: number
    },
  ) => Promise<boolean>
  /** Reserve the shared sign-in slot before opening Apple's SDK popup. */
  beginAppleSignIn: () => number | null
  /** Release that slot when Apple's SDK popup is cancelled or fails. */
  cancelAppleSignIn: (attemptId: number) => void
  signOut: () => Promise<void>
  /**
   * Which login providers this install actually offers (/api/auth/methods).
   * null until fetched — render all buttons while unknown so a slow API
   * never hides the way in.
   */
  authMethods: {
    apple: boolean
    google: boolean
    workos?: boolean
  } | null
}

