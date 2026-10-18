import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { signStreamToken, verifyStreamToken, type StreamClaims } from './iptvStreamToken.js'
import { contracts } from './contractsBinding.js'
import { ulid } from './ulid.js'

const SECRET = '0123456789abcdef0123456789abcdef'

// ---------------------------------------------------------------------------
// Round-trip and rejection tests
// ---------------------------------------------------------------------------

describe('iptv stream token — round trip', () => {
  it('round-trips a live token within TTL', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live',
      resourceId: '10',
      sub: 'plex:12345',
      ttlSecs: 60,
    })
    const claims = verifyStreamToken(SECRET, token)
    expect(claims.k).toBe('live')
    expect(claims.rid).toBe('10')
    expect(claims.sub).toBe('plex:12345')
    expect(claims.v).toBe(1)
    expect(typeof claims.jti).toBe('string')
    expect(claims.jti.length).toBe(26)
    expect(typeof claims.iat).toBe('number')
    expect(typeof claims.nbf).toBe('number')
    expect(claims.nbf).toBe(claims.iat)
    expect(claims.exp).toBeGreaterThan(claims.iat)
  })

  it('rejects expired tokens', () => {
    const token = signStreamToken(SECRET, {
      kind: 'vod',
      resourceId: '20',
      sub: 'plex:1',
      ttlSecs: -100,
    })
    expect(() => verifyStreamToken(SECRET, token)).toThrow(/expired/i)
  })

  it('rejects tampered signature', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live',
      resourceId: '10',
      sub: 'plex:1',
      ttlSecs: 60,
    })
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect(() => verifyStreamToken(SECRET, tampered)).toThrow(/invalid/i)
  })

  it('rejects wrong secret', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live',
      resourceId: '10',
      sub: 'plex:1',
      ttlSecs: 60,
    })
    expect(() => verifyStreamToken('wrongsecretwrongsecretwrongsecret', token)).toThrow(/invalid/i)
  })

  it('binds segment proxy URLs (kind="segment", resourceId=upstream URL)', () => {
    const t = signStreamToken(SECRET, {
      kind: 'segment',
      resourceId: 'https://x/y.ts',
      sub: 'plex:1',
      ttlSecs: 60,
    })
    expect(verifyStreamToken(SECRET, t).rid).toBe('https://x/y.ts')
  })

  it('round-trips the M6-reserved "recording" kind (§5.3 — verifiers must accept it)', () => {
    // 'recording' is minted by no current path, but the verifier surface
    // (TS union + Rust enum + vector file) must already accept it so M6
    // DVR work doesn't need a cross-language enum amendment.
    const token = signStreamToken(SECRET, {
      kind: 'recording',
      resourceId: 'rec-2026-05-25-ch101',
      sub: 'plex:12345',
      ttlSecs: 60,
    })
    const claims = verifyStreamToken(SECRET, token)
    expect(claims.k).toBe('recording')
    expect(claims.rid).toBe('rec-2026-05-25-ch101')
  })

  it('rejects token with missing v field', () => {
    // Forge a token with no v claim by signing a hand-rolled payload
    const payload = Buffer.from(JSON.stringify({ k: 'live', rid: '10', sub: 'plex:1', exp: Math.floor(Date.now()/1000) + 60 }))
    const body = payload.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const sig = createHmac('sha256', SECRET).update(payload).digest()
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const token = `${body}.${sig}`
    expect(() => verifyStreamToken(SECRET, token)).toThrow(/version/i)
  })
})

// ---------------------------------------------------------------------------
// nbf boundary cases (§5.2 / §5.7)
// Contract: accept if  nbf - 30s  <=  now  <=  exp + 5s
// Verified here at the exact boundary edges to catch off-by-one regressions.
// Tokens are signed through the binding directly so nbf can be set
// independently of the current wall clock (signStreamToken sets nbf == now).
// ---------------------------------------------------------------------------

function mintToken(claims: StreamClaims, secret: string): string {
  return contracts.streamTokenSign(Buffer.from(secret, 'utf-8'), claims)
}

describe('nbf clock-skew boundary (§5.2 / §5.7)', () => {
  it('accepts a token whose nbf is exactly 30s in the future (boundary: nbf - 30s == now)', () => {
    const now = Math.floor(Date.now() / 1000)
    // nbf = now + 30 → nbf - 30s == now → on the boundary, should accept
    const token = mintToken({
      exp: now + 300,
      iat: now,
      jti: ulid(),
      k: 'live',
      nbf: now + 30,
      rid: '1',
      sub: 'plex:1',
      v: 1,
    }, SECRET)
    expect(() => verifyStreamToken(SECRET, token)).not.toThrow()
  })

  it('rejects a token whose nbf is 31s in the future (boundary: nbf - 30s == now + 1)', () => {
    const now = Math.floor(Date.now() / 1000)
    // nbf = now + 31 → nbf - 30s == now + 1 → now < nbf - 30s → reject
    const token = mintToken({
      exp: now + 300,
      iat: now,
      jti: ulid(),
      k: 'live',
      nbf: now + 31,
      rid: '1',
      sub: 'plex:1',
      v: 1,
    }, SECRET)
    expect(() => verifyStreamToken(SECRET, token)).toThrow(/not_yet_valid/)
  })

  it('accepts a token whose nbf is well in the past', () => {
    const now = Math.floor(Date.now() / 1000)
    const token = mintToken({
      exp: now + 300,
      iat: now - 60,
      jti: ulid(),
      k: 'vod',
      nbf: now - 60,
      rid: '2',
      sub: 'plex:2',
      v: 1,
    }, SECRET)
    expect(() => verifyStreamToken(SECRET, token)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Test vector file (§13.1)
// The vector file is the cross-language interop oracle (the Rust harness
// runs the same file) — a missing file is a hard failure, never a skip.
// ---------------------------------------------------------------------------

describe('stream-token-canonical.json vectors (§13.1)', () => {
  const vectorPath = join(__dirname, '../../tests/vectors/stream-token-canonical.json')

  it('vector file exists at tests/vectors/stream-token-canonical.json', () => {
    expect(existsSync(vectorPath), `vector file missing: ${vectorPath}`).toBe(true)
  })

  it('each vector: the napi binding signs to the pinned canonical bytes + HMAC (node:crypto as independent oracle)', () => {
    interface Vector {
      claims_input: {
        exp: number
        iat: number
        jti: string
        k: string
        nbf: number
        rid: string
        sub: string
        v: 1
      }
      canonical_bytes_hex: string
      hmac_hex_with_test_key: string
      test_key?: string
    }
    interface VectorFile {
      _meta?: unknown
      test_key?: string
      vectors: Vector[]
    }

    const raw = JSON.parse(readFileSync(vectorPath, 'utf-8')) as VectorFile
    const testKey: string = raw.test_key ?? '0123456789abcdef0123456789abcdef'
    const vectors: Vector[] = raw.vectors ?? (raw as unknown as Vector[])

    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]
      const key = v.test_key ?? testKey

      // PRIMARY assertion: the production signer (the Rust crate via the
      // napi binding — the exact function signStreamToken delegates to)
      // reproduces the pinned canonical bytes AND the pinned HMAC. The
      // vector exp values are in the past, so the time-window-enforcing
      // verifyStreamToken wrapper cannot be used here; streamTokenSign is
      // the binding surface that exercises canonicalization + HMAC.
      const token = contracts.streamTokenSign(Buffer.from(key, 'utf-8'), v.claims_input)
      const [payloadB64, sigB64] = token.split('.')
      expect(
        Buffer.from(payloadB64, 'base64url').toString('hex'),
        `vector[${i}] binding canonical bytes mismatch`,
      ).toBe(v.canonical_bytes_hex)
      expect(
        Buffer.from(sigB64, 'base64url').toString('hex'),
        `vector[${i}] binding HMAC mismatch`,
      ).toBe(v.hmac_hex_with_test_key)

      // Round-trip: the binding's verifier (signature check, no time
      // window) accepts its own output and returns the original claims.
      const back = contracts.streamTokenVerify(Buffer.from(key, 'utf-8'), token)
      expect(back.k, `vector[${i}] binding verify kind mismatch`).toBe(v.claims_input.k)
      expect(back.jti, `vector[${i}] binding verify jti mismatch`).toBe(v.claims_input.jti)

      // SECONDARY assertion: independent node:crypto recompute of the HMAC
      // over the pinned canonical bytes — a non-Rust oracle so a bug in the
      // crate cannot self-certify.
      const canonical = Buffer.from(v.canonical_bytes_hex, 'hex')
      const gotHmac: string = createHmac('sha256', key)
        .update(canonical)
        .digest('hex')
      expect(gotHmac, `vector[${i}] hmac_hex_with_test_key mismatch`).toBe(v.hmac_hex_with_test_key)
    }
  })
})
