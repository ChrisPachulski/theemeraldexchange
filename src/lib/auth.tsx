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

// Auth state shared by the whole app. The session is server-side
// (HttpOnly cookie); we only mirror identity + role here so the UI can
// gate buttons and show the username. /api/me returns 401 when no
// session — that's our "show login screen" signal.

export type Role = 'admin' | 'user'
export type AuthUser = {
  /** Stable Plex user id. Used by the SPA to scope per-user
   *  localStorage (BYO API key, etc.) so a shared device that's been
   *  signed in as different family members reads the right state. */
  sub: string
  username: string
  role: Role
}

type SignInState = 'idle' | 'opening' | 'pending' | 'denied' | 'error'

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
  signIn: () => Promise<void>
  signOut: () => Promise<void>
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
  const popupRef = useRef<Window | null>(null)
  const signInInFlightRef = useRef(false)

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

  const stopPolling = useCallback((intervalId?: number | null) => {
    const id = intervalId === undefined ? pollRef.current : intervalId
    if (id !== null && id !== undefined) {
      window.clearInterval(id)
    }
    if (intervalId === undefined || pollRef.current === intervalId) {
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const signIn = useCallback(async () => {
    if (signInInFlightRef.current) return
    signInInFlightRef.current = true
    setSignInError(null)
    setSignOutError(null)
    stopPolling()
    popupRef.current?.close()
    setSignInState('opening')
    const popup = window.open(
      '',
      'plex-auth',
      'width=520,height=720,menubar=no,toolbar=no',
    )
    if (!popup) {
      signInInFlightRef.current = false
      setSignInState('error')
      setSignInError('Popup blocked. Allow popups for this site and try again.')
      return
    }
    popupRef.current = popup
    let intervalId: number | null = null
    const stopCurrentPoll = () => {
      stopPolling(intervalId)
      intervalId = null
      signInInFlightRef.current = false
    }
    try {
      const res = await fetch(apiUrl('/api/auth/plex/pin'), {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`pin create failed: ${res.status}`)
      const { pinId, authUrl } = (await res.json()) as {
        pinId: number
        authUrl: string
      }

      popup.location.href = authUrl
      setSignInState('pending')

      const deadline = Date.now() + 5 * 60 * 1000
      intervalId = window.setInterval(async () => {
        if (popup.closed) {
          stopCurrentPoll()
          if (popupRef.current === popup) popupRef.current = null
          setSignInState('error')
          setSignInError('Plex sign-in window was closed before authorization finished.')
          return
        }
        if (Date.now() > deadline) {
          stopCurrentPoll()
          popup.close()
          if (popupRef.current === popup) popupRef.current = null
          setSignInError('Plex sign-in expired. Try again.')
          setSignInState('error')
          return
        }
        try {
          // POST (not GET) so the CSRF middleware gates the cookie-
          // setting branch. Otherwise an attacker page could trigger a
          // cross-site GET with their own pinId and overwrite the
          // victim's session.
          const r = await fetch(apiUrl('/api/auth/plex/check'), {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinId }),
          })
          if (r.status === 403) {
            const data = await r.json().catch(() => ({}))
            stopCurrentPoll()
            popup.close()
            if (popupRef.current === popup) popupRef.current = null
            setSignInState('denied')
            setSignInError(
              data?.reason === 'not_a_server_member'
                ? "You aren't a member of this Plex server."
                : 'Access denied.',
            )
            return
          }
          if (!r.ok) {
            if (r.status >= 400 && r.status < 500) {
              const data = await r.json().catch(() => ({}))
              stopCurrentPoll()
              popup.close()
              if (popupRef.current === popup) popupRef.current = null
              setSignInState('error')
              setSignInError(
                typeof data?.error === 'string'
                  ? `Plex sign-in failed: ${data.error}`
                  : 'Plex sign-in expired. Try again.',
              )
            }
            return
          }
          const data = await r.json()
          if (data.status === 'authorized') {
            stopCurrentPoll()
            popup.close()
            if (popupRef.current === popup) popupRef.current = null
            applyUser(data.user as AuthUser)
            setDiscoveredServers(data.discoveredServers ?? null)
            setSignInState('idle')
          }
        } catch {
          // poll again
        }
      }, 1500)
      pollRef.current = intervalId
    } catch (e) {
      signInInFlightRef.current = false
      popup.close()
      if (popupRef.current === popup) popupRef.current = null
      setSignInState('error')
      setSignInError(e instanceof Error ? e.message : String(e))
    }
  }, [applyUser, stopPolling])

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
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// Co-located with AuthProvider — standard context+hook idiom. The
// fast-refresh rule prefers splitting, but the two are coupled by the
// private AuthContext and shouldn't be moved apart.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
