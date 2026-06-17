// Unit tests for the Google identity-token verifier (googleAuth.ts).
//
// Same shape as appleAuth.test.ts: an in-test RSA keypair signs fixture
// tokens and a local JWKS resolver is injected via _setGoogleJwksForTests,
// so jwtVerify never touches googleapis.com.
//
// parseSub('google:…') is mocked here ONLY for the google namespace: the
// checked-in N-API addon predates the google: contract addition, so the real
// (addon-backed) parseSub would reject it until the addon is rebuilt at
// deploy. The mock applies the SAME regex the contract defines, so
// bad_subject is still exercised; the contract's own correctness is proven
// by the Rust + Swift sub-namespace suites.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  type JWK,
} from 'jose'
import type { CryptoKey } from 'jose'

vi.mock('./sub.js', async (orig) => {
  const actual = (await orig()) as typeof import('./sub.js')
  return {
    ...actual,
    parseSub: (s: string) => {
      if (s.startsWith('google:')) {
        const id = s.slice('google:'.length)
        if (!/^[0-9]{1,32}$/.test(id)) throw new Error('sub_invalid_format')
        return { provider: 'google' as const, id, raw: s }
      }
      return actual.parseSub(s)
    },
  }
})

const GOOGLE_ISS = 'https://accounts.google.com'
const AUDIENCE = '123456789-abcdef.apps.googleusercontent.com'
const TEST_KID = 'test-kid'
const VALID_GOOGLE_SUBJECT = '104223294318414512345'

import { env } from '../env.js'
import {
  verifyGoogleIdentityToken,
  _setGoogleJwksForTests,
  _resetGoogleJwksForTests,
} from './googleAuth.js'

let privateKey: CryptoKey
let publicJwk: JWK
let otherPrivateKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  publicJwk = await exportJWK(pair.publicKey)
  publicJwk.kid = TEST_KID
  publicJwk.alg = 'RS256'

  const other = await generateKeyPair('RS256', { extractable: true })
  otherPrivateKey = other.privateKey

  _setGoogleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
})

beforeEach(() => {
  // Configure the audience allow-list (read through env at call time).
  ;(env as Record<string, unknown>).googleClientIds = [AUDIENCE]
})

afterEach(() => {
  _setGoogleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
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
  name?: string
  signWith?: CryptoKey
  alg?: string
}

async function makeToken(opts: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {}
  if (opts.nonce !== undefined) claims.nonce = opts.nonce
  if (opts.email !== undefined) claims.email = opts.email
  if (opts.emailVerified !== undefined) claims.email_verified = opts.emailVerified
  if (opts.name !== undefined) claims.name = opts.name

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? TEST_KID })
    .setIssuer(opts.iss ?? GOOGLE_ISS)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? VALID_GOOGLE_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.signWith ?? privateKey)
}

describe('verifyGoogleIdentityToken — happy path', () => {
  it('verifies a well-formed token and returns the google: sub', async () => {
    const token = await makeToken({ email: 'a@example.com', emailVerified: true, name: 'Ada L' })
    const result = await verifyGoogleIdentityToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sub.raw).toBe(`google:${VALID_GOOGLE_SUBJECT}`)
      expect(result.sub.provider).toBe('google')
      expect(result.email).toBe('a@example.com')
      expect(result.emailVerified).toBe(true)
      expect(result.name).toBe('Ada L')
    }
  })

  it("treats email_verified string 'true' as verified", async () => {
    const token = await makeToken({ emailVerified: 'true' })
    const result = await verifyGoogleIdentityToken(token)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.emailVerified).toBe(true)
  })

  it('accepts the bare accounts.google.com issuer form', async () => {
    const token = await makeToken({ iss: 'accounts.google.com' })
    const result = await verifyGoogleIdentityToken(token)
    expect(result.ok).toBe(true)
  })

  it('accepts a token whose nonce matches the expected nonce', async () => {
    const token = await makeToken({ nonce: 'abc123nonce' })
    const result = await verifyGoogleIdentityToken(token, { expectedNonce: 'abc123nonce' })
    expect(result.ok).toBe(true)
  })

  it('accepts any audience in the configured allow-list (multi-client: iOS + web)', async () => {
    ;(env as Record<string, unknown>).googleClientIds = ['web.example', AUDIENCE]
    const token = await makeToken({ aud: AUDIENCE })
    const result = await verifyGoogleIdentityToken(token)
    expect(result.ok).toBe(true)
  })
})

describe('verifyGoogleIdentityToken — rejections', () => {
  it('fails closed when no client id is configured (not_configured)', async () => {
    ;(env as Record<string, unknown>).googleClientIds = []
    const token = await makeToken()
    const result = await verifyGoogleIdentityToken(token)
    expect(result).toEqual({ ok: false, error: 'not_configured' })
  })

  it('rejects an expired token', async () => {
    const token = await makeToken({ expiresIn: '-10m' })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'expired' })
  })

  it('rejects a token minted for a different audience', async () => {
    const token = await makeToken({ aud: 'com.someone.else' })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'wrong_aud' })
  })

  it('rejects a token with the wrong issuer', async () => {
    const token = await makeToken({ iss: 'https://evil.example.com' })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'wrong_iss' })
  })

  it('rejects a token signed by a different key', async () => {
    const token = await makeToken({ signWith: otherPrivateKey })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'invalid_signature' })
  })

  it('rejects a token whose kid is not in the JWKS', async () => {
    const token = await makeToken({ kid: 'unknown-kid' })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'unknown_key' })
  })

  it('rejects when an expected nonce is absent from the token', async () => {
    const token = await makeToken()
    expect(await verifyGoogleIdentityToken(token, { expectedNonce: 'x' })).toEqual({
      ok: false,
      error: 'nonce_mismatch',
    })
  })

  it('rejects a nonce that does not match', async () => {
    const token = await makeToken({ nonce: 'real' })
    expect(await verifyGoogleIdentityToken(token, { expectedNonce: 'fake' })).toEqual({
      ok: false,
      error: 'nonce_mismatch',
    })
  })

  it('rejects a structurally malformed token', async () => {
    expect(await verifyGoogleIdentityToken('not-a-jwt')).toEqual({
      ok: false,
      error: 'malformed_token',
    })
  })

  it('rejects a token whose sub fails the google pattern (bad_subject)', async () => {
    const token = await makeToken({ sub: 'not-numeric!' })
    expect(await verifyGoogleIdentityToken(token)).toEqual({ ok: false, error: 'bad_subject' })
  })
})

describe('test seam', () => {
  it('_resetGoogleJwksForTests restores the production resolver without throwing', () => {
    expect(() => _resetGoogleJwksForTests()).not.toThrow()
    _setGoogleJwksForTests(createLocalJWKSet({ keys: [publicJwk] }))
  })
})
