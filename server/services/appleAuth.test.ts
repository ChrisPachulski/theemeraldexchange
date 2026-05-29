// Unit tests for the SIWA identity-token verifier (appleAuth.ts).
//
// No live network: an in-test RSA keypair signs fixture tokens, and a
// local JWKS resolver (jose.createLocalJWKSet) is injected via the
// _setAppleJwksForTests seam so jwtVerify resolves the test key without
// touching appleid.apple.com. Every case maps to one AppleVerifyError (or
// the happy path).

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from 'jose'
import type { CryptoKey } from 'jose'

const APPLE_ISS = 'https://appleid.apple.com'
const AUDIENCE = 'com.theemeraldexchange.app'
const TEST_KID = 'test-kid'
// A valid apple sub per sub.ts PATTERNS.apple: 6 digits . 32 lowercase hex . 4 digits.
const VALID_APPLE_SUBJECT = '000000.0123456789abcdef0123456789abcdef.0000'

// APPLE_CLIENT_ID must be set BEFORE the module is imported-and-called.
// appleAudience() reads process.env at call time, so setting it here
// (before any test runs) is sufficient. Set it as early as possible.
process.env.APPLE_CLIENT_ID = AUDIENCE

// Imported after the env is set. (verifier reads env lazily, but keep the
// ordering explicit for clarity.)
import {
  verifyAppleIdentityToken,
  _setAppleJwksForTests,
  _resetAppleJwksForTests,
} from './appleAuth.js'

let privateKey: CryptoKey
let publicJwk: JWK
// A second, unrelated keypair used to forge a signature mismatch.
let otherPrivateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  publicJwk = await exportJWK(pair.publicKey)
  publicJwk.kid = TEST_KID
  publicJwk.alg = 'RS256'

  const other = await generateKeyPair('RS256', { extractable: true })
  otherPrivateKey = other.privateKey

  // Inject a local JWKS resolver built from the test public key.
  _setAppleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
})

afterEach(() => {
  // Re-inject the test resolver in case a test swapped it.
  _setAppleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
})

type TokenOpts = {
  iss?: string
  aud?: string
  sub?: string
  kid?: string
  expiresIn?: string
  nonce?: string
  email?: string
  emailVerified?: boolean | string
  signWith?: CryptoKey
  alg?: string
}

async function makeToken(opts: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {}
  if (opts.nonce !== undefined) claims.nonce = opts.nonce
  if (opts.email !== undefined) claims.email = opts.email
  if (opts.emailVerified !== undefined) claims.email_verified = opts.emailVerified

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss ?? APPLE_ISS)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? VALID_APPLE_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.signWith ?? privateKey)
}

describe('verifyAppleIdentityToken — happy path', () => {
  it('verifies a well-formed token and returns the apple: sub', async () => {
    const token = await makeToken({ email: 'a@example.com', emailVerified: true })
    const result = await verifyAppleIdentityToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sub.raw).toBe(`apple:${VALID_APPLE_SUBJECT}`)
      expect(result.sub.provider).toBe('apple')
      expect(result.email).toBe('a@example.com')
      expect(result.emailVerified).toBe(true)
    }
  })

  it("treats email_verified string 'true' as verified", async () => {
    const token = await makeToken({ email: 'b@example.com', emailVerified: 'true' })
    const result = await verifyAppleIdentityToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.emailVerified).toBe(true)
  })

  it('accepts a token whose nonce matches the expected nonce', async () => {
    const token = await makeToken({ nonce: 'abc123nonce' })
    const result = await verifyAppleIdentityToken(token, { expectedNonce: 'abc123nonce' })
    expect(result.ok).toBe(true)
  })
})

describe('verifyAppleIdentityToken — rejections', () => {
  it('rejects an expired token', async () => {
    const token = await makeToken({ expiresIn: '-10m' })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'expired' })
  })

  it('rejects a token minted for a different audience', async () => {
    const token = await makeToken({ aud: 'com.someone.else' })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'wrong_aud' })
  })

  it('rejects a token with the wrong issuer', async () => {
    const token = await makeToken({ iss: 'https://evil.example.com' })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'wrong_iss' })
  })

  it('rejects a token signed by a different key', async () => {
    const token = await makeToken({ signWith: otherPrivateKey })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'invalid_signature' })
  })

  it('rejects a token whose kid is not in the JWKS', async () => {
    const token = await makeToken({ kid: 'unknown-kid' })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'unknown_key' })
  })

  it('rejects when an expected nonce is absent from the token', async () => {
    const token = await makeToken() // no nonce claim
    const result = await verifyAppleIdentityToken(token, { expectedNonce: 'expected' })
    expect(result).toEqual({ ok: false, error: 'nonce_mismatch' })
  })

  it('rejects when the nonce does not match', async () => {
    const token = await makeToken({ nonce: 'actual' })
    const result = await verifyAppleIdentityToken(token, { expectedNonce: 'different' })
    expect(result).toEqual({ ok: false, error: 'nonce_mismatch' })
  })

  it('rejects a signed token whose sub fails the apple pattern', async () => {
    // Uppercase hex violates PATTERNS.apple (lowercase only).
    const token = await makeToken({ sub: '000000.0123456789ABCDEF0123456789abcdef.0000' })
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'bad_subject' })
  })

  it('rejects a garbage (non-JWT) string as malformed', async () => {
    const result = await verifyAppleIdentityToken('not-a-jwt')
    expect(result).toEqual({ ok: false, error: 'malformed_token' })
  })

  it('rejects an empty token as malformed', async () => {
    const result = await verifyAppleIdentityToken('')
    expect(result).toEqual({ ok: false, error: 'malformed_token' })
  })

  it('classifies a JWKS resolver timeout as jwks_unavailable (5xx, not auth failure)', async () => {
    const { errors } = await import('jose')
    _setAppleJwksForTests(async () => {
      throw new errors.JWKSTimeout()
    })
    const token = await makeToken()
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'jwks_unavailable' })
  })

  it('classifies a network fetch failure as jwks_unavailable', async () => {
    _setAppleJwksForTests(async () => {
      throw new TypeError('fetch failed')
    })
    const token = await makeToken()
    const result = await verifyAppleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'jwks_unavailable' })
  })
})

describe('verifyAppleIdentityToken — algorithm pinning (alg-confusion guard)', () => {
  it('rejects an unsigned (alg:none) token', async () => {
    // Hand-build an alg:none token: header.payload. with empty signature.
    const b64u = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url')
    const header = b64u({ alg: 'none', kid: TEST_KID })
    const body = b64u({
      iss: APPLE_ISS,
      aud: AUDIENCE,
      sub: VALID_APPLE_SUBJECT,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
    const noneToken = `${header}.${body}.`
    const result = await verifyAppleIdentityToken(noneToken)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // alg:none → JOSEAlgNotAllowed (or malformed/sig-fail); never ok.
      expect(['invalid_signature', 'malformed_token']).toContain(result.error)
    }
  })

  it('rejects an HS256 token even when the body is otherwise valid', async () => {
    // Sign with HMAC using a secret — an attacker who pinned HS256 with
    // the (public) modulus as the secret must still be rejected because
    // RS256 is the ONLY allowed algorithm.
    const { SignJWT: SignJWT2 } = await import('jose')
    const hmacKey = new TextEncoder().encode('attacker-controlled-secret')
    const token = await new SignJWT2({})
      .setProtectedHeader({ alg: 'HS256', kid: TEST_KID })
      .setIssuer(APPLE_ISS)
      .setAudience(AUDIENCE)
      .setSubject(VALID_APPLE_SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(hmacKey)
    const result = await verifyAppleIdentityToken(token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('invalid_signature')
  })
})

describe('verifyAppleIdentityToken — fail-closed when unconfigured', () => {
  it('returns not_configured when APPLE_CLIENT_ID is unset', async () => {
    const saved = process.env.APPLE_CLIENT_ID
    delete process.env.APPLE_CLIENT_ID
    try {
      const token = await makeToken()
      const result = await verifyAppleIdentityToken(token)
      expect(result).toEqual({ ok: false, error: 'not_configured' })
    } finally {
      process.env.APPLE_CLIENT_ID = saved
    }
  })
})

// Keep the reset seam referenced so it is covered and not dead code.
describe('test seams', () => {
  it('_resetAppleJwksForTests restores a callable resolver', () => {
    expect(() => _resetAppleJwksForTests()).not.toThrow()
    // Re-inject the local set for any subsequent suites.
    _setAppleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
  })
})
