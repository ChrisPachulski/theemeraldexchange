// Sign in with Apple (SIWA) identity-token verifier.
//
// This module proves IDENTITY ONLY. It answers "is this a genuine,
// unexpired Apple ID token minted for THIS app, and what is the verified
// `apple:<subject>` sub?" — nothing more. It does NOT grant access. A
// valid signed Apple token with no redeemed invite / no member row is
// still rejected downstream by the invite/members allowlist (authZ).
//
// Why jose (not node:crypto): jose@^6.2.3 is already a dependency and is
// the project's JWT/JWE workhorse (session.ts, deviceTokenAuth). It ships
// `createRemoteJWKSet` (JWKS fetch + LRU cache + RS256 verify + kid
// rotation handling) and `jwtVerify` with a stable, code-discriminated
// error taxonomy. Hand-rolling RS256 + JWKS in node:crypto would
// re-implement exactly that audited code — rejected.
//
// Verification (inside verifyAppleIdentityToken):
//   1. Cheap shape pre-check (three dot-separated segments).
//   2. jwtVerify against Apple's JWKS with algorithms pinned to RS256,
//      issuer pinned to https://appleid.apple.com, audience pinned to the
//      configured Apple client id, exp checked with 60s clock tolerance.
//   3. nonce (if expected) compared constant-time.
//   4. sub re-validated through parseSub (apple pattern) — the only sub
//      that leaves this module comes from a signature-verified payload.
//
// Security invariants:
//   - NEVER trust a client-supplied `sub` — it comes only from the
//     verified JWT payload.
//   - algorithms: ['RS256'] pin defends against alg=none and RS/HS
//     confusion (using the public modulus as an HMAC secret).
//   - aud pinned to the configured Apple Services ID / bundle id.
//   - iss pinned to https://appleid.apple.com.
//   - exp enforced with 60s skew only.
//   - JWKS URL is a hardcoded constant (never request-derived) — no SSRF
//     vector; ssrfGuard is not required here.
//   - Fail closed when the Apple client id is unset (never verify against
//     an empty aud).
//   - No secrets logged: failures surface only the typed error code; the
//     raw token, signature, and email are never logged.
//
// Reference: contract §8.1/§8.3 (SIWA subject pattern), §15 (no secrets
//            logged). Design: siwaDesign (bundle siwa-verifier).

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose'
import type { JWTVerifyGetKey } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import { parseSub, type Sub } from './sub.js'

const APPLE_ISS = 'https://appleid.apple.com'
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys')

// 60s clock skew allowance on exp/nbf — matches the device-token verifier
// posture. Apple ID tokens are short-lived; a wider window weakens replay
// defense without buying real-world robustness.
const CLOCK_TOLERANCE_SECS = 60

// Single module-level JWKS set. createRemoteJWKSet keeps its own in-memory
// cache of fetched keys, refetches once on an unknown `kid` (subject to
// cooldownDuration — this is how Apple key rotation is handled
// transparently), and re-fetches after cacheMaxAge. ONE instance per
// process = a shared cache across all logins. Creating it per-request
// would defeat caching, hammer Apple, and lose the anti-abuse cooldown.
let appleJwks: JWTVerifyGetKey = createRemoteJWKSet(APPLE_JWKS_URL, {
  // min interval between refetches on a kid-miss (anti-abuse: a flood of
  // bogus-kid tokens can't become a fetch storm against Apple / an egress
  // DoS).
  cooldownDuration: 30_000,
  // 10 min — Apple rotates keys slowly; bounds staleness.
  cacheMaxAge: 600_000,
  // fail fast if appleid.apple.com is unreachable; bounds worst-case
  // login latency.
  timeoutDuration: 5_000,
})

/** The configured SIWA audience (Apple Services ID / app bundle id) used
 *  as the `aud` the token must carry.
 *
 *  CROSS-BUNDLE GAP: the canonical home for this value is
 *  `env.appleClientId` (added by the env/authz bundle, gated by
 *  `ENABLE_APPLE_SIGN_IN`/`isAppleConfigured()` in production). This
 *  bundle (siwa-verifier) owns only appleAuth.ts, so until env.ts gains
 *  the field this verifier reads `process.env.APPLE_CLIENT_ID` directly.
 *  When env.ts lands the field, switch this accessor to `env.appleClientId`
 *  — the behavior (null when unset → fail closed) is identical. */
function appleAudience(): string | null {
  const raw = process.env.APPLE_CLIENT_ID
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

export type AppleVerifyError =
  | 'not_configured' //   APPLE_CLIENT_ID unset — fail closed, never verify against empty aud
  | 'malformed_token' //  not a JWT / unparseable
  | 'invalid_signature' // sig didn't verify, or an alg-downgrade attempt (alg!=RS256)
  | 'unknown_key' //      kid not present in Apple JWKS (after refetch)
  | 'expired' //          exp in the past (beyond skew)
  | 'wrong_iss' //        iss != https://appleid.apple.com
  | 'wrong_aud' //        aud != configured Apple client id
  | 'nonce_mismatch' //   expected nonce absent or != claim
  | 'bad_subject' //      sub claim missing / fails parseSub apple pattern
  | 'jwks_unavailable' // network/timeout fetching Apple keys (our problem → 5xx)
  | 'unknown_error'

export type AppleVerifyResult =
  | { ok: true; sub: Sub; email?: string; emailVerified?: boolean }
  | { ok: false; error: AppleVerifyError }

/**
 * Verify an Apple ID token (the `id_token` / `identityToken` returned by
 * Sign in with Apple) and return the signature-verified `apple:<subject>`
 * sub, or a typed error.
 *
 * Never throws — every failure is classified into AppleVerifyError so the
 * route can choose an HTTP status (all are 4xx auth failures EXCEPT
 * `jwks_unavailable`, which is a transient Apple-side outage and must
 * surface as 5xx so it is not blamed on the user).
 *
 * @param idToken  the raw Apple ID token (a compact JWS).
 * @param opts.expectedNonce  if provided, `payload.nonce` must be present
 *        and equal (constant-time). The CALLER owns nonce hashing policy
 *        (Apple stores SHA-256 of the native-flow nonce; the web flow may
 *        carry the raw nonce) — pass whichever value should match the
 *        claim verbatim.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  opts: { expectedNonce?: string } = {},
): Promise<AppleVerifyResult> {
  // Fail closed if the audience is unconfigured — verifying against an
  // empty/missing aud would accept tokens minted for any Apple client.
  const audience = appleAudience()
  if (!audience) return { ok: false, error: 'not_configured' }

  // Cheap structural pre-check before any crypto: a compact JWS is three
  // non-empty dot-separated segments. Rejects obvious garbage early.
  if (
    typeof idToken !== 'string' ||
    idToken.length === 0 ||
    idToken.split('.').length !== 3
  ) {
    return { ok: false, error: 'malformed_token' }
  }

  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(idToken, appleJwks, {
      issuer: APPLE_ISS,
      audience,
      // MANDATORY: pin the alg so an attacker cannot downgrade to `none`
      // or pull off an HS/RS confusion (HS256 with the public modulus as
      // the "secret"). jose rejects anything not in this list with
      // JOSEAlgNotAllowed.
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECS,
    })
    payload = result.payload as Record<string, unknown>
  } catch (err) {
    return { ok: false, error: classifyJoseError(err) }
  }

  // Nonce check (replay defense). Only enforced when the caller issued a
  // nonce. Constant-time compare over equal-length buffers; a length
  // mismatch or a missing/non-string claim is a mismatch.
  if (opts.expectedNonce !== undefined) {
    const claimNonce = payload.nonce
    if (typeof claimNonce !== 'string' || !constantTimeEqual(claimNonce, opts.expectedNonce)) {
      return { ok: false, error: 'nonce_mismatch' }
    }
  }

  // Subject: taken ONLY from the verified payload, re-validated through
  // parseSub (which enforces the exact apple pattern from sub.ts). A
  // forged-but-signed token with a malformed sub is rejected here.
  const rawSub = payload.sub
  if (typeof rawSub !== 'string' || rawSub.length === 0) {
    return { ok: false, error: 'bad_subject' }
  }
  let sub: Sub
  try {
    sub = parseSub(`apple:${rawSub}`)
  } catch {
    return { ok: false, error: 'bad_subject' }
  }

  // email / email_verified are surfaced (Apple only returns email on the
  // FIRST authorization). email_verified arrives as a bool OR the string
  // 'true' depending on the flow.
  const email = typeof payload.email === 'string' ? payload.email : undefined
  const rawVerified = payload.email_verified
  const emailVerified = rawVerified === true || rawVerified === 'true'

  return { ok: true, sub, email, emailVerified }
}

/** Map a thrown jose error to the typed taxonomy. Uses `instanceof` on
 *  jose's exported error classes (stable across the major) plus the
 *  `claim` discriminator on JWTClaimValidationFailed. */
function classifyJoseError(err: unknown): AppleVerifyError {
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
  // TypeError (not a jose subclass) — classify it as a transient
  // Apple-side outage, NOT an auth failure, so the route returns 5xx.
  if (err instanceof TypeError) return 'jwks_unavailable'
  return 'unknown_error'
}

/** Constant-time string compare. Returns false on length mismatch without
 *  leaking the comparison via timingSafeEqual's equal-length requirement. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// ── Test seams ──────────────────────────────────────────────────────────
// Allow the unit tests to inject a local (in-memory) JWKS resolver built
// from a test keypair so verification is deterministic and never touches
// appleid.apple.com. NOT exported for production use.

const productionAppleJwks = appleJwks

/** Inject a JWKS resolver (e.g. jose.createLocalJWKSet) for tests. */
export function _setAppleJwksForTests(set: JWTVerifyGetKey): void {
  appleJwks = set
}

/** Restore the real remote Apple JWKS resolver. */
export function _resetAppleJwksForTests(): void {
  appleJwks = productionAppleJwks
}
