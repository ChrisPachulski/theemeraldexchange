// session.ts is the bedrock — every other auth check is a thin wrapper
// over verifySession. These tests exist mostly so a future "let me just
// switch jose for jsonwebtoken" or "let me bump the alg" doesn't
// silently change the cookie wire format and fail open / fail closed.

import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { createSession, verifySession } from './session.js'
import type { Session } from './session.js'

const valid: Session = { sub: '42', username: 'someone', role: 'user' }

describe('session', () => {
  it('round-trips a valid session', async () => {
    const token = await createSession(valid)
    const out = await verifySession(token)
    expect(out).toEqual(valid)
  })

  it('rejects a token signed with the wrong secret', async () => {
    const otherSecret = new TextEncoder().encode('a-different-secret-thats-also-32-bytes-long')
    const forged = await new SignJWT({ ...valid })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherSecret)
    expect(await verifySession(forged)).toBeNull()
  })

  it('rejects an expired token', async () => {
    // Build a token that expired 60s ago. The current alg-and-secret are
    // correct; only the exp claim invalidates it.
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET!)
    const expired = await new SignJWT({ ...valid })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret)
    expect(await verifySession(expired)).toBeNull()
  })

  it('rejects garbage strings', async () => {
    expect(await verifySession('not-a-jwt')).toBeNull()
    expect(await verifySession('')).toBeNull()
    expect(await verifySession('a.b.c')).toBeNull()
  })

  it('rejects a token missing required claims', async () => {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET!)
    const partial = await new SignJWT({ sub: '42' /* no username, no role */ })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret)
    expect(await verifySession(partial)).toBeNull()
  })

  it('rejects a token with an unknown role', async () => {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET!)
    const bogus = await new SignJWT({ ...valid, role: 'superadmin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret)
    expect(await verifySession(bogus)).toBeNull()
  })
})
