import { describe, expect, it } from 'vitest'
import { parseTrickplayPlaylist, thumbAt } from './trickplay'

// The transcoder's iframe.m3u8 after the backend proxy tokenised each line.
const PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-I-FRAMES-ONLY',
  '#EXTINF:10.000000,',
  'thumb_00000.ts?t=TOK',
  '#EXTINF:10.000000,',
  'thumb_00001.ts?t=TOK',
  '#EXTINF:5.000000,',
  'thumb_00002.ts?t=TOK',
  '#EXT-X-ENDLIST',
  '',
].join('\n')
const URL_ = 'https://api.test/api/transcode/session/s1/iframe.m3u8?t=TOK'

describe('parseTrickplayPlaylist', () => {
  it('maps each I-frame entry to its JPEG twin and title-time span', () => {
    expect(parseTrickplayPlaylist(PLAYLIST, URL_)).toEqual([
      { startSecs: 0, endSecs: 10, url: 'https://api.test/api/transcode/session/s1/thumb_00000.jpg?t=TOK' },
      { startSecs: 10, endSecs: 20, url: 'https://api.test/api/transcode/session/s1/thumb_00001.jpg?t=TOK' },
      { startSecs: 20, endSecs: 25, url: 'https://api.test/api/transcode/session/s1/thumb_00002.jpg?t=TOK' },
    ])
  })

  it('yields nothing for a non-playlist body', () => {
    expect(parseTrickplayPlaylist('{"error":"no such session"}', URL_)).toEqual([])
  })
})

describe('thumbAt', () => {
  const thumbs = parseTrickplayPlaylist(PLAYLIST, URL_)

  it('picks the thumbnail whose span covers the time', () => {
    expect(thumbAt(thumbs, 0)?.url).toContain('thumb_00000')
    expect(thumbAt(thumbs, 9.9)?.url).toContain('thumb_00000')
    expect(thumbAt(thumbs, 10)?.url).toContain('thumb_00001')
    expect(thumbAt(thumbs, 24)?.url).toContain('thumb_00002')
  })

  it('holds the last thumbnail past the end and has none without thumbnails', () => {
    expect(thumbAt(thumbs, 99)?.url).toContain('thumb_00002')
    expect(thumbAt([], 5)).toBeNull()
  })
})
