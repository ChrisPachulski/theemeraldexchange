// Google Sign-In identity-token verifier.
//
// The Google parallel of appleAuth.ts. Proves IDENTITY ONLY: "is this a
// genuine, unexpired Google ID token minted for one of THIS app's OAuth
// client ids, and what is the verified `google:<subject>` sub?" — nothing
// more. A valid signed Google token with no redeemed invite / no member row
// is still rejected downstream by the invite/members allowlist (authZ).
//
// No client secret is consumed: identity-token verification uses Google's
// PUBLIC JWKS, so a native app can complete sign-in with PKCE (a public
// client) and hand us the resulting id_token — consistent with the project's
// "no new credential store" constraint. The OAuth client secret (if any) is
// never needed here and is never stored.
//
// Verification (inside verifyGoogleIdentityToken):
//   1. Cheap shape pre-check (three dot-separated segments).
//   2. jwtVerify against Google's JWKS, algorithms pinned to RS256, issuer
//      pinned to accounts.google.com (with or without https://), audience
//      pinned to the configured client-id allow-list, exp with 60s skew.
//   3. nonce (if expected) compared constant-time.
//   4. sub re-validated through parseSub (google pattern) — the only sub
//      that leaves this module comes from a signature-verified payload.
//
// Security invariants mirror appleAuth.ts: never trust a client-supplied
// sub; pin algorithms to ['RS256'] (defeats alg=none / RS-HS confusion);
// pin aud + iss; fail closed when no client id is configured; JWKS URL is a
// hardcoded constant (no SSRF); no secrets logged.
//
// Reference: https://developers.google.com/identity/openid-connect/openid-connect#validatinganidtoken

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { parseSub, type Sub } from './sub.js'
import { constantTimeEqual } from './secrets.js'
import { env } from '../env.js'

// Google publishes both forms of the issuer claim depending on the flow;
// accept either. jose's `issuer` option takes a string[] and matches any.
const GOOGLE_ISS = ['accounts.google.com', 'https://accounts.google.com']
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs')

// 60s clock skew — same posture as appleAuth.ts / the device-token verifier.
const CLOCK_TOLERANCE_SECS = 60

// Single module-level JWKS set (shared cache, kid-rotation handling,
// anti-abuse cooldown). One instance per process — see appleAuth.ts for the
// full rationale on why per-request creation would be wrong.
let googleJwks: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL, {
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
  timeoutDuration: 5_000,
})

/** Configured Google `aud` allow-list (OAuth client ids). Empty → fail
 *  closed. Read through the exported env object so tests can flip it. */
function googleAudiences(): string[] {
  return env.googleClientIds
}

export type GoogleVerifyError =
  | 'not_configured' //   no GOOGLE_CLIENT_ID — fail closed, never verify against empty aud
  | 'malformed_token' //  not a JWT / unparseable
  | 'invalid_signature' // sig didn't verify, or an alg-downgrade attempt (alg!=RS256)
  | 'unknown_key' //      kid not present in Google JWKS (after refetch)
  | 'expired' //          exp in the past (beyond skew)
  | 'wrong_iss' //        iss != accounts.google.com
  | 'wrong_aud' //        aud not in the configured client-id allow-list
  | 'nonce_mismatch' //   expected nonce absent or != claim
  | 'bad_subject' //      sub claim missing / fails parseSub google pattern
  | 'jwks_unavailable' // network/timeout fetching Google keys (our problem → 5xx)
  | 'unknown_error'

export type GoogleVerifyResult =
  | { ok: true; sub: Sub; email?: string; emailVerified?: boolean; name?: string }
  | { ok: false; error: GoogleVerifyError }

/**
 * Verify a Google ID token (the `id_token` returned by Google Sign-In) and
 * return the signature-verified `google:<subject>` sub, or a typed error.
 *
 * Never throws — every failure is classified so the route can choose an HTTP
 * status (all 4xx auth failures EXCEPT `jwks_unavailable`, a transient
 * Google-side outage that must surface as 5xx so it is not blamed on the
 * user).
 *
 * @param idToken  the raw Google ID token (a compact JWS).
 * @param opts.expectedNonce  if provided, `payload.nonce` must be present
 *        and equal (constant-time). Google echoes the raw nonce the client
 *        sent in the auth request — pass that verbatim.
 */
export async function verifyGoogleIdentityToken(
  idToken: string,
  opts: { expectedNonce?: string } = {},
): Promise<GoogleVerifyResult> {
  // Fail closed if no audience is configured — verifying against an empty
  // aud would accept tokens minted for any Google OAuth client.
  const audience = googleAudiences()
  if (audience.length === 0) return { ok: false, error: 'not_configured' }

  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.split('.').length !== 3) {
    return { ok: false, error: 'malformed_token' }
  }

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(idToken, googleJwks, {
      issuer: GOOGLE_ISS,
      audience,
      // Pin alg — defeats alg=none and RS/HS confusion. jose rejects
      // anything else with JOSEAlgNotAllowed.
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECS,
    })
    payload = result.payload as Record<string, unknown>
  } catch (err) {
    return { ok: false, error: classifyJoseError(err) }
  }

  // Nonce check (replay defense). Only when the caller issued a nonce.
  if (opts.expectedNonce !== undefined) {
    const claimNonce = payload.nonce
    if (typeof claimNonce !== 'string' || !constantTimeEqual(claimNonce, opts.expectedNonce)) {
      return { ok: false, error: 'nonce_mismatch' }
    }
  }

  // Subject from the verified payload only, re-validated through parseSub
  // (enforces the exact google pattern from sub.ts).
  const rawSub = payload.sub
  if (typeof rawSub !== 'string' || rawSub.length === 0) {
    return { ok: false, error: 'bad_subject' }
  }
  let sub: Sub
  try {
    sub = parseSub(`google:${rawSub}`)
  } catch {
    return { ok: false, error: 'bad_subject' }
  }

  const email = typeof payload.email === 'string' ? payload.email : undefined
  const rawVerified = payload.email_verified
  const emailVerified = rawVerified === true || rawVerified === 'true'
  const name = typeof payload.name === 'string' ? payload.name : undefined

  return { ok: true, sub, email, emailVerified, name }
}

/** Map a thrown jose error to the typed taxonomy. Identical structure to
 *  appleAuth.classifyJoseError. */
function classifyJoseError(err: unknown): GoogleVerifyError {
  if (err instanceof joseErrors.JWTExpired) return 'expired'
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') return 'wrong_iss'
    if (err.claim === 'aud') return 'wrong_aud'
    return 'malformed_token'
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'invalid_signature'
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'invalid_signature'
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'unknown_key'
  if (err instanceof joseErrors.JWKSTimeout) return 'jwks_unavailable'
  if (err instanceof joseErrors.JWTInvalid || err instanceof joseErrors.JWSInvalid) {
    return 'malformed_token'
  }
  // A network failure fetching the JWKS surfaces as a generic fetch
  // TypeError — a transient Google-side outage, NOT an auth failure.
  if (err instanceof TypeError) return 'jwks_unavailable'
  return 'unknown_error'
}

// ── Test seams ──────────────────────────────────────────────────────────
const productionGoogleJwks = googleJwks

/** Inject a JWKS resolver (e.g. jose.createLocalJWKSet) for tests. */
export function _setGoogleJwksForTests(set: JWTVerifyGetKey): void {
  googleJwks = set
}

/** Restore the real remote Google JWKS resolver. */
export function _resetGoogleJwksForTests(): void {
  googleJwks = productionGoogleJwks
}
