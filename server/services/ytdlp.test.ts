import { describe, it, expect } from 'vitest'
import { isValidYouTubeId } from './ytdlp.js'

// The id is interpolated into a youtube.com URL and passed to yt-dlp; the strict
// 11-char allowlist is what stops a hostile `key` query param from injecting
// extra args or a different URL. Lock it down.
describe('isValidYouTubeId', () => {
  it('accepts real 11-char ids (incl. - and _)', () => {
    expect(isValidYouTubeId('dQw4w9WgXcQ')).toBe(true)
    expect(isValidYouTubeId('a_b-c1D2E3F')).toBe(true)
  })

  it('rejects wrong length, spaces, and injection attempts', () => {
    expect(isValidYouTubeId('')).toBe(false)
    expect(isValidYouTubeId('short')).toBe(false)
    expect(isValidYouTubeId('dQw4w9WgXcQextra')).toBe(false)
    expect(isValidYouTubeId('dQw4w9WgX Q')).toBe(false)
    expect(isValidYouTubeId('../../etc/x')).toBe(false)
    expect(isValidYouTubeId('a&b=c d|rm-rf')).toBe(false)
  })
})
