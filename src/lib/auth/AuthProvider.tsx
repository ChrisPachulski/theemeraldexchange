/* eslint-disable react-refresh/only-export-components -- the AuthProvider
   component deliberately ships alongside its useAuth hook and private
   context. react-refresh's fast-refresh constraint is a dev-only DX nicety
   with zero runtime impact; splitting the pair would break the standard
   context+hook idiom for no correctness gain. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { apiUrl } from '../api/base'
import { runAppleSignIn } from './appleFlow'
import type { SignInFlowDeps } from './flowDeps'
import { inviteCodeError } from './messages'
import { runPlexSignIn } from './plexFlow'
import { AuthRequestTimeoutError, boundedAuthRequest, AUTH_NETWORK_TIMEOUT_MS } from './request'
import {
  SESSION_CONFIRMATION_UNAVAILABLE_ERROR,
  SESSION_MISMATCH_ERROR,
  SESSION_NOT_ESTABLISHED_ERROR,
} from './session'
import type { ActiveSignIn, AuthCtx, Role, SignInState } from './types'
import { useSessionReconcile } from './useSessionReconcile'
import { readStoredViewAs, writeStoredViewAs } from './viewAs'

const AuthContext = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [viewAs, setViewAsState] = useState<Role | null>(() => readStoredViewAs())
  const setViewAs = useCallback((next: Role | null) => {
    setViewAsState(next)
    writeStoredViewAs(next)
  }, [])
  const [signInState, setSignInState] = useState<SignInState>('idle')
  const [activeSignIn, setActiveSignIn] = useState<ActiveSignIn>(null)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [discoveredServers, setDiscoveredServers] =
    useState<AuthCtx['discoveredServers']>(null)
  const pollRef = useRef<number | null>(null)
  const pollAbortRef = useRef<AbortController | null>(null)
  const pollGenerationRef = useRef(0)
  const popupRef = useRef<Window | null>(null)
  const signInInFlightRef = useRef(false)
  const activeSignInRef = useRef<ActiveSignIn>(null)
  const activeSignInAttemptRef = useRef<number | null>(null)
  const activeSignInAbortRef = useRef<AbortController | null>(null)
  const nextSignInAttemptRef = useRef(0)
  const signOutInFlightRef = useRef(false)
  const signOutAbortRef = useRef<AbortController | null>(null)

  const {
    sessionState,
    sessionError,
    user,
    mountedRef,
    setSessionState,
    setSessionError,
    applyUser,
    invalidateSessionReads,
    readCurrentSession,
    broadcastAuthInvalidation,
    commitSessionResult,
    cancelScheduledSessionRefresh,
    drainDeferredSessionRefresh,
    clearDeferredSessionRefresh,
    retrySession,
  } = useSessionReconcile({
    signInInFlightRef,
    signOutInFlightRef,
    setViewAs,
    setDiscoveredServers,
  })

  const rejectMalformedInvite = useCallback((inviteCode?: string) => {
    const message = inviteCodeError(inviteCode)
    if (!message) return false
    setSignInState('error')
    setSignInError(message)
    setSignOutError(null)
    return true
  }, [])

  const isSignInAttemptCurrent = useCallback(
    (provider: Exclude<ActiveSignIn, null>, attemptId: number) =>
      !signOutInFlightRef.current &&
      signInInFlightRef.current &&
      activeSignInRef.current === provider &&
      activeSignInAttemptRef.current === attemptId &&
      activeSignInAbortRef.current?.signal.aborted === false,
    [],
  )

  const confirmProviderSession = useCallback(
    async (
      expectedSub: string,
      provider: Exclude<ActiveSignIn, null>,
      attemptId: number,
    ): Promise<boolean> => {
      if (!isSignInAttemptCurrent(provider, attemptId)) return false
      setSessionState('loading')
      setSessionError(null)
      const result = await readCurrentSession()
      if (
        result.status === 'aborted' ||
        !isSignInAttemptCurrent(provider, attemptId)
      ) {
        return false
      }
      if (result.status === 'unavailable') {
        commitSessionResult(result)
        setSignInState('error')
        setSignInError(SESSION_CONFIRMATION_UNAVAILABLE_ERROR)
        return false
      }
      if (result.status === 'anonymous') {
        commitSessionResult(result)
        setSignInState('error')
        setSignInError(SESSION_NOT_ESTABLISHED_ERROR)
        return false
      }
      if (result.user.sub !== expectedSub) {
        setSessionState('unavailable')
        setSessionError(SESSION_MISMATCH_ERROR)
        setSignInState('error')
        setSignInError(SESSION_MISMATCH_ERROR)
        return false
      }
      commitSessionResult(result)
      setSignInError(null)
      broadcastAuthInvalidation()
      return true
    },
    [
      broadcastAuthInvalidation,
      commitSessionResult,
      isSignInAttemptCurrent,
      readCurrentSession,
      setSessionError,
      setSessionState,
    ],
  )

  // Provider discovery. Best-effort: on failure authMethods stays null (all
  // buttons render).
  const [authMethods, setAuthMethods] = useState<AuthCtx['authMethods']>(null)
  useEffect(() => {
    let alive = true
    fetch(apiUrl('/api/auth/methods'))
      .then(async (r) => {
        if (alive && r.ok) setAuthMethods((await r.json()) as AuthCtx['authMethods'])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const beginSignIn = useCallback(
    (provider: Exclude<ActiveSignIn, null>): number | null => {
      if (!mountedRef.current || signInInFlightRef.current) return null
      cancelScheduledSessionRefresh()
      invalidateSessionReads()
      const attemptId = ++nextSignInAttemptRef.current
      activeSignInAbortRef.current = new AbortController()
      signInInFlightRef.current = true
      activeSignInRef.current = provider
      activeSignInAttemptRef.current = attemptId
      setActiveSignIn(provider)
      return attemptId
    },
    [cancelScheduledSessionRefresh, invalidateSessionReads, mountedRef],
  )

  const clearSignIn = useCallback(
    (provider?: Exclude<ActiveSignIn, null>, attemptId?: number) => {
      if (provider && activeSignInRef.current !== provider) return
      if (
        attemptId !== undefined &&
        activeSignInAttemptRef.current !== attemptId
      ) {
        return
      }
      activeSignInAbortRef.current?.abort()
      activeSignInAbortRef.current = null
      signInInFlightRef.current = false
      activeSignInRef.current = null
      activeSignInAttemptRef.current = null
      if (mountedRef.current) setActiveSignIn(null)
      drainDeferredSessionRefresh()
    },
    [drainDeferredSessionRefresh, mountedRef],
  )

  const beginAppleSignIn = useCallback(() => {
    const attemptId = beginSignIn('apple')
    if (attemptId === null) return null
    setSignInError(null)
    setSignOutError(null)
    setSignInState('opening')
    return attemptId
  }, [beginSignIn])
  const cancelAppleSignIn = useCallback((attemptId: number) => {
    if (
      activeSignInRef.current !== 'apple' ||
      activeSignInAttemptRef.current !== attemptId
    ) {
      return
    }
    clearSignIn('apple', attemptId)
    if (mountedRef.current) setSignInState('idle')
  }, [clearSignIn, mountedRef])

  const stopPolling = useCallback((clearActive = true) => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current)
    pollRef.current = null
    pollGenerationRef.current += 1
    pollAbortRef.current?.abort()
    pollAbortRef.current = null
    if (clearActive) clearSignIn()
    popupRef.current?.close()
    popupRef.current = null
  }, [clearSignIn])

  useEffect(
    () => () => {
      stopPolling()
      signOutAbortRef.current?.abort()
      signOutAbortRef.current = null
      signOutInFlightRef.current = false
    },
    [stopPolling],
  )

  // One object of render-stable refs/setters/callbacks, handed to the
  // per-provider flow modules so their bodies read exactly as they did inside
  // this closure. Rebuilt per call (never a hook dependency) so it always
  // carries the current callbacks.
  const flowDeps = useCallback(
    (): SignInFlowDeps => ({
      rejectMalformedInvite,
      beginSignIn,
      clearSignIn,
      isSignInAttemptCurrent,
      confirmProviderSession,
      stopPolling,
      setSignInState,
      setSignInError,
      setSignOutError,
      setDiscoveredServers,
      signInInFlightRef,
      activeSignInRef,
      activeSignInAttemptRef,
      activeSignInAbortRef,
      popupRef,
      pollRef,
      pollAbortRef,
      pollGenerationRef,
    }),
    [
      beginSignIn,
      clearSignIn,
      confirmProviderSession,
      isSignInAttemptCurrent,
      rejectMalformedInvite,
      stopPolling,
    ],
  )

  const signIn = useCallback(
    (inviteCode?: string) => runPlexSignIn(flowDeps(), inviteCode),
    [flowDeps],
  )

  const appleSignIn = useCallback(
    (args: {
      identityToken: string
      nonce?: string
      inviteCode?: string
      /** Attempt returned by beginAppleSignIn for the pre-token SDK phase. */
      attemptId?: number
    }): Promise<boolean> => runAppleSignIn(flowDeps(), args),
    [flowDeps],
  )

  const signOut = useCallback(async () => {
    if (signOutInFlightRef.current) return
    signOutInFlightRef.current = true
    const controller = new AbortController()
    signOutAbortRef.current = controller
    setSignOutError(null)
    cancelScheduledSessionRefresh()
    invalidateSessionReads()
    stopPolling()
    let failure: unknown = null
    try {
      const response = await boundedAuthRequest(
        controller.signal,
        AUTH_NETWORK_TIMEOUT_MS,
        (signal) =>
          fetch(apiUrl('/api/auth/logout'), {
            method: 'POST',
            credentials: 'include',
            signal,
          }),
      )
      if (!response.ok) throw new Error(`logout failed: ${response.status}`)
    } catch (err) {
      failure = err
    } finally {
      if (signOutAbortRef.current === controller) signOutAbortRef.current = null
      signOutInFlightRef.current = false
      if (mountedRef.current) {
        invalidateSessionReads()
        clearDeferredSessionRefresh()
        applyUser(null)
        setSessionState('anonymous')
        setSessionError(null)
        setSignInState('idle')
        setSignInError(null)
        setViewAs(null)
        setDiscoveredServers(null)
        if (failure) {
          setSignOutError(
            failure instanceof AuthRequestTimeoutError
              ? 'Sign-out timed out. Your local session was cleared; try again if this device signs back in.'
              : 'Sign-out failed on the server, but your local session was cleared. Try again if this device signs back in.',
          )
        }
      }
    }
    if (failure) throw failure
    broadcastAuthInvalidation()
  }, [
    applyUser,
    broadcastAuthInvalidation,
    cancelScheduledSessionRefresh,
    clearDeferredSessionRefresh,
    invalidateSessionReads,
    mountedRef,
    setSessionError,
    setSessionState,
    setViewAs,
    stopPolling,
  ])

  const loading = sessionState === 'loading'
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
        sessionState,
        sessionError,
        retrySession,
        user,
        role,
        effectiveRole,
        isAdmin,
        setViewAs,
        signInState,
        activeSignIn,
        signInError,
        signOutError,
        discoveredServers,
        signIn,
        appleSignIn,
        beginAppleSignIn,
        cancelAppleSignIn,
        signOut,
        authMethods,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// Co-located with AuthProvider — standard context+hook idiom. The two are
// coupled by the private AuthContext and shouldn't be moved apart.
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
