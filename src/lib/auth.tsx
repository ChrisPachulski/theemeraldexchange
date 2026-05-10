import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { apiUrl } from './api/base'

// Auth state shared by the whole app. The session is server-side
// (HttpOnly cookie); we only mirror identity + role here so the UI can
// gate buttons and show the username. /api/me returns 401 when no
// session — that's our "show login screen" signal.

export type Role = 'admin' | 'user'
export type AuthUser = { username: string; role: Role }

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
  /** Discovered Plex servers, only present when PLEX_SERVER_ID isn't set yet. */
  discoveredServers: { name: string; id: string; owned: boolean }[] | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [viewAs, setViewAs] = useState<Role | null>(null)
  const [signInState, setSignInState] = useState<SignInState>('idle')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [discoveredServers, setDiscoveredServers] =
    useState<AuthCtx['discoveredServers']>(null)
  const pollRef = useRef<number | null>(null)
  const popupRef = useRef<Window | null>(null)

  // Initial session probe.
  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/me'), { credentials: 'include' })
      .then(async (r) => {
        if (!alive) return
        if (r.status === 401) {
          setUser(null)
        } else if (r.ok) {
          const { user } = (await r.json()) as { user: AuthUser }
          setUser(user)
        }
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const signIn = useCallback(async () => {
    setSignInError(null)
    setSignInState('opening')
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

      popupRef.current = window.open(
        authUrl,
        'plex-auth',
        'width=520,height=720,menubar=no,toolbar=no',
      )
      setSignInState('pending')

      stopPolling()
      pollRef.current = window.setInterval(async () => {
        try {
          const r = await fetch(
            apiUrl('/api/auth/plex/check', { pinId: String(pinId) }),
            { credentials: 'include' },
          )
          if (r.status === 403) {
            const data = await r.json().catch(() => ({}))
            stopPolling()
            popupRef.current?.close()
            setSignInState('denied')
            setSignInError(
              data?.reason === 'not_a_server_member'
                ? "You aren't a member of this Plex server."
                : 'Access denied.',
            )
            return
          }
          if (!r.ok) return // network blip — keep polling
          const data = await r.json()
          if (data.status === 'authorized') {
            stopPolling()
            popupRef.current?.close()
            setUser(data.user as AuthUser)
            setDiscoveredServers(data.discoveredServers ?? null)
            setSignInState('idle')
          }
        } catch {
          // poll again
        }
      }, 1500)
    } catch (e) {
      setSignInState('error')
      setSignInError(e instanceof Error ? e.message : String(e))
    }
  }, [stopPolling])

  const signOut = useCallback(async () => {
    await fetch(apiUrl('/api/auth/logout'), {
      method: 'POST',
      credentials: 'include',
    }).catch(() => {})
    setUser(null)
    setViewAs(null)
    setDiscoveredServers(null)
  }, [])

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
        discoveredServers,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
