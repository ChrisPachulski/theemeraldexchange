// MED-18: the request logger must not write token-in-URL bearer tokens
// (stream/segment/playlist/login auth) into stdout. redactRequestSecrets
// scrubs secret-bearing query values from the formatted log line.
import { describe, it, expect } from 'vitest'
import { redactRequestSecrets } from './app.js'

describe('redactRequestSecrets (MED-18)', () => {
  it('redacts the segment token (?u=) but keeps the path', () => {
    const line = '<-- GET /api/iptv/stream/segment?u=eyJhbGciOiJIUzI1NiJ9.SECRET.sig'
    expect(redactRequestSecrets(line)).toBe('<-- GET /api/iptv/stream/segment?u=[redacted]')
  })

  it('redacts the ?t= stream/playlist token', () => {
    const line = '--> GET /api/iptv/stream/live/42.ts?t=TOPSECRET 200 5ms'
    expect(redactRequestSecrets(line)).toBe('--> GET /api/iptv/stream/live/42.ts?t=[redacted] 200 5ms')
  })

  it('redacts a token in a later query position and preserves following params', () => {
    const line = '<-- GET /api/media/stream?rid=media:9&t=ABC.def.ghi&x=1'
    expect(redactRequestSecrets(line)).toBe('<-- GET /api/media/stream?rid=media:9&t=[redacted]&x=1')
  })

  it('redacts rejected auth secrets supplied through legacy query parameters', () => {
    const line =
      '<-- POST /api/auth/plex/check?pinId=987654321&inviteCode=INVITE-SECRET&safe=1'
    expect(redactRequestSecrets(line)).toBe(
      '<-- POST /api/auth/plex/check?pinId=[redacted]&inviteCode=[redacted]&safe=1',
    )
  })

  // 2026-10-16 review item 6: /api/auth/workos/start reads ?invite=, and the
  // WorkOS callback ?code=; both printed in clear.
  it('redacts the invite code and the WorkOS authorization code', () => {
    expect(redactRequestSecrets('<-- GET /api/auth/workos/start?invite=INVITE-SECRET&intent=web')).toBe(
      '<-- GET /api/auth/workos/start?invite=[redacted]&intent=web',
    )
    expect(redactRequestSecrets('<-- GET /api/auth/workos/callback?code=01JAUTHCODE&state=n0nce')).toBe(
      '<-- GET /api/auth/workos/callback?code=[redacted]&state=n0nce',
    )
  })

  it('leaves non-token lines untouched', () => {
    const line = '--> GET /api/health 200 1ms'
    expect(redactRequestSecrets(line)).toBe(line)
  })

  it('does not redact a non-secret param that merely starts with t', () => {
    const line = '<-- GET /api/iptv/epg/grid?type=full'
    expect(redactRequestSecrets(line)).toBe(line)
  })
})
