import { describe, it, expect } from 'vitest'
import { signStreamToken, verifyStreamToken } from './iptvStreamToken.js'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('iptv stream token', () => {
  it('round-trips a live token within TTL', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live',
      resourceId: '10',
      sub: 'plex:u',
      ttlSecs: 60,
    })
    const claims = verifyStreamToken(SECRET, token)
    expect(claims.kind).toBe('live')
    expect(claims.resourceId).toBe('10')
    expect(claims.sub).toBe('plex:u')
  })

  it('rejects expired tokens', () => {
    const token = signStreamToken(SECRET, {
      kind: 'vod',
      resourceId: '20',
      sub: 's',
      ttlSecs: -10,
    })
    expect(() => verifyStreamToken(SECRET, token)).toThrow(/expired|invalid/i)
  })

  it('rejects tampered signature', () => {
    const token = signStreamToken(SECRET, {
      kind: 'live',
      resourceId: '10',
      sub: 's',
      ttlSecs: 60,
    })
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
    expect(() => verifyStreamToken(SECRET, tampered)).toThrow(/invalid/i)
  })

  it('binds segment proxy URLs (kind="segment", resourceId=upstream URL)', () => {
    const t = signStreamToken(SECRET, {
      kind: 'segment',
      resourceId: 'https://x/y.ts',
      sub: 's',
      ttlSecs: 60,
    })
    expect(verifyStreamToken(SECRET, t).resourceId).toBe('https://x/y.ts')
  })
})
