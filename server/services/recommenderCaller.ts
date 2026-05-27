// Lift a request's authenticated Session into the InternalPrincipal
// shape the recommender (and future M3 media-core / M4 transcoder)
// client expects.
//
// Every route that calls into a downstream internal service builds one
// of these from `c.get('session')` and passes it to the client function.
// The client adds the Bearer JWE header only when env.internalPrincipalSecret
// is configured; in dev without the secret the call goes through with
// the existing x-recommender-secret HMAC alone (recommender's
// off/log/enforce mode controls receiver-side enforcement).
//
// serverId is memoized at module level: ensureServerId() is idempotent
// but doing a SELECT on every recommender call adds a syscall to the
// hot path of a fire-and-forget mirror. The cached value is stable for
// the process lifetime (the server_state row is INSERT OR IGNORE'd
// once at boot).

import { authModeFromSession, type Session } from '../session.js'
import { ensureServerId } from './serverDb.js'
import type { RecommenderCaller } from './recommender.js'

let cachedServerId: string | null = null
let serverIdFailed = false

function getServerId(): string | null {
  if (cachedServerId) return cachedServerId
  if (serverIdFailed) return null
  try {
    cachedServerId = ensureServerId()
    return cachedServerId
  } catch (e) {
    // server.db unavailable (mis-mounted volume, mocked env in tests,
    // etc.). Latch the failure so we don't retry on every request —
    // ensureServerId hits the disk to migrate on first call, and if it
    // failed once it will keep failing until the operator restarts the
    // process. Returning null degrades the recommender call to no-Bearer
    // mode rather than 500ing the user's request. In off/log mode the
    // recommender accepts; enforce mode 401s, surfacing the operator
    // misconfiguration loud and clear.
    serverIdFailed = true
    console.warn(
      '[recommenderCaller] ensureServerId failed — falling back to ' +
        'no-Bearer recommender calls until process restart:',
      e instanceof Error ? e.message : String(e),
    )
    return null
  }
}

/** Test-only: reset memoized server_id (and the failure latch) after
 *  a serverDb swap in tests. */
export function _resetServerIdForTests(): void {
  cachedServerId = null
  serverIdFailed = false
}

/** Build the caller-identity payload that the internal-principal JWE
 *  carries to the recommender. Returns null when ensureServerId fails
 *  (test env without SERVER_DB_PATH, mis-mounted volume) — the
 *  recommender client treats an absent caller as "skip the Bearer
 *  header" and the request still goes through with the
 *  x-recommender-secret HMAC.
 *
 *  deviceId is left undefined because the Bearer-authed Session shape
 *  (via deviceSessionToSession) does not currently surface the
 *  device_id claim. When that plumbing lands, extend this helper —
 *  every call site already passes through here, so it's a one-place
 *  change. */
export function recommenderCallerFromSession(session: Session): RecommenderCaller | undefined {
  const serverId = getServerId()
  if (!serverId) return undefined
  return {
    sub: session.sub,
    role: session.role,
    authMode: authModeFromSession(session),
    serverId,
  }
}
