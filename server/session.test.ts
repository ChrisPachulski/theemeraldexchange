// session.ts is the bedrock — every other auth check is a thin wrapper
// over verifySession. These tests exist mostly so a future "let me just
// switch jose for jsonwebtoken" or "let me bump the alg" doesn't
// silently change the cookie wire format and fail open / fail closed.
//
// IMPORTANT: forged tokens are minted as JWE (the same shape as real
// session cookies) so a negative test failing proves verifySession's
// claim/exp/role check is broken — not just that arbitrary garbage is
// rejected by jose's decoder.

import { describe, it, expect } from 'vitest'
import { EncryptJWT, SignJWT } from 'jose'
import { createHash, randomUUID } from 'node:crypto'
import { createSession, verifySession, authModeFromSession } from './session.js'
import type { Session } from './session.js'

const valid: Session = { sub: '42', username: 'someone', role: 'user', auth_mode: 'plex' }

// Replicate session.ts's key derivation: SHA-256(SESSION_SECRET).
// Mirrors the production code; if the derivation changes there, this
// must change here too — and these tests catch divergence by failing
// the round-trip case below.
function key(): Buffer {
  return createHash('sha256').update(process.env.SESSION_SECRET!, 'utf8').digest()
}

async function mintJwe(
  claims: Record<string, unknown>,
  opts: { exp?: string | number; iat?: number } = {},
): Promise<string> {
  const builder = new EncryptJWT(claims).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
  if (opts.iat !== undefined) builder.setIssuedAt(opts.iat)
  else builder.setIssuedAt()
  builder.setExpirationTime(opts.exp ?? '1h')
  return builder.encrypt(key())
}

describe('session — round trip', () => {
  it('round-trips a valid session', async () => {
    const token = await createSession(valid)
    const out = await verifySession(token)
    expect(out).toEqual(valid)
  })

  it('round-trips a session that includes a plexAuthToken', async () => {
    const withToken: Session = { ...valid, plexAuthToken: 'plex-abc-xyz-secret' }
    const token = await createSession(withToken)
    const out = await verifySession(token)
    expect(out).toEqual(withToken)
  })
})

describe('session — token confidentiality', () => {
  it('does not leak the Plex auth token in the raw cookie string', async () => {
    // A jose SignJWT cookie would have this string base64url-encoded in
    // the payload segment — readable by anyone who copies the cookie.
    // With JWE the payload is AES-GCM encrypted, so the secret must not
    // appear anywhere in the wire form.
    const secret = `plex-${randomUUID()}-secret`
    const token = await createSession({ ...valid, plexAuthToken: secret })
    expect(token).not.toContain(secret)
    // Also check Buffer-decoded segments (defense against base64url
    // sneaking the value through in a way `not.toContain` misses).
    for (const segment of token.split('.')) {
      try {
        const decoded = Buffer.from(segment, 'base64url').toString('utf8')
        expect(decoded).not.toContain(secret)
      } catch {
        // non-utf8 segment (the ciphertext) — that's fine.
      }
    }
  })
})

describe('session — auth_mode backward compat', () => {
  it('defaults missing auth_mode to plex (pre-D17 cookies)', async () => {
    // Simulate a cookie issued before D17: no auth_mode field in the payload.
    const token = await mintJwe({ sub: '42', username: 'someone', role: 'user' })
    const out = await verifySession(token)
    expect(out).not.toBeNull()
    expect(out!.auth_mode).toBe('plex')
  })

  it('round-trips auth_mode local', async () => {
    const local: Session = { sub: 'local:99', username: 'localuser', role: 'user', auth_mode: 'local' }
    const token = await createSession(local)
    const out = await verifySession(token)
    expect(out!.auth_mode).toBe('local')
  })

  it('round-trips auth_mode apple', async () => {
    const apple: Session = { sub: 'apple:abc123', username: 'appleuser', role: 'user', auth_mode: 'apple' }
    const token = await createSession(apple)
    const out = await verifySession(token)
    expect(out!.auth_mode).toBe('apple')
  })

  it('defaults unknown auth_mode value to plex (future-compat)', async () => {
    // A token from a future server version with an auth_mode we do not
    // recognize should fall back to 'plex' rather than letting bad data
    // through unchecked.
    const token = await mintJwe({ sub: '42', username: 'someone', role: 'user', auth_mode: 'webauthn' })
    const out = await verifySession(token)
    expect(out!.auth_mode).toBe('plex')
  })
})

describe('session — authModeFromSession', () => {
  it('returns plex for bare (M1) plex ids', () => {
    expect(authModeFromSession({ sub: '12345' })).toBe('plex')
  })

  it('returns plex for plex: prefixed ids', () => {
    expect(authModeFromSession({ sub: 'plex:12345' })).toBe('plex')
  })

  it('returns local for local: prefixed ids', () => {
    expect(authModeFromSession({ sub: 'local:abc' })).toBe('local')
  })

  it('returns apple for apple: prefixed ids', () => {
    expect(authModeFromSession({ sub: 'apple:xyz' })).toBe('apple')
  })
})

describe('session — rejection cases', () => {
  it('rejects garbage strings', async () => {
    expect(await verifySession('not-a-jwt')).toBeNull()
    expect(await verifySession('')).toBeNull()
    expect(await verifySession('a.b.c')).toBeNull()
    expect(await verifySession('a.b.c.d.e')).toBeNull()
  })

  it('rejects a JWE encrypted with the wrong key', async () => {
    const otherKey = createHash('sha256').update('a-different-secret', 'utf8').digest()
    const forged = await new EncryptJWT({ ...valid })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .encrypt(otherKey)
    expect(await verifySession(forged)).toBeNull()
  })

  it('rejects a legacy SignJWT (HS256) token after the JWE migration', async () => {
    // Pre-migration cookies were signed JWTs, not encrypted. After the
    // switch, those must NOT round-trip — sessions are forced to
    // re-auth so the Plex token gets encrypted at rest.
    const legacy = await new SignJWT({ ...valid })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!))
    expect(await verifySession(legacy)).toBeNull()
  })

  it('rejects an expired JWE token', async () => {
    // Encrypted with the right key, claims+role valid, only the exp
    // claim invalidates it. If verifySession stops checking exp, this
    // test fails — which is the whole point.
    const nowSec = Math.floor(Date.now() / 1000)
    const expired = await mintJwe({ ...valid }, { iat: nowSec - 3600, exp: nowSec - 60 })
    expect(await verifySession(expired)).toBeNull()
  })

  it('rejects a JWE missing the username claim', async () => {
    const partial = await mintJwe({ sub: '42', role: 'user' })
    expect(await verifySession(partial)).toBeNull()
  })

  it('rejects a JWE missing the sub claim', async () => {
    // jose's EncryptJWT auto-fills nothing for sub; we just omit it.
    const partial = await mintJwe({ username: 'someone', role: 'user' })
    expect(await verifySession(partial)).toBeNull()
  })

  it('rejects a JWE with an unknown role', async () => {
    const bogus = await mintJwe({ ...valid, role: 'superadmin' })
    expect(await verifySession(bogus)).toBeNull()
  })

  it('rejects a JWE with a non-string sub claim', async () => {
    // Defensive: the type says sub is a string, but jwtDecrypt would
    // accept a number-shaped value if the runtime check is missing.
    const bogus = await mintJwe({ sub: 42, username: 'someone', role: 'user' })
    expect(await verifySession(bogus)).toBeNull()
  })
})
