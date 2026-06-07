import { describe, it, expect, vi, beforeEach } from 'vitest'

// Real STREAM_TOKEN_SECRET so the canonical Rust signer/verifier round-trips;
// the media token reuses the IPTV stream-token machinery verbatim.
vi.mock('../env.js', () => ({
  env: {
    streamTokenSecret: 'media-test-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionSecret: 'session-fallback-secret-bbbbbbbbbbbbbbbbbbbb',
    MEDIA_STREAM_TOKEN_TTL_SECS: 21_600,
  },
}))

import {
  signMediaToken,
  verifyMediaToken,
  mediaResourceId,
  mediaSessionResourceId,
  MEDIA_DIRECT_KIND,
  MEDIA_HLS_KIND,
} from './mediaStreamToken.js'

describe('mediaStreamToken', () => {
  beforeEach(() => {
    // verifyMediaToken consults the replay cache; fresh jti per sign() keeps
    // round-trips independent, but clear timers between tests for hygiene.
    vi.clearAllMocks()
  })

  it('round-trips a direct-play (vod) token bound to a title', () => {
    const rid = mediaResourceId('movie', 123)
    const token = signMediaToken({ sub: 'plex:42', rid, kind: MEDIA_DIRECT_KIND })
    const v = verifyMediaToken(token, { kinds: [MEDIA_DIRECT_KIND], rid })
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.sub).toBe('plex:42')
      expect(v.rid).toBe('media:movie:123')
    }
  })

  it('round-trips an HLS (remux) session token', () => {
    const rid = mediaSessionResourceId('sess-xyz')
    const token = signMediaToken({ sub: 'plex:7', rid, kind: MEDIA_HLS_KIND })
    const v = verifyMediaToken(token, { kinds: [MEDIA_HLS_KIND], rid })
    expect(v.ok).toBe(true)
  })

  it('rejects a token whose rid does not match the requested resource', () => {
    const token = signMediaToken({
      sub: 'plex:42',
      rid: mediaResourceId('movie', 1),
      kind: MEDIA_DIRECT_KIND,
    })
    const v = verifyMediaToken(token, {
      kinds: [MEDIA_DIRECT_KIND],
      rid: mediaResourceId('movie', 2),
    })
    expect(v).toEqual({ ok: false, error: 'token_mismatch' })
  })

  it('rejects a token of the wrong kind', () => {
    const rid = mediaResourceId('movie', 1)
    const token = signMediaToken({ sub: 'plex:42', rid, kind: MEDIA_DIRECT_KIND })
    const v = verifyMediaToken(token, { kinds: [MEDIA_HLS_KIND], rid })
    expect(v).toEqual({ ok: false, error: 'token_kind' })
  })

  it('rejects garbage', () => {
    const v = verifyMediaToken('not-a-token')
    expect(v).toEqual({ ok: false, error: 'invalid_token' })
  })
})
