import { apiUrl } from '../api/base'
import { deniedMessage } from './messages'
import { AuthRequestTimeoutError, boundedAuthRequest, AUTH_NETWORK_TIMEOUT_MS } from './request'
import { providerSubFromApi } from './session'
import type { SignInFlowDeps } from './flowDeps'
import type { SignInState } from './types'

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

/** The Plex PIN popup flow, lifted verbatim out of AuthProvider. Opens the
 *  popup, polls /api/auth/plex/check to completion, then confirms the
 *  HttpOnly-cookie session before releasing the sign-in slot. */
export async function runPlexSignIn(
  d: SignInFlowDeps,
  inviteCode?: string,
): Promise<void> {
  if (d.rejectMalformedInvite(inviteCode)) return
  if (d.signInInFlightRef.current) return
  d.stopPolling()
  const plexAttemptId = d.beginSignIn('plex')
  if (plexAttemptId === null) return
  const attemptSignal = d.activeSignInAbortRef.current!.signal
  const deadline = Date.now() + PLEX_POLL_DEADLINE_MS
  d.setSignInError(null)
  d.setSignOutError(null)
  d.setSignInState('opening')
  const popup = window.open(
    '',
    'plex-auth',
    'width=520,height=720,menubar=no,toolbar=no',
  )
  if (!popup) {
    d.stopPolling()
    d.setSignInState('error')
    d.setSignInError('Popup blocked. Allow popups for this site and try again.')
    return
  }
  d.popupRef.current = popup
  const setupGeneration = d.pollGenerationRef.current
  const setupIsCurrent = () =>
    d.pollGenerationRef.current === setupGeneration &&
    d.isSignInAttemptCurrent('plex', plexAttemptId)
  const setupTimeout = () =>
    Math.min(AUTH_NETWORK_TIMEOUT_MS, Math.max(0, deadline - Date.now()))
  const finish = (state: SignInState, error: string | null) => {
    d.stopPolling()
    d.setSignInState(state)
    d.setSignInError(error)
  }
  try {
    // Fetch the PUBLIC Plex client config (the clientId is the same
    // non-secret app id already embedded in every Plex auth URL).
    const { clientId, product } = await boundedAuthRequest(
      attemptSignal,
      setupTimeout(),
      async (signal) => {
        const cfgRes = await fetch(apiUrl('/api/auth/plex/config'), {
          credentials: 'include',
          signal,
        })
        if (!cfgRes.ok) throw new Error(`plex config failed: ${cfgRes.status}`)
        return (await cfgRes.json()) as { clientId: string; product: string }
      },
    )
    if (!setupIsCurrent()) return

    // Create the PIN DIRECTLY at plex.tv from the browser so plex.tv
    // attributes the sign-in to the VISITOR's own IP — not the server's
    // home IP, which previously leaked onto Plex's "Security Alert" page
    // for everyone authenticating. The backend keeps polling with this
    // SAME clientId, so checkPin still finds the authorized token.
    const pin = await boundedAuthRequest(
      attemptSignal,
      setupTimeout(),
      async (signal) => {
        const pinRes = await fetch('https://plex.tv/api/v2/pins?strong=true', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'X-Plex-Product': product,
            'X-Plex-Client-Identifier': clientId,
          },
          signal,
        })
        if (!pinRes.ok) throw new Error(`plex pin create failed: ${pinRes.status}`)
        return (await pinRes.json()) as { id: number; code: string }
      },
    )
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
    d.setSignInState('pending')

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

    const finishIfTerminal = () => {
      const error = terminalPollError()
      if (!error) return false
      finish('error', error)
      return true
    }

    const scheduleTick = () => {
      const generation = d.pollGenerationRef.current
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
      d.pollRef.current = window.setTimeout(() => {
        if (d.pollGenerationRef.current !== generation) return
        d.pollRef.current = null
        void poll()
      }, delay)
    }

    const scheduleNextCheck = (delay: number) => {
      nextCheckAt = Date.now() + delay
      scheduleTick()
    }

    const poll = async () => {
      const now = Date.now()
      if (finishIfTerminal()) return
      if (now < nextCheckAt) {
        scheduleTick()
        return
      }

      const attemptGeneration = ++d.pollGenerationRef.current
      const controller = new AbortController()
      d.pollAbortRef.current = controller
      const attemptIsCurrent = () =>
        d.pollGenerationRef.current === attemptGeneration &&
        d.pollAbortRef.current === controller &&
        !controller.signal.aborted
      const releaseAttempt = () => {
        if (d.pollRef.current !== null) window.clearTimeout(d.pollRef.current)
        d.pollRef.current = null
        if (d.pollAbortRef.current === controller) d.pollAbortRef.current = null
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
        d.pollRef.current = window.setTimeout(() => {
          if (!attemptIsCurrent()) return
          d.pollRef.current = null
          if (finishIfTerminal()) return
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
        if (finishIfTerminal()) return
        if (r.status === 403) {
          const data = await r.json().catch(() => ({}))
          if (!attemptIsCurrent()) return
          if (finishIfTerminal()) return
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
            if (finishIfTerminal()) return
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
        if (finishIfTerminal()) return
        if (data.status === 'authorized') {
          const providerSub = providerSubFromApi(data.user)
          if (!providerSub) {
            finish('error', 'Plex sign-in returned an unexpected response.')
            return
          }
          // Release Plex timers and the popup, but hold provider identity and
          // serialization until the HttpOnly-cookie session is confirmed.
          d.stopPolling(false)
          let confirmed = false
          try {
            confirmed = await d.confirmProviderSession(
              providerSub,
              'plex',
              plexAttemptId,
            )
          } finally {
            d.clearSignIn('plex', plexAttemptId)
          }
          if (!confirmed) return
          d.setSignInState('idle')
          d.setSignInError(null)
          d.setDiscoveredServers(data.discoveredServers ?? null)
          return
        }
        consecutiveFailures = 0
        releaseAttempt()
        scheduleNextCheck(PLEX_POLL_BASE_DELAY_MS)
      } catch {
        if (!attemptIsCurrent()) return
        if (finishIfTerminal()) return
        retryTransientFailure()
      }
    }

    scheduleTick()
  } catch (e) {
    if (!setupIsCurrent()) return
    finish(
      'error',
      e instanceof AuthRequestTimeoutError
        ? 'Plex sign-in timed out. Check your connection and try again.'
        : e instanceof Error
          ? e.message
          : String(e),
    )
  }
}
