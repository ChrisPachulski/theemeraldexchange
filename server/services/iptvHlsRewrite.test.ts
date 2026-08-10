import { describe, it, expect } from 'vitest'
import { parseSegmentOwner, rewriteManifest, segmentOwnerQuery } from './iptvHlsRewrite.js'

describe('rewriteManifest', () => {
  const sign = (url: string) => `signed(${url})`

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
    const out = rewriteManifest(input, 'https://upstream.example/path/movie.m3u8', sign, '/api/iptv/stream/segment')
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
    const out = rewriteManifest(input, 'https://up.example/master.m3u8', sign, '/api/iptv/stream/segment')
    expect(out).toContain('URI="/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Fsubs%2Fen.m3u8)"')
    expect(out).toContain('/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Flevel1.m3u8)')
  })

  it('preserves single-quoted URI attributes', () => {
    const out = rewriteManifest(
      '#EXT-X-MEDIA:TYPE=AUDIO,URI=\'audio/en.m3u8\'',
      'https://up.example/master.m3u8',
      sign,
      '/api/iptv/stream/segment',
    )
    expect(out).toContain('URI=\'/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Faudio%2Fen.m3u8)\'')
  })

  // b5fa8293: the owner tag is what lets /stream/segment heartbeat the grant
  // that an HLS VOD/series playback belongs to.
  it('appends the owner tag to media lines AND URI attributes', () => {
    const out = rewriteManifest(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/en.m3u8"',
        'level1.m3u8',
      ].join('\n'),
      'https://up.example/master.m3u8',
      sign,
      '/api/iptv/stream/segment',
      { kind: 'series', id: 'ep-1' },
    )
    for (const line of out.split('\n').filter((l) => l.includes('/api/iptv/stream/segment'))) {
      expect(line).toContain('&ok=series&oid=ep-1')
    }
    // The URI attribute's closing quote must still come AFTER the tag.
    expect(out).toContain('&ok=series&oid=ep-1"')
  })

  it('emits no owner tag when there is none (untagged live/legacy URLs)', () => {
    const bare = rewriteManifest('seg.ts', 'https://up.example/a.m3u8', sign, '/p')
    expect(bare).not.toContain('ok=')
    expect(bare).toBe(rewriteManifest('seg.ts', 'https://up.example/a.m3u8', sign, '/p', null))
  })
})

describe('segment owner tag', () => {
  it('round-trips through the query string, escaping the id', () => {
    const owner = { kind: 'vod', id: 'a-b_1' } as const
    const params = new URLSearchParams(segmentOwnerQuery(owner).slice(1))
    expect(parseSegmentOwner(params.get('ok') ?? undefined, params.get('oid') ?? undefined)).toEqual(owner)
    expect(segmentOwnerQuery(null)).toBe('')
    expect(segmentOwnerQuery(undefined)).toBe('')
  })

  it('rejects anything that is not a well-formed on-demand grant', () => {
    for (const [kind, id] of [
      [undefined, '20'],
      ['vod', undefined],
      ['vod', ''],
      ['live', '10'], // live/catchup/remux heartbeat on their own routes
      ['catchup', '10'],
      ['remux', '10'],
      ['VOD', '20'], // case-sensitive
      ['vod', '../../etc/passwd'],
      ['vod', "20' OR 1=1"],
      ['vod', '20 21'],
      ['series', 'ep 1'],
    ] as Array<[string | undefined, string | undefined]>) {
      expect(parseSegmentOwner(kind, id), `${kind}/${id}`).toBeNull()
    }
  })
})
