import { describe, it, expect } from 'vitest'
import { rewriteManifest } from './iptvHlsRewrite.js'

describe('rewriteManifest', () => {
  const sign = (url: string) => `signed(${url})`
  // Allow everything by default for the rewrite-shape tests; the containment
  // test below supplies a real host predicate.
  const allowAll = () => true

  it('rewrites relative + absolute media URIs', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:6.0,',
      'seg-001.ts',
      '#EXTINF:6.0,',
      'https://cdn.example/foo/seg-002.ts',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const out = rewriteManifest(input, 'https://upstream.example/path/movie.m3u8', sign, '/api/iptv/stream/segment', allowAll)
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fupstream.example%2Fpath%2Fseg-001.ts)')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fcdn.example%2Ffoo%2Fseg-002.ts)')
  })

  it('rewrites EXT-X-MEDIA URI attributes (subtitles, alt audio)', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",DEFAULT=YES,FORCED=NO,URI="subs/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'level1.m3u8',
    ].join('\n')
    const out = rewriteManifest(input, 'https://up.example/master.m3u8', sign, '/api/iptv/stream/segment', allowAll)
    expect(out).toContain('URI="/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Fsubs%2Fen.m3u8)"')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Flevel1.m3u8)')
  })

  it('preserves single-quoted URI attributes', () => {
    const out = rewriteManifest(
      '#EXT-X-MEDIA:TYPE=AUDIO,URI=\'audio/en.m3u8\'',
      'https://up.example/master.m3u8',
      sign,
      '/api/iptv/stream/segment',
      allowAll,
    )
    expect(out).toContain('URI=\'/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Faudio%2Fen.m3u8)\'')
  })

  it('does NOT sign off-host absolute URLs when isHostAllowed rejects them (SSRF containment)', () => {
    // Only the panel host is allowed. A provider-controlled manifest line that
    // points at an internal / off-host absolute URL must be passed through
    // unrewritten so it is never signed into a proxy rid.
    const onlyPanel = (resolved: string) => {
      try {
        return new URL(resolved).host === 'panel'
      } catch {
        return false
      }
    }
    const input = [
      '#EXTM3U',
      '#EXTINF:6.0,',
      'seg-001.ts',
      '#EXTINF:6.0,',
      'http://169.254.169.254/latest/meta-data/seg.ts',
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="https://evil.example/audio/en.m3u8"',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const out = rewriteManifest(input, 'https://panel/path/movie.m3u8', sign, '/api/iptv/stream/segment', onlyPanel)

    // On-host relative segment is signed.
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fpanel%2Fpath%2Fseg-001.ts)')
    // Off-host absolute media line is left untouched, never signed.
    expect(out).toContain('http://169.254.169.254/latest/meta-data/seg.ts')
    expect(out).not.toContain('signed(http%3A%2F%2F169.254.169.254')
    // Off-host URI attribute is preserved verbatim, never signed.
    expect(out).toContain('URI="https://evil.example/audio/en.m3u8"')
    expect(out).not.toContain('signed(https%3A%2F%2Fevil.example')
  })
})
