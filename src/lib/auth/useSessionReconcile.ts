import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../queryClient'
import {
  readBrowserSession,
  SESSION_UNAVAILABLE_ERROR,
} from './session'
import type { AuthCtx, AuthUser, Role, SessionReadResult, SessionState } from './types'

const AUTH_INVALIDATION_CHANNEL = 'exchange:auth-change:v1'
const SESSION_REFRESH_DEDUPE_MS = 100

/** What the reconcile hook needs from the sign-in half of AuthProvider: the
 *  two in-flight flags a background refresh must never race, and the two
 *  setters an "anonymous" result clears. All render-stable. */
export type SessionReconcileDeps = {
  signInInFlightRef: { current: boolean }
  signOutInFlightRef: { current: boolean }
  setViewAs: (role: Role | null) => void
  setDiscoveredServers: (servers: AuthCtx['discoveredServers']) => void
}

/**
 * Session truth + cross-tab reconciliation, lifted verbatim out of
 * AuthProvider: the bounded /api/me reader, the dedupe/defer scheduler,
 * BroadcastChannel invalidation, focus/visibility/bfcache refresh, and the
 * edge-auth-expiry listener. The provider keeps the sign-in machinery and
 * consumes what this returns.
 */
export function useSessionReconcile({
  signInInFlightRef,
  signOutInFlightRef,
  setViewAs,
  setDiscoveredServers,
}: SessionReconcileDeps) {
  const qc = useQueryClient()
  const [sessionState, setSessionState] = useState<SessionState>('loading')
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [user, setUser] = useState<AuthUser | null>(null)
  const userRef = useRef<AuthUser | null>(null)
  // Per-user data (feedback dots, usage totals, BYO-key-scoped
  // suggestions) lives in the React Query cache. Without a reset on
  // identity change, a shared device leaks state across users — sign
  // out as Alice on the AppleTV, sign in as Bob, and Bob sees Alice's
  // dots until each query refetches.
  //
  // The fingerprint segment on suggestions/feedback keys helps but
  // isn't exhaustive: feedback's key is just ['feedback'], usage's
  // ['usage', ...] isn't sub-scoped, and a per-key audit grows brittle
  // as new hooks land. Cache-clear on principal or role transition is the
  // belt-and-suspenders fix — synchronous so the first re-render under a new
  // authority sees an empty cache. A background recheck of the same principal
  // deliberately preserves the cache and dashboard.
  const applyUser = useCallback(
    (next: AuthUser | null) => {
      const current = userRef.current
      if (
        next === null ||
        current?.sub !== next.sub ||
        current?.role !== next.role
      ) {
        qc.clear()
      }
      userRef.current = next
      setUser(next)
    },
    [qc],
  )
  const sessionReadRef = useRef<AbortController | null>(null)
  const sessionReadGenerationRef = useRef(0)
  const sessionRefreshTimerRef = useRef<number | null>(null)
  const pendingRefreshBroadcastRef = useRef(false)
  const deferredRefreshRef = useRef(false)
  const deferredRefreshBroadcastRef = useRef(false)
  const authChannelRef = useRef<BroadcastChannel | null>(null)
  const authInvalidationEpochRef = useRef(0)
  const foregroundSessionReadRef = useRef<Promise<void> | null>(null)
  const mountedRef = useRef(true)

  const invalidateSessionReads = useCallback(() => {
    sessionReadGenerationRef.current += 1
    sessionReadRef.current?.abort()
    sessionReadRef.current = null
  }, [])

  const readCurrentSession = useCallback(async (): Promise<SessionReadResult> => {
    if (!mountedRef.current) return { status: 'aborted' }
    invalidateSessionReads()
    const controller = new AbortController()
    const generation = sessionReadGenerationRef.current
    sessionReadRef.current = controller
    const result = await readBrowserSession(controller.signal)
    if (
      !mountedRef.current ||
      controller.signal.aborted ||
      sessionReadGenerationRef.current !== generation ||
      sessionReadRef.current !== controller
    ) {
      return { status: 'aborted' }
    }
    sessionReadRef.current = null
    return result
  }, [invalidateSessionReads])

  const broadcastAuthInvalidation = useCallback(() => {
    try {
      authChannelRef.current?.postMessage({
        type: 'invalidate',
        epoch: ++authInvalidationEpochRef.current,
      })
    } catch {
      // Broadcast is best-effort. Local session truth never depends on it;
      // focus/visibility/pageshow still reconcile tabs without channel support.
    }
  }, [])

  const commitSessionResult = useCallback(
    (
      result: Exclude<SessionReadResult, { status: 'aborted' }>,
      options: { background?: boolean; broadcastAnonymous?: boolean } = {},
    ) => {
      if (!mountedRef.current) return
      if (result.status === 'authenticated') {
        applyUser(result.user)
        setSessionState('authenticated')
        setSessionError(null)
      } else if (result.status === 'anonymous') {
        const wasAuthenticated = userRef.current !== null
        applyUser(null)
        setSessionState('anonymous')
        setSessionError(null)
        setViewAs(null)
        setDiscoveredServers(null)
        if (wasAuthenticated && options.broadcastAnonymous) {
          broadcastAuthInvalidation()
        }
      } else {
        if (options.background && userRef.current !== null) return
        setSessionState('unavailable')
        setSessionError(SESSION_UNAVAILABLE_ERROR)
      }
    },
    [applyUser, broadcastAuthInvalidation, setDiscoveredServers, setViewAs],
  )

  const cancelScheduledSessionRefresh = useCallback(() => {
    if (sessionRefreshTimerRef.current !== null) {
      window.clearTimeout(sessionRefreshTimerRef.current)
      sessionRefreshTimerRef.current = null
    }
    pendingRefreshBroadcastRef.current = false
  }, [])

  const scheduleSessionRefresh = useCallback(
    (broadcastAnonymous: boolean) => {
      if (!mountedRef.current) return
      if (
        signInInFlightRef.current ||
        signOutInFlightRef.current ||
        foregroundSessionReadRef.current !== null
      ) {
        deferredRefreshRef.current = true
        deferredRefreshBroadcastRef.current ||= broadcastAnonymous
        return
      }
      pendingRefreshBroadcastRef.current ||= broadcastAnonymous
      if (sessionRefreshTimerRef.current !== null) return
      sessionRefreshTimerRef.current = window.setTimeout(() => {
        sessionRefreshTimerRef.current = null
        const shouldBroadcastAnonymous = pendingRefreshBroadcastRef.current
        pendingRefreshBroadcastRef.current = false
        if (
          signInInFlightRef.current ||
          signOutInFlightRef.current ||
          foregroundSessionReadRef.current !== null
        ) {
          deferredRefreshRef.current = true
          deferredRefreshBroadcastRef.current ||= shouldBroadcastAnonymous
          return
        }
        void readCurrentSession().then((result) => {
          if (result.status !== 'aborted') {
            commitSessionResult(result, {
              background: true,
              broadcastAnonymous: shouldBroadcastAnonymous,
            })
          }
        })
      }, SESSION_REFRESH_DEDUPE_MS)
    },
    [commitSessionResult, readCurrentSession, signInInFlightRef, signOutInFlightRef],
  )

  const drainDeferredSessionRefresh = useCallback(() => {
    if (!deferredRefreshRef.current) return
    const shouldBroadcastAnonymous = deferredRefreshBroadcastRef.current
    deferredRefreshRef.current = false
    deferredRefreshBroadcastRef.current = false
    scheduleSessionRefresh(shouldBroadcastAnonymous)
  }, [scheduleSessionRefresh])

  const retrySession = useCallback((): Promise<void> => {
    if (signInInFlightRef.current || signOutInFlightRef.current) {
      deferredRefreshRef.current = true
      deferredRefreshBroadcastRef.current = true
      return Promise.resolve()
    }
    const activeRead = foregroundSessionReadRef.current
    if (activeRead) return activeRead
    cancelScheduledSessionRefresh()
    setSessionState('loading')
    setSessionError(null)
    const foregroundRead = readCurrentSession()
      .then((result) => {
        if (result.status !== 'aborted') {
          commitSessionResult(result, { broadcastAnonymous: true })
        }
      })
      .finally(() => {
        if (foregroundSessionReadRef.current === foregroundRead) {
          foregroundSessionReadRef.current = null
          drainDeferredSessionRefresh()
        }
      })
    foregroundSessionReadRef.current = foregroundRead
    return foregroundRead
  }, [
    cancelScheduledSessionRefresh,
    commitSessionResult,
    drainDeferredSessionRefresh,
    readCurrentSession,
    signInInFlightRef,
    signOutInFlightRef,
  ])

  // Initial session probe. Cleanup aborts both the initial read and any later
  // provider confirmation that happens to be in flight during unmount.
  useEffect(() => {
    mountedRef.current = true
    void readCurrentSession().then((result) => {
      if (result.status !== 'aborted') commitSessionResult(result)
    })
    return () => {
      mountedRef.current = false
      cancelScheduledSessionRefresh()
      invalidateSessionReads()
    }
  }, [
    cancelScheduledSessionRefresh,
    commitSessionResult,
    invalidateSessionReads,
    readCurrentSession,
  ])

  // Cross-tab messages are deliberately data-free: receiving tabs re-read the
  // HttpOnly-cookie session instead of trusting identity sent by another tab.
  // BroadcastChannel is optional; lifecycle events below provide eventual
  // consistency on older or privacy-restricted browsers.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    let channel: BroadcastChannel
    try {
      channel = new BroadcastChannel(AUTH_INVALIDATION_CHANNEL)
    } catch {
      return
    }
    authChannelRef.current = channel
    const onMessage = (event: MessageEvent<unknown>) => {
      const data = event.data
      if (
        typeof data === 'object' &&
        data !== null &&
        (data as { type?: unknown }).type === 'invalidate' &&
        typeof (data as { epoch?: unknown }).epoch === 'number'
      ) {
        scheduleSessionRefresh(false)
      }
    }
    channel.addEventListener('message', onMessage)
    return () => {
      channel.removeEventListener('message', onMessage)
      channel.close()
      if (authChannelRef.current === channel) authChannelRef.current = null
    }
  }, [scheduleSessionRefresh])

  useEffect(() => {
    const refresh = () => scheduleSessionRefresh(true)
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const refreshFromBfCache = (event: PageTransitionEvent) => {
      if (event.persisted) refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('pageshow', refreshFromBfCache)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('pageshow', refreshFromBfCache)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [scheduleSessionRefresh])

  // Centralised edge-auth expiry handling. A protected request can suggest that the
  // cookie expired, but only /api/me is allowed to declare this browser
  // anonymous. Revalidate through the same bounded reader so a transient API
  // failure shows Retry instead of flashing the public walkthrough.
  useEffect(() => {
    const onExpired = () => {
      void retrySession()
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [retrySession])

  /** Drop a deferred background refresh outright — sign-out has already
   *  settled the session locally, so replaying one would be noise. */
  const clearDeferredSessionRefresh = useCallback(() => {
    deferredRefreshRef.current = false
    deferredRefreshBroadcastRef.current = false
  }, [])

  return {
    sessionState,
    sessionError,
    user,
    userRef,
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
  }
}
