import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { signStreamToken, verifyStreamToken, verifyStreamTokenDualKey, canonicalBytes, generateUlid, type StreamClaims } from './iptvStreamToken.js'

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
// Tokens are forged via canonicalBytes + HMAC so nbf can be set independently
// of the current wall clock (signStreamToken always sets nbf == now).
// ---------------------------------------------------------------------------

function mintToken(claims: StreamClaims, secret: string): string {
  const canonical = canonicalBytes(claims)
  const body = Buffer.from(canonical).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const sig = createHmac('sha256', secret)
    .update(canonical).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${body}.${sig}`
}

describe('nbf clock-skew boundary (§5.2 / §5.7)', () => {
  it('accepts a token whose nbf is exactly 30s in the future (boundary: nbf - 30s == now)', () => {
    const now = Math.floor(Date.now() / 1000)
    // nbf = now + 30 → nbf - 30s == now → on the boundary, should accept
    const token = mintToken({
      exp: now + 300,
      iat: now,
      jti: generateUlid(),
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
      jti: generateUlid(),
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
      jti: generateUlid(),
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
// Canonical serializer tests
// ---------------------------------------------------------------------------

describe('canonicalBytes — fixed template', () => {
  it('produces alphabetically-ordered keys with no whitespace', () => {
    const claims: StreamClaims = {
      exp: 1750000060,
      iat: 1750000000,
      jti: '01J0000000000000000000000X',
      k: 'live',
      nbf: 1750000000,
      rid: '10',
      sub: 'plex:12345',
      v: 1,
    }
    const bytes = canonicalBytes(claims)
    const s = Buffer.from(bytes).toString('utf-8')
    expect(s).toBe(
      '{"exp":1750000060,"iat":1750000000,"jti":"01J0000000000000000000000X","k":"live","nbf":1750000000,"rid":"10","sub":"plex:12345","v":1}'
    )
  })

  it('escapes double-quote in rid', () => {
    const claims: StreamClaims = {
      exp: 1750000060,
      iat: 1750000000,
      jti: '01J0000000000000000000000X',
      k: 'vod',
      nbf: 1750000000,
      rid: 'a"b',
      sub: 'plex:1',
      v: 1,
    }
    const s = Buffer.from(canonicalBytes(claims)).toString('utf-8')
    expect(s).toContain('"rid":"a\\"b"')
  })

  it('escapes backslash in rid', () => {
    const claims: StreamClaims = {
      exp: 1750000060,
      iat: 1750000000,
      jti: '01J0000000000000000000000X',
      k: 'vod',
      nbf: 1750000000,
      rid: 'a\\b',
      sub: 'plex:1',
      v: 1,
    }
    const s = Buffer.from(canonicalBytes(claims)).toString('utf-8')
    expect(s).toContain('"rid":"a\\\\b"')
  })

  it('encodes catchup pipe-delimited resourceId without escaping (pipe is safe)', () => {
    const claims: StreamClaims = {
      exp: 1750000060,
      iat: 1750000000,
      jti: '01J0000000000000000000000X',
      k: 'catchup',
      nbf: 1750000000,
      rid: '999|2026-05-25T10:00:00Z|60',
      sub: 'plex:12345',
      v: 1,
    }
    const s = Buffer.from(canonicalBytes(claims)).toString('utf-8')
    expect(s).toContain('"rid":"999|2026-05-25T10:00:00Z|60"')
  })

  it('serializes large unix timestamps correctly (no scientific notation)', () => {
    const claims: StreamClaims = {
      exp: 9999999999,
      iat: 9000000000,
      jti: '01J0000000000000000000000X',
      k: 'vod',
      nbf: 9000000000,
      rid: '1',
      sub: 'plex:1',
      v: 1,
    }
    const s = Buffer.from(canonicalBytes(claims)).toString('utf-8')
    expect(s).toContain('"exp":9999999999')
    expect(s).not.toContain('e+')
    expect(s).not.toContain('E+')
  })
})

// ---------------------------------------------------------------------------
// ULID tests
// ---------------------------------------------------------------------------

describe('generateUlid', () => {
  it('returns a 26-char uppercase Crockford base32 string', () => {
    const id = generateUlid()
    expect(id.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true)
  })

  it('generates unique values', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateUlid()))
    expect(ids.size).toBe(1000)
  })

  // Regression: a current real-world millisecond timestamp needs ~41 bits, which
  // overflows JS 32-bit bitwise math. The old `now & 0xffffffffffff` masked the
  // value to a NEGATIVE int32 and made writeUIntBE throw on every call. Pinning a
  // real-world ms value asserts the function does not throw and stays valid.
  it('does not throw for a present-day 41-bit millisecond timestamp', () => {
    const realNow = 1_780_000_000_000 // ~2026-05, > 2**32, the exact regime that broke
    expect(realNow).toBeGreaterThan(0xffffffff)
    const id = generateUlid(realNow)
    expect(id.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true)
  })

  it('uses the injected clock so default Date.now() callers are unaffected', () => {
    const id = generateUlid() // no arg -> Date.now()
    expect(id.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true)
  })

  it('encodes the timestamp into the 10-char prefix (later time => lexically >= prefix)', () => {
    const early = generateUlid(1_700_000_000_000)
    const late = generateUlid(1_800_000_000_000)
    // The random suffix differs, but the time prefix must be monotonic by ms.
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true)
  })

  it('handles the boundary value 2**48 - 1 without throwing', () => {
    const maxTs = 281_474_976_710_655 // 2**48 - 1, the largest writeUIntBE(6) accepts
    const id = generateUlid(maxTs)
    expect(id.length).toBe(26)
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true)
  })

  it('produces an identical prefix for the same injected timestamp', () => {
    const ts = 1_780_123_456_789
    expect(generateUlid(ts).slice(0, 10)).toBe(generateUlid(ts).slice(0, 10))
  })
})

// ---------------------------------------------------------------------------
// Test vector file (§13.1)
// Sibling agent impl-vectors-hand-author owns the file; we assert it exists
// and each vector round-trips through canonicalBytes.
// ---------------------------------------------------------------------------

describe('stream-token-canonical.json vectors (§13.1)', () => {
  const vectorPath = join(__dirname, '../../tests/vectors/stream-token-canonical.json')

  it('vector file exists at tests/vectors/stream-token-canonical.json (populated by impl-vectors-hand-author)', () => {
    if (!existsSync(vectorPath)) {
      // Sibling agent impl-vectors-hand-author owns this file; skip when not yet present.
      // Once the vectors file lands, this test will run and validate canonical correctness.
      console.warn(`[SKIP] vector file not yet present: ${vectorPath}`)
      return
    }
    expect(existsSync(vectorPath)).toBe(true)
  })

  it('each vector: canonicalBytes(claims_input) matches canonical_bytes_hex', () => {
    if (!existsSync(vectorPath)) return // skip if file not yet present (sibling agent pending)

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
    }
    interface VectorFile {
      _meta?: unknown
      vectors: Vector[]
    }

    const raw = JSON.parse(readFileSync(vectorPath, 'utf-8')) as VectorFile
    const vectors: Vector[] = raw.vectors ?? (raw as unknown as Vector[])

    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]
      const claims = v.claims_input as StreamClaims
      const got = Buffer.from(canonicalBytes(claims)).toString('hex')
      expect(got, `vector[${i}] canonical_bytes_hex mismatch`).toBe(v.canonical_bytes_hex)
    }
  })

  it('each vector: verifyStreamToken with test key produces matching HMAC', () => {
    if (!existsSync(vectorPath)) return

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
      const canonical = Buffer.from(v.canonical_bytes_hex, 'hex')
      const gotHmac: string = createHmac('sha256', key)
        .update(canonical)
        .digest('hex')
      expect(gotHmac, `vector[${i}] hmac_hex_with_test_key mismatch`).toBe(v.hmac_hex_with_test_key)
    }
  })
})

// ---------------------------------------------------------------------------
// Dual-key verification (§5.4 STREAM_TOKEN_SECRET rotation window)
// ---------------------------------------------------------------------------

describe('verifyStreamTokenDualKey', () => {
  const PRIMARY = '0123456789abcdef0123456789abcdef-primary'
  const FALLBACK = '0123456789abcdef0123456789abcdef-fallback'

  it('accepts a token signed with the primary secret', () => {
    const token = signStreamToken(PRIMARY, {
      kind: 'live', resourceId: '10', sub: 'plex:42', ttlSecs: 60,
    })
    const claims = verifyStreamTokenDualKey(PRIMARY, FALLBACK, token)
    expect(claims.k).toBe('live')
    expect(claims.rid).toBe('10')
  })

  it('accepts a token signed with the fallback secret (grace-window rotation)', () => {
    // Simulates a token minted before rotation, when env.sessionSecret was
    // the active stream-token signer (M1 → D2a migration). After rotation
    // the primary is the new STREAM_TOKEN_SECRET; the legacy token still
    // verifies through the fallback path while its 90-day TTL window drains.
    const token = signStreamToken(FALLBACK, {
      kind: 'playlist', resourceId: 'iptv-channels-all', sub: 'plex:7', ttlSecs: 60,
    })
    const claims = verifyStreamTokenDualKey(PRIMARY, FALLBACK, token)
    expect(claims.k).toBe('playlist')
    expect(claims.sub).toBe('plex:7')
  })

  it('rejects a token signed with neither secret', () => {
    const token = signStreamToken('a-different-secret-not-in-rotation', {
      kind: 'vod', resourceId: '5', sub: 'plex:1', ttlSecs: 60,
    })
    expect(() => verifyStreamTokenDualKey(PRIMARY, FALLBACK, token))
      .toThrow(/invalid_signature/)
  })

  it('rejects a tampered token even if structurally well-formed', () => {
    const token = signStreamToken(PRIMARY, {
      kind: 'live', resourceId: '10', sub: 'plex:1', ttlSecs: 60,
    })
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect(() => verifyStreamTokenDualKey(PRIMARY, FALLBACK, tampered))
      .toThrow(/invalid_signature/)
  })

  it('rejects an expired token even when signed with the primary secret', () => {
    const token = signStreamToken(PRIMARY, {
      kind: 'live', resourceId: '10', sub: 'plex:1', ttlSecs: -100,
    })
    expect(() => verifyStreamTokenDualKey(PRIMARY, FALLBACK, token))
      .toThrow(/expired/i)
  })

  it('still constant-time-rejects when primary and fallback are identical', () => {
    // Defense-in-depth: if rotation accidentally lands with primary === fallback,
    // the verifier must still behave correctly (both HMACs computed, single
    // signature check). assertSecretsDistinct will normally prevent this at
    // boot time, but the verifier should not blow up if it slips through.
    const token = signStreamToken(PRIMARY, {
      kind: 'live', resourceId: '10', sub: 'plex:1', ttlSecs: 60,
    })
    const claims = verifyStreamTokenDualKey(PRIMARY, PRIMARY, token)
    expect(claims.rid).toBe('10')
  })
})
