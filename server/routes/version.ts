// GET /api/version — public, unauthenticated. Apple apps query this
// during PIN-pair to discover (a) the server_id for Keychain keying
// and (b) which auth_modes the server supports (so the app knows
// whether to offer Plex sign-in, local sign-in, Sign in with Apple,
// or some combination).
//
// Per contract §12.3 the response is intentionally minimal — no PII,
// no token material, no per-user state. A misconfigured tunnel can
// safely return this body to anyone on the internet.

import { Hono } from 'hono'
import { env } from '../env.js'
import { ensureServerId } from '../session.js'

export const version = new Hono()

// Comparable semantic version of the server, used by the Apple client's
// min-server-version gate (cross-service contract §12.1/§12.2: plain-semver
// comparison between `server.version` and the app-side MIN_SERVER_VERSION,
// with a 503 { error: 'server_too_old', ... } when the server is too old).
//
// This is intentionally distinct from `release` (the CI build identifier from
// EEX_RELEASE, which may be a git SHA and is NOT semver-comparable). The
// version is sourced from EEX_VERSION at image build time and falls back to a
// pinned default so the field is always a valid, comparable semver — never a
// SHA or 'dev'. Bump in lockstep with the package release.
const SERVER_VERSION = (() => {
  const raw = (process.env.EEX_VERSION ?? '').trim()
  // Guard: only accept a plain x.y.z semver core so the field stays
  // semver-comparable for the app-side gate. Anything else (a SHA, 'dev',
  // empty) falls back to the pinned default.
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(raw) ? raw : '0.1.0'
})()

version.get('/', (c) => {
  const auth_modes: string[] = []
  // Plex is the only mode supported today; isPlexConfigured() always
  // returns true because PLEX_CLIENT_ID is `required()` at boot. The
  // shape is an array so M2+ work (local-auth, Sign in with Apple) can
  // add entries without a contract break.
  auth_modes.push('plex')

  return c.json({
    server_id: ensureServerId(),
    /**
     * Plain-semver server version for the contract §12 compatibility gate.
     * `apiVersion` is an alias of `version`; both carry the same value so
     * either field name the Apple client reads resolves the min-server check.
     */
    version: SERVER_VERSION,
    apiVersion: SERVER_VERSION,
    /** Build identifier from CI; falls back to 'dev'. NOT semver-comparable. */
    release: env.EEX_RELEASE,
    auth_modes,
    /** Mirrors contract §12.3 — apps gate "you may pair" on this. */
    accepting_device_pairs: !!env.deviceTokenSecret,
  })
})
