// Unit tests for the ytresolve service layer.
//
// These tests cover:
//   1. buildHlsBundle — the playlist-string builder (the Node twin of the
//      Rust manifest::build_hls function).  All three selection branches:
//      happy-path adaptive pair, missing video, missing audio.
//   2. Cache behaviour of getOrFetchResolved (clock-mocked, no network).
//   3. resolveViaRustBinary error handling when the binary fails.
//
// Network is never touched — the Rust binary is mocked via vi.mock on the
// execFile import.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildHlsBundle, getOrFetchResolved, _evictFromCache } from './ytresolve.js'
import type { YtResolveResult } from './ytresolve.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolved(opts: Partial<YtResolveResult> = {}): YtResolveResult {
  return {
    video_id: 'dQw4w9WgXcQ',
    hls: null,
    progressive: null,
    video: {
      url: 'https://v.googlevideo.com/videofile',
      mime: 'video/mp4; codecs="avc1.640028"',
      height: 1080,
      bitrate: 4_500_000,
    },
    audio: {
      url: 'https://r4.googlevideo.com/audiofile',
      mime: 'audio/mp4; codecs="mp4a.40.2"',
      height: null,
      bitrate: 128_000,
    },
    duration_secs: 212,
    ...opts,
  }
}

// ---------------------------------------------------------------------------
// buildHlsBundle
// ---------------------------------------------------------------------------

describe('buildHlsBundle', () => {
  it('returns null when video is missing', () => {
    const r = makeResolved({ video: null })
    expect(buildHlsBundle(r, 'video.m3u8', 'audio.m3u8')).toBeNull()
  })

  it('returns null when audio is missing', () => {
    const r = makeResolved({ audio: null })
    expect(buildHlsBundle(r, 'video.m3u8', 'audio.m3u8')).toBeNull()
  })

  it('returns null when both are missing', () => {
    const r = makeResolved({ video: null, audio: null })
    expect(buildHlsBundle(r, 'video.m3u8', 'audio.m3u8')).toBeNull()
  })

  describe('happy-path adaptive pair → three playlist strings', () => {
    let bundle: ReturnType<typeof buildHlsBundle>
    beforeEach(() => {
      bundle = buildHlsBundle(makeResolved(), 'video.m3u8', 'audio.m3u8')
    })

    it('returns a non-null bundle', () => {
      expect(bundle).not.toBeNull()
    })

    it('master contains #EXT-X-MEDIA with GROUP-ID "aud"', () => {
      expect(bundle!.master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud"')
    })

    it('master STREAM-INF references AUDIO="aud"', () => {
      expect(bundle!.master).toContain('AUDIO="aud"')
    })

    it('master carries correct BANDWIDTH from video bitrate', () => {
      expect(bundle!.master).toContain('BANDWIDTH=4500000')
    })

    it('master carries correct RESOLUTION (1920×1080 for 1080p 16:9)', () => {
      expect(bundle!.master).toContain('RESOLUTION=1920x1080')
    })

    it('master references the video playlist name', () => {
      expect(bundle!.master).toContain('video.m3u8')
    })

    it('master references the audio playlist name in EXT-X-MEDIA URI', () => {
      expect(bundle!.master).toContain('URI="audio.m3u8"')
    })

    it('video playlist contains the video URL', () => {
      expect(bundle!.video).toContain('https://v.googlevideo.com/videofile')
    })

    it('video playlist has EXTINF with duration', () => {
      expect(bundle!.video).toContain('#EXTINF:212')
    })

    it('video playlist has #EXT-X-ENDLIST', () => {
      expect(bundle!.video).toContain('#EXT-X-ENDLIST')
    })

    it('video playlist is VOD type', () => {
      expect(bundle!.video).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    })

    it('audio playlist contains the audio URL', () => {
      expect(bundle!.audio).toContain('https://r4.googlevideo.com/audiofile')
    })

    it('audio playlist has EXTINF with duration', () => {
      expect(bundle!.audio).toContain('#EXTINF:212')
    })

    it('audio playlist has #EXT-X-ENDLIST', () => {
      expect(bundle!.audio).toContain('#EXT-X-ENDLIST')
    })
  })

  it('uses default bandwidth (2 Mbit/s) when bitrate is absent', () => {
    const r = makeResolved({ video: { url: 'https://v/x', mime: 'video/mp4', height: 720, bitrate: null } })
    const bundle = buildHlsBundle(r, 'v.m3u8', 'a.m3u8')
    expect(bundle!.master).toContain('BANDWIDTH=2000000')
  })

  it('uses default height (720p → 1280x720) when height is absent', () => {
    const r = makeResolved({ video: { url: 'https://v/x', mime: 'video/mp4', height: null, bitrate: null } })
    const bundle = buildHlsBundle(r, 'v.m3u8', 'a.m3u8')
    expect(bundle!.master).toContain('RESOLUTION=1280x720')
  })

  it('uses 600 s default duration when duration_secs is null', () => {
    const r = makeResolved({ duration_secs: null })
    const bundle = buildHlsBundle(r, 'v.m3u8', 'a.m3u8')
    expect(bundle!.video).toContain('#EXTINF:600')
    expect(bundle!.audio).toContain('#EXTINF:600')
  })

  it('embeds custom playlist names in the master', () => {
    const r = makeResolved()
    const bundle = buildHlsBundle(r, '/trailer/dQw4w9WgXcQ/video.m3u8', '/trailer/dQw4w9WgXcQ/audio.m3u8')
    expect(bundle!.master).toContain('/trailer/dQw4w9WgXcQ/video.m3u8')
    expect(bundle!.master).toContain('/trailer/dQw4w9WgXcQ/audio.m3u8')
  })
})

// ---------------------------------------------------------------------------
// getOrFetchResolved — cache behaviour (binary mocked)
// ---------------------------------------------------------------------------

// We mock the entire module so we can swap resolveViaRustBinary without a real
// binary.  The test file imports the real buildHlsBundle and _evictFromCache
// from the module but overrides resolveViaRustBinary in getOrFetchResolved
// by re-exporting a mock variant through vi.mock.
//
// Because vitest ESM mocking replaces the whole module's factory, we use a
// factory that keeps the real implementations for everything except the binary
// call.  The approach: mock child_process.execFile so the binary "runs"
// without actually running.

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(),
  }
})

import { execFile } from 'node:child_process'

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>

describe('getOrFetchResolved', () => {
  const VIDEO_ID = 'testid12345'
  const resolved = makeResolved({ video_id: VIDEO_ID })

  beforeEach(() => {
    _evictFromCache(VIDEO_ID)
    vi.useFakeTimers()
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: object, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, JSON.stringify(resolved) + '\n', '')
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('calls the binary on a cold cache and returns parsed result', async () => {
    const result = await getOrFetchResolved(VIDEO_ID)
    expect(result.video_id).toBe(VIDEO_ID)
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('serves from cache on a second call within TTL', async () => {
    await getOrFetchResolved(VIDEO_ID)
    await getOrFetchResolved(VIDEO_ID)
    expect(mockExecFile).toHaveBeenCalledTimes(1)
  })

  it('re-calls the binary after TTL expires (3h)', async () => {
    await getOrFetchResolved(VIDEO_ID)
    vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 1)
    await getOrFetchResolved(VIDEO_ID)
    expect(mockExecFile).toHaveBeenCalledTimes(2)
  })

  it('propagates errors from a failing binary and does not cache the failure', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    mockExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        cb(err)
      },
    )
    await expect(getOrFetchResolved(VIDEO_ID)).rejects.toThrow('eex-ytresolve failed')
    // Next call should retry (not serve a cached error).
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], _opts: object, cb: (err: null, stdout: string, stderr: string) => void) => {
        cb(null, JSON.stringify(resolved) + '\n', '')
      },
    )
    const result = await getOrFetchResolved(VIDEO_ID)
    expect(result.video_id).toBe(VIDEO_ID)
    expect(mockExecFile).toHaveBeenCalledTimes(2)
  })
})
