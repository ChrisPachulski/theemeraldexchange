// MED-18: the request logger must not write token-in-URL bearer tokens
// (stream/segment/playlist auth) into stdout. redactStreamTokens scrubs the
// `t` / `u` / `token` query values from the formatted log line.
import { describe, it, expect } from 'vitest'
import { redactStreamTokens } from './app.js'

describe('redactStreamTokens (MED-18)', () => {
  it('redacts the segment token (?u=) but keeps the path', () => {
    const line = '<-- GET /api/iptv/stream/segment?u=eyJhbGciOiJIUzI1NiJ9.SECRET.sig'
    expect(redactStreamTokens(line)).toBe('<-- GET /api/iptv/stream/segment?u=[redacted]')
  })

  it('redacts the ?t= stream/playlist token', () => {
    const line = '--> GET /api/iptv/stream/live/42.ts?t=TOPSECRET 200 5ms'
    expect(redactStreamTokens(line)).toBe('--> GET /api/iptv/stream/live/42.ts?t=[redacted] 200 5ms')
  })

  it('redacts a token in a later query position and preserves following params', () => {
    const line = '<-- GET /api/media/stream?rid=media:9&t=ABC.def.ghi&x=1'
    expect(redactStreamTokens(line)).toBe('<-- GET /api/media/stream?rid=media:9&t=[redacted]&x=1')
  })

  it('leaves non-token lines untouched', () => {
    const line = '--> GET /api/health 200 1ms'
    expect(redactStreamTokens(line)).toBe(line)
  })

  it('does not redact a non-secret param that merely starts with t', () => {
    const line = '<-- GET /api/iptv/epg/grid?type=full'
    expect(redactStreamTokens(line)).toBe(line)
  })
})
