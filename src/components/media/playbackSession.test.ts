import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  absoluteProgress,
  createFrozenPlayheadWatchdog,
  episodeQueue,
  formatPlaybackTime,
  FROZEN_PLAYHEAD_LIMIT_MS,
  upNextDue,
  COMPLETE_TAIL_SECS,
  HEARTBEAT_INTERVAL_MS,
  hlsPinnedDurationSecs,
  playerStartPosition,
  startPlaybackSession,
  type PlaybackSessionApi,
  type PlaybackSessionHandlers,
} from './playbackSession'
import type { PlaybackGrant } from '../../lib/api/media'
import { throwApiError } from '../../lib/api/errors'
import { SESSION_EXPIRED_EVENT } from '../../lib/sessionExpiry'

// MediaPlayer's grant/heartbeat/stop lifecycle, driven at the api-client
// boundary with fake timers (the same mock seam IptvPlayer.test.tsx uses for
// its engine helpers — the node env has no DOM to mount the component in).

function hlsGrant(overrides: Partial<PlaybackGrant> = {}): PlaybackGrant {
  return {
    delivery: 'hls',
    url: 'https://api.example/api/transcode/abc/index.m3u8?t=tok',
    durationSecs: 7200,
    heartbeatUrl: 'https://api.example/api/transcode/abc/heartbeat?t=tok',
    stopUrl: 'https://api.example/api/transcode/abc/stop?t=tok',
    sessionId: 'abc',
    ...overrides,
  }
}

function directGrant(): PlaybackGrant {
  return {
    delivery: 'progressive',
    url: 'https://api.example/api/media/stream/9?t=tok',
    durationSecs: 5400,
    heartbeatUrl: null,
    stopUrl: null,
  }
}

function harness(grant: Promise<PlaybackGrant> | PlaybackGrant) {
  const api = {
    playback: vi.fn().mockReturnValue(Promise.resolve(grant)),
    heartbeat: vi.fn().mockResolvedValue(200),
    stop: vi.fn(),
  } satisfies PlaybackSessionApi
  const handlers = {
    onGrant: vi.fn(),
    onGrantError: vi.fn(),
    onSessionLost: vi.fn(),
  } satisfies PlaybackSessionHandlers
  return { api, handlers }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startPlaybackSession — grant flow', () => {
  it('requests the grant at the api boundary with kind/id/resume offset and reports it', async () => {
    const grant = hlsGrant()
    const { api, handlers } = harness(grant)

    startPlaybackSession({ kind: 'movie', id: 9, startPositionSecs: 120, api, handlers })
    await vi.advanceTimersByTimeAsync(0)

    expect(api.playback).toHaveBeenCalledExactlyOnceWith('movie', 9, undefined, 120, undefined)
    expect(handlers.onGrant).toHaveBeenCalledExactlyOnceWith(grant)
    expect(handlers.onGrantError).not.toHaveBeenCalled()
  })

  it('threads forceHls (stall escalation) through to the api grant call', async () => {
    const grant = hlsGrant()
    const { api, handlers } = harness(grant)

    startPlaybackSession({
      kind: 'movie',
      id: 9,
      startPositionSecs: 612,
      forceHls: true,
      api,
      handlers,
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(api.playback).toHaveBeenCalledExactlyOnceWith('movie', 9, undefined, 612, true)
    expect(handlers.onGrant).toHaveBeenCalledExactlyOnceWith(grant)
  })

  it('surfaces a grant failure as a readable error', async () => {
    const { api, handlers } = harness(hlsGrant())
    api.playback.mockReturnValue(Promise.reject(new Error('Media /playback/movie/9 failed (503)')))

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(0)

    expect(handlers.onGrant).not.toHaveBeenCalled()
    expect(handlers.onGrantError).toHaveBeenCalledExactlyOnceWith(
      'Media /playback/movie/9 failed (503)',
    )
  })

  it('cannot swallow an edge session expiry while surfacing a playback error', async () => {
    const windowTarget = new EventTarget()
    const listener = vi.fn()
    windowTarget.addEventListener(
      SESSION_EXPIRED_EVENT,
      listener as unknown as EventListener,
    )
    vi.stubGlobal('window', windowTarget)
    const { api, handlers } = harness(hlsGrant())
    api.playback.mockImplementation(() =>
      throwApiError(
        new Response(JSON.stringify({ error: 'unauthenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
        'Media /playback/movie/9',
      ),
    )

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(0)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(handlers.onGrantError).toHaveBeenCalledWith(
      'Your session expired. Sign in again.',
    )
  })

  it('falls back to a generic message when the rejection is not an Error', async () => {
    const { api, handlers } = harness(hlsGrant())
    api.playback.mockReturnValue(Promise.reject('boom'))

    startPlaybackSession({ kind: 'episode', id: 3, api, handlers })
    await vi.advanceTimersByTimeAsync(0)

    expect(handlers.onGrantError).toHaveBeenCalledExactlyOnceWith('Could not start playback.')
  })

  it('frees the just-claimed transcoder slot when disposed before the grant resolves', async () => {
    let resolve!: (g: PlaybackGrant) => void
    const pending = new Promise<PlaybackGrant>((r) => {
      resolve = r
    })
    const { api, handlers } = harness(pending)

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    session.dispose()
    resolve(hlsGrant())
    await vi.advanceTimersByTimeAsync(0)

    expect(handlers.onGrant).not.toHaveBeenCalled()
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(hlsGrant().stopUrl)
  })
})

describe('startPlaybackSession — heartbeat lifecycle', () => {
  it('heartbeats the grant url at the interval while the session is live', async () => {
    const { api, handlers } = harness(hlsGrant())

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(api.heartbeat).toHaveBeenCalledTimes(3)
    expect(api.heartbeat).toHaveBeenCalledWith(hlsGrant().heartbeatUrl)
  })

  it('never heartbeats a direct-play grant (no heartbeatUrl)', async () => {
    const { api, handlers } = harness(directGrant())

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5)

    expect(handlers.onGrant).toHaveBeenCalledTimes(1)
    expect(api.heartbeat).not.toHaveBeenCalled()
  })

  it('keeps beating through transient network failures (undefined status)', async () => {
    const { api, handlers } = harness(hlsGrant())
    api.heartbeat.mockResolvedValue(undefined)

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(api.heartbeat).toHaveBeenCalledTimes(3)
    expect(handlers.onSessionLost).not.toHaveBeenCalled()
  })

  it('stops on unmount: dispose clears the heartbeat and frees the slot', async () => {
    const { api, handlers } = harness(hlsGrant())

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    session.dispose()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)

    expect(api.heartbeat).toHaveBeenCalledTimes(1)
    expect(api.stop).toHaveBeenCalledExactlyOnceWith(hlsGrant().stopUrl)
  })
})

describe('startPlaybackSession — heartbeat 404 (session reaped)', () => {
  it('stops heartbeating and reports the lost session exactly once', async () => {
    const { api, handlers } = harness(hlsGrant())
    api.heartbeat.mockResolvedValue(404)

    startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 4)

    expect(api.heartbeat).toHaveBeenCalledTimes(1)
    expect(handlers.onSessionLost).toHaveBeenCalledTimes(1)
  })

  it('does not POST stop at the dead session afterwards', async () => {
    const { api, handlers } = harness(hlsGrant())
    api.heartbeat.mockResolvedValue(404)

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    session.stop()
    session.dispose()

    expect(api.stop).not.toHaveBeenCalled()
  })

  it('suppresses a 404 landing after the user already stopped the session', async () => {
    const { api, handlers } = harness(hlsGrant())
    let resolveBeat!: (status: number) => void
    api.heartbeat.mockReturnValue(
      new Promise<number>((r) => {
        resolveBeat = r
      }),
    )

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    session.stop()
    resolveBeat(404)
    await vi.advanceTimersByTimeAsync(0)

    expect(handlers.onSessionLost).not.toHaveBeenCalled()
  })
})

describe('startPlaybackSession — stop-on-close', () => {
  it('posts the stop url once and is idempotent across repeated calls', async () => {
    const { api, handlers } = harness(hlsGrant())

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(0)
    session.stop()
    session.stop()
    session.dispose()

    expect(api.stop).toHaveBeenCalledExactlyOnceWith(hlsGrant().stopUrl)
  })

  it('does nothing for a direct-play grant (no stopUrl, no heartbeat)', async () => {
    const { api, handlers } = harness(directGrant())

    const session = startPlaybackSession({ kind: 'movie', id: 9, api, handlers })
    await vi.advanceTimersByTimeAsync(0)
    session.stop()

    expect(api.stop).not.toHaveBeenCalled()
  })
})

describe('playerStartPosition', () => {
  it('passes the resume offset through for direct play (real timeline)', () => {
    expect(playerStartPosition('progressive', 321)).toBe(321)
  })

  it('suppresses the client seek for HLS (offset is baked server-side via -ss)', () => {
    expect(playerStartPosition('hls', 321)).toBeUndefined()
  })
})

describe('absoluteProgress', () => {
  it('treats direct-play currentTime as absolute and trusts the element duration', () => {
    const r = absoluteProgress({
      delivery: 'progressive',
      grantDurationSecs: 7200,
      startPositionSecs: 600,
      positionSecs: 42,
      durationSecs: 5400,
    })

    expect(r).toEqual({ pos: 42, dur: 5400, completed: false })
  })

  it('offsets HLS positions by the baked resume point and uses the grant duration', () => {
    const r = absoluteProgress({
      delivery: 'hls',
      grantDurationSecs: 7200,
      startPositionSecs: 600,
      positionSecs: 42,
      durationSecs: 30, // live-window duration — must be ignored
    })

    expect(r).toEqual({ pos: 642, dur: 7200, completed: false })
  })

  it('marks the title complete inside the credits tail', () => {
    const r = absoluteProgress({
      delivery: 'hls',
      grantDurationSecs: 7200,
      startPositionSecs: 7000,
      positionSecs: 7200 - 7000 - COMPLETE_TAIL_SECS + 1,
      durationSecs: null,
    })

    expect(r.completed).toBe(true)
  })

  it('falls back to the grant duration when the element reports none (direct play)', () => {
    const r = absoluteProgress({
      delivery: 'progressive',
      grantDurationSecs: 5400,
      positionSecs: 10,
      durationSecs: null,
    })

    expect(r.dur).toBe(5400)
  })
})

describe('hlsPinnedDurationSecs', () => {
  it('pins the full length for a fresh session', () => {
    expect(hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: 7679 })).toBe(7679)
  })

  it('pins the REMAINING length for a resumed session (-ss media timeline starts at 0)', () => {
    // The media timeline is the raw session; MediaControls adds the offset
    // back for display. Pinning the full length would let the playhead seek
    // into the offset-worth of timeline past the session's real end.
    expect(
      hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: 7679, startPositionSecs: 600 }),
    ).toBe(7079)
  })

  it('returns null when the offset consumes the whole duration', () => {
    expect(
      hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: 600, startPositionSecs: 600 }),
    ).toBeNull()
  })

  it('never pins progressive delivery (the file reports its own duration)', () => {
    expect(
      hlsPinnedDurationSecs({ delivery: 'progressive', grantDurationSecs: 7679 }),
    ).toBeNull()
  })

  it('returns null when the grant carries no duration', () => {
    expect(hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: null })).toBeNull()
  })

  it('returns null for a zero/invalid duration', () => {
    expect(hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: 0 })).toBeNull()
    expect(hlsPinnedDurationSecs({ delivery: 'hls', grantDurationSecs: NaN })).toBeNull()
  })
})

describe('formatPlaybackTime', () => {
  it('renders M:SS under an hour and H:MM:SS past it (native-controls style)', () => {
    expect(formatPlaybackTime(42)).toBe('0:42')
    expect(formatPlaybackTime(13 * 60 + 24)).toBe('13:24')
    expect(formatPlaybackTime(3600 + 2 * 60 + 5)).toBe('1:02:05')
  })

  it('clamps negatives and fractions sanely', () => {
    expect(formatPlaybackTime(-5)).toBe('0:00')
    expect(formatPlaybackTime(59.9)).toBe('0:59')
  })
})

describe('binge helpers', () => {
  it('arms Up Next only in the last 30 s of a title longer than 45 s', () => {
    expect(upNextDue(1370, 1400)).toBe(true)
    expect(upNextDue(1369, 1400)).toBe(false)
    expect(upNextDue(30, 40)).toBe(false)
    expect(upNextDue(100, null)).toBe(false)
  })

  it('orders the queue by season/episode and finds the neighbours', () => {
    const eps = [
      { id: 3, season: 2, episode: 1 },
      { id: 1, season: 1, episode: 1 },
      { id: 2, season: 1, episode: 2 },
    ]
    const q = episodeQueue(eps, 2)
    expect(q.episodes.map((e) => e.id)).toEqual([1, 2, 3])
    expect(q.prev?.id).toBe(1)
    expect(q.next?.id).toBe(3)
    expect(episodeQueue(eps, 3).next).toBeNull()
    expect(episodeQueue(eps, 1).prev).toBeNull()
    expect(episodeQueue(eps, 99)).toMatchObject({ prev: null, next: null })
  })
})

describe('createFrozenPlayheadWatchdog', () => {
  const sample = (position: number, now: number, over: { paused?: boolean; starved?: boolean } = {}) => ({
    position,
    now,
    paused: over.paused ?? false,
    starved: over.starved ?? true,
  })

  it('flags a starved, frozen playhead after 15 s of playback having begun', () => {
    const tick = createFrozenPlayheadWatchdog()
    expect(tick(sample(10, 0))).toBe(false)
    expect(tick(sample(11, 1000))).toBe(false)
    expect(tick(sample(11, 1000 + FROZEN_PLAYHEAD_LIMIT_MS - 1))).toBe(false)
    expect(tick(sample(11, 1000 + FROZEN_PLAYHEAD_LIMIT_MS))).toBe(true)
  })

  it('never fires before playback begins, while paused, or with a full buffer', () => {
    const fresh = createFrozenPlayheadWatchdog()
    expect(fresh(sample(0, 0))).toBe(false)
    expect(fresh(sample(0, 60_000))).toBe(false)

    const paused = createFrozenPlayheadWatchdog()
    paused(sample(10, 0))
    paused(sample(11, 1000))
    expect(paused(sample(11, 60_000, { paused: true }))).toBe(false)
    expect(paused(sample(11, 70_000))).toBe(false)

    const buffered = createFrozenPlayheadWatchdog()
    buffered(sample(10, 0))
    buffered(sample(11, 1000))
    expect(buffered(sample(11, 60_000, { starved: false }))).toBe(false)
  })

  it('a seek restarts the clock', () => {
    const tick = createFrozenPlayheadWatchdog()
    tick(sample(10, 0))
    tick(sample(11, 1000))
    expect(tick(sample(500, 14_000))).toBe(false)
    expect(tick(sample(500, 20_000))).toBe(false)
    expect(tick(sample(500, 29_000))).toBe(true)
  })
})
