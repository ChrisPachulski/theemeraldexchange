import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import IptvPlayer, {
  audioOptionsFromVideo,
  subtitleOptionsFromVideo,
  selectedAudioFromVideo,
  selectedSubtitleFromVideo,
  setNativeAudioTrack,
  setNativeSubtitleTrack,
  labelForTrack,
  applyAudioTrack,
  applySubtitleTrack,
  createFatalHlsErrorHandler,
  createHlsDurationPin,
  createHlsStallWatchdog,
  createProgressiveStallEscalator,
  createSeekFloorGuard,
  selectHlsEngine,
  HLS_PLAYLIST_LOAD_POLICY,
  SEEK_FLOOR_TOLERANCE_SECS,
  ESCALATE_CONFIRM_MS,
  ESCALATE_WINDOW_MS,
  MAX_NET_RETRIES,
  MEDIA_RECOVERY_WINDOW_MS,
  type RecoverableHls,
} from './IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'

// The vitest environment is `node` (see vitest.config.ts), not jsdom — there are
// no DOM globals. So we construct lightweight, numeric-indexed fake track lists
// shaped like MediaTrackList / TextTrackList and cast through `as any` when calling
// the helpers, instead of constructing real HTMLVideoElement / TextTrack objects.

type AudioTrackFake = {
  name?: string
  lang?: string
  language?: string
  label?: string
  enabled?: boolean
}

type TextTrackFake = {
  mode?: 'showing' | 'disabled' | 'hidden'
  label?: string
  language?: string
}

function fakeAudioTracks(tracks: AudioTrackFake[]) {
  const list: Record<number | 'length', unknown> = { length: tracks.length }
  tracks.forEach((t, i) => {
    list[i] = { ...t }
  })
  return list
}

function fakeVideoWithAudio(tracks: AudioTrackFake[]) {
  return { audioTracks: fakeAudioTracks(tracks) }
}

function fakeTextTracks(tracks: TextTrackFake[]) {
  const list: Record<number | 'length', unknown> = { length: tracks.length }
  tracks.forEach((t, i) => {
    list[i] = { ...t }
  })
  return list
}

function fakeVideoWithText(tracks: TextTrackFake[]) {
  return { textTracks: fakeTextTracks(tracks) }
}

describe('IptvPlayer', () => {
  it('renders with progressive grant', () => {
    const grant: StreamGrant = {
      url: '/api/iptv/stream/vod/20/mp4?t=fake',
      delivery: 'progressive',
      mime: 'video/mp4',
    }

    const html = renderToStaticMarkup(<IptvPlayer grant={grant} />)

    expect(html).toContain('<video')
  })

  it('renders with HLS grant', () => {
    const grant: StreamGrant = {
      url: '/api/iptv/stream/live/10/remux/index.m3u8?t=fake',
      delivery: 'hls',
      mime: 'application/vnd.apple.mpegurl',
    }

    const html = renderToStaticMarkup(<IptvPlayer grant={grant} />)

    expect(html).toContain('<video')
  })
})

describe('createSeekFloorGuard', () => {
  // A resumed -ss session presented at absolute time (timelineOffset) shows
  // the pre-resume title region on the seekbar but has no media for it; the
  // guard hands such seeks to the owner for a re-grant.
  it('fires once with the floored target when seeking below the session floor', () => {
    const onSeekBelowFloor = vi.fn()
    const guard = createSeekFloorGuard({
      floorSecs: 772,
      isCancelled: () => false,
      onSeekBelowFloor,
    })

    guard.onSeeking(300.7)
    expect(onSeekBelowFloor).toHaveBeenCalledExactlyOnceWith(300)

    guard.onSeeking(100) // already fired — the re-grant remounts the engine
    expect(onSeekBelowFloor).toHaveBeenCalledOnce()
  })

  it('tolerates keyframe snapping just below the floor and any seek above it', () => {
    const onSeekBelowFloor = vi.fn()
    const guard = createSeekFloorGuard({
      floorSecs: 772,
      isCancelled: () => false,
      onSeekBelowFloor,
    })

    guard.onSeeking(772 - SEEK_FLOOR_TOLERANCE_SECS) // boundary: not below
    guard.onSeeking(900)
    expect(onSeekBelowFloor).not.toHaveBeenCalled()
  })

  it('never fires after the engine effect is cancelled', () => {
    const onSeekBelowFloor = vi.fn()
    const guard = createSeekFloorGuard({
      floorSecs: 772,
      isCancelled: () => true,
      onSeekBelowFloor,
    })

    guard.onSeeking(10)
    expect(onSeekBelowFloor).not.toHaveBeenCalled()
  })

  it('clamps targets to zero (no negative re-grant offsets)', () => {
    const onSeekBelowFloor = vi.fn()
    const guard = createSeekFloorGuard({
      floorSecs: 5,
      isCancelled: () => false,
      onSeekBelowFloor,
    })

    guard.onSeeking(-1)
    expect(onSeekBelowFloor).toHaveBeenCalledExactlyOnceWith(0)
  })
})

describe('HLS_PLAYLIST_LOAD_POLICY', () => {
  // Regression guard: hls.js's DEFAULT manifest policy waits 20 s on a load
  // whose headers arrived but whose body never completes — the edge drops a
  // chunked manifest response often enough that fresh sessions showed a
  // silent 20 s startup spinner. A playlist is a few KB; fail fast and lean
  // on immediate retries. Loosening these back toward the defaults
  // reintroduces the stall.
  it('times out a stalled playlist body fast with immediate retries', () => {
    const p = HLS_PLAYLIST_LOAD_POLICY.default
    expect(p.maxTimeToFirstByteMs).toBeLessThanOrEqual(6000)
    expect(p.maxLoadTimeMs).toBeLessThanOrEqual(8000)
    expect(p.timeoutRetry.maxNumRetry).toBeGreaterThanOrEqual(4)
    expect(p.timeoutRetry.retryDelayMs).toBe(0)
    expect(p.errorRetry.maxNumRetry).toBeGreaterThanOrEqual(4)
  })
})

describe('selectHlsEngine', () => {
  // Regression: desktop Chrome returns canPlayType('application/vnd.apple.mpegurl')
  // === 'maybe' but cannot actually play HLS natively. MSE must win whenever
  // available, or Chrome silently dead-ends on video.src = .m3u8 (error 4).
  it('chooses MSE when hls.js is supported, even if native HLS claims support', () => {
    expect(selectHlsEngine(true, 'maybe')).toBe('mse')
    expect(selectHlsEngine(true, 'probably')).toBe('mse')
    expect(selectHlsEngine(true, '')).toBe('mse')
  })

  it('falls back to native HLS only when MSE is unavailable (iOS Safari)', () => {
    expect(selectHlsEngine(false, 'maybe')).toBe('native')
    expect(selectHlsEngine(false, 'probably')).toBe('native')
  })

  it('reports unsupported when neither MSE nor native HLS is available', () => {
    expect(selectHlsEngine(false, '')).toBe('unsupported')
  })
})

describe('labelForTrack', () => {
  it('returns track.name when present', () => {
    expect(labelForTrack({ name: 'English' }, 0)).toBe('English')
  })

  it('falls back to label when name is absent', () => {
    expect(labelForTrack({ label: 'Commentary' }, 0)).toBe('Commentary')
  })

  it('falls back to lang when name and label are absent', () => {
    expect(labelForTrack({ lang: 'spa' }, 1)).toBe('spa')
  })

  it('falls back to language when name, label, and lang are absent', () => {
    expect(labelForTrack({ language: 'fra' }, 2)).toBe('fra')
  })

  it('honors the name > label > lang > language precedence', () => {
    expect(
      labelForTrack({ name: 'A', label: 'B', lang: 'C', language: 'D' }, 0),
    ).toBe('A')
    expect(labelForTrack({ label: 'B', lang: 'C', language: 'D' }, 0)).toBe('B')
    expect(labelForTrack({ lang: 'C', language: 'D' }, 0)).toBe('C')
  })

  it('falls back to `Track ${index + 1}` when no fields are present', () => {
    expect(labelForTrack({}, 0)).toBe('Track 1')
    expect(labelForTrack({}, 4)).toBe('Track 5')
  })
})

describe('audioOptionsFromVideo', () => {
  it('returns [] when video.audioTracks is undefined', () => {
    expect(audioOptionsFromVideo({} as never)).toEqual([])
  })

  it('returns [] when audioTracks length is 0', () => {
    expect(audioOptionsFromVideo(fakeVideoWithAudio([]) as never)).toEqual([])
  })

  it('maps N tracks to TrackOption[] with sequential ids and resolved labels', () => {
    const video = fakeVideoWithAudio([{ name: 'English' }, { lang: 'spa' }])
    expect(audioOptionsFromVideo(video as never)).toEqual([
      { id: 0, label: 'English' },
      { id: 1, label: 'spa' },
    ])
  })
})

describe('subtitleOptionsFromVideo', () => {
  it('returns [] when textTracks is empty', () => {
    expect(subtitleOptionsFromVideo(fakeVideoWithText([]) as never)).toEqual([])
  })

  it('maps subtitle tracks to TrackOption[] using label/language fallbacks', () => {
    const video = fakeVideoWithText([
      { label: 'English CC', mode: 'disabled' },
      { language: 'spa', mode: 'disabled' },
    ])
    expect(subtitleOptionsFromVideo(video as never)).toEqual([
      { id: 0, label: 'English CC' },
      { id: 1, label: 'spa' },
    ])
  })
})

describe('selectedAudioFromVideo', () => {
  it('returns 0 when there are no audioTracks', () => {
    expect(selectedAudioFromVideo({} as never)).toBe(0)
  })

  it('returns 0 when audioTracks is empty', () => {
    expect(selectedAudioFromVideo(fakeVideoWithAudio([]) as never)).toBe(0)
  })

  it('returns the index of the first enabled track', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: false },
      { name: 'Spanish', enabled: true },
      { name: 'French', enabled: false },
    ])
    expect(selectedAudioFromVideo(video as never)).toBe(1)
  })

  it('returns 0 when no track is enabled', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: false },
      { name: 'Spanish', enabled: false },
    ])
    expect(selectedAudioFromVideo(video as never)).toBe(0)
  })
})

describe('selectedSubtitleFromVideo', () => {
  it('returns -1 when there are no textTracks', () => {
    expect(selectedSubtitleFromVideo(fakeVideoWithText([]) as never)).toBe(-1)
  })

  it('returns -1 when no track is showing', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'hidden' },
    ])
    expect(selectedSubtitleFromVideo(video as never)).toBe(-1)
  })

  it('returns the index of the first track whose mode === showing', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'hidden' },
      { mode: 'showing' },
    ])
    expect(selectedSubtitleFromVideo(video as never)).toBe(2)
  })
})

describe('setNativeAudioTrack', () => {
  it('enables only the chosen track id and disables all others', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: true },
      { name: 'Spanish', enabled: false },
      { name: 'French', enabled: false },
    ])
    setNativeAudioTrack(video as never, 1)
    const tracks = video.audioTracks as Record<number, AudioTrackFake>
    expect([tracks[0].enabled, tracks[1].enabled, tracks[2].enabled]).toEqual([
      false,
      true,
      false,
    ])
  })

  it('no-ops safely when audioTracks is empty', () => {
    expect(() => setNativeAudioTrack(fakeVideoWithAudio([]) as never, 0)).not.toThrow()
  })

  it('no-ops safely when audioTracks is undefined', () => {
    expect(() => setNativeAudioTrack({} as never, 0)).not.toThrow()
  })
})

describe('setNativeSubtitleTrack', () => {
  it('shows only the chosen track id and disables all others', () => {
    const video = fakeVideoWithText([
      { mode: 'disabled' },
      { mode: 'showing' },
      { mode: 'disabled' },
    ])
    setNativeSubtitleTrack(video as never, 0)
    const tracks = video.textTracks as Record<number, TextTrackFake>
    expect([tracks[0].mode, tracks[1].mode, tracks[2].mode]).toEqual([
      'showing',
      'disabled',
      'disabled',
    ])
  })
})

describe('applyAudioTrack', () => {
  // The HLS branch is the live-TV switch path that the inline handler left
  // uncovered; these assert both the return value AND the engine mutation.
  it('switches the HLS engine (live path) and returns the applied id', () => {
    const hls = { audioTrack: 0, subtitleTrack: -1 }

    const applied = applyAudioTrack(hls, null, 2)

    expect(applied).toBe(2)
    expect(hls.audioTrack).toBe(2)
  })

  it('prefers HLS over native and leaves native audioTracks untouched', () => {
    const hls = { audioTrack: 0, subtitleTrack: -1 }
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: true },
      { name: 'Spanish', enabled: false },
    ])

    const applied = applyAudioTrack(hls, video as never, 1)

    expect(applied).toBe(1)
    expect(hls.audioTrack).toBe(1)
    const tracks = video.audioTracks as Record<number, AudioTrackFake>
    expect([tracks[0].enabled, tracks[1].enabled]).toEqual([true, false])
  })

  it('switches the native audio track when no HLS engine', () => {
    const video = fakeVideoWithAudio([
      { name: 'English', enabled: true },
      { name: 'Spanish', enabled: false },
    ])

    const applied = applyAudioTrack(null, video as never, 1)

    expect(applied).toBe(1)
    const tracks = video.audioTracks as Record<number, AudioTrackFake>
    expect([tracks[0].enabled, tracks[1].enabled]).toEqual([false, true])
  })

  it('returns null and does not throw on empty native audioTracks', () => {
    const video = fakeVideoWithAudio([])

    expect(() => applyAudioTrack(null, video as never, 0)).not.toThrow()
    expect(applyAudioTrack(null, video as never, 0)).toBeNull()
  })

  it('returns null when there is no engine at all', () => {
    expect(applyAudioTrack(null, null, 0)).toBeNull()
  })
})

describe('createFatalHlsErrorHandler', () => {
  function harness(startAt = 0) {
    const hls: RecoverableHls = {
      startLoad: vi.fn(),
      recoverMediaError: vi.fn(),
      swapAudioCodec: vi.fn(),
      destroy: vi.fn(),
    }
    const setError = vi.fn()
    // Deterministic clock + a schedule that captures (fn, delay) so tests can
    // fire the retry callback explicitly — no real timers in the node env.
    let clock = startAt
    const scheduled: Array<{ fn: () => void; delayMs: number }> = []
    let cancelled = false
    const handler = createFatalHlsErrorHandler({
      hls,
      isCancelled: () => cancelled,
      setError,
      schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
      now: () => clock,
    })
    return {
      hls,
      setError,
      scheduled,
      handler,
      cancel: () => {
        cancelled = true
      },
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  it('first fatal media error → recoverMediaError() only', () => {
    const h = harness()

    h.handler('media')

    expect(h.hls.recoverMediaError).toHaveBeenCalledTimes(1)
    expect(h.hls.swapAudioCodec).not.toHaveBeenCalled()
    expect(h.hls.destroy).not.toHaveBeenCalled()
    expect(h.setError).not.toHaveBeenCalled()
  })

  it('second fatal media error inside the window → swapAudioCodec() + recoverMediaError()', () => {
    const h = harness()

    h.handler('media')
    h.advance(MEDIA_RECOVERY_WINDOW_MS - 1)
    h.handler('media')

    expect(h.hls.swapAudioCodec).toHaveBeenCalledTimes(1)
    expect(h.hls.recoverMediaError).toHaveBeenCalledTimes(2)
    expect(h.hls.destroy).not.toHaveBeenCalled()
  })

  it('third fatal media error inside the window → destroy + visible error, no more recovery', () => {
    const h = harness()

    h.handler('media')
    h.advance(100)
    h.handler('media')
    h.advance(100)
    h.handler('media')

    expect(h.hls.destroy).toHaveBeenCalledTimes(1)
    expect(h.setError).toHaveBeenCalledTimes(1)
    expect(h.setError.mock.calls[0][0]).toMatch(/Playback failed/)
    // The ladder stopped — no third recover attempt on the dead instance.
    expect(h.hls.recoverMediaError).toHaveBeenCalledTimes(2)
  })

  it('media errors spaced wider than the window reset the ladder (no false give-up)', () => {
    const h = harness()

    h.handler('media')
    h.advance(MEDIA_RECOVERY_WINDOW_MS + 1)
    h.handler('media')
    h.advance(MEDIA_RECOVERY_WINDOW_MS + 1)
    h.handler('media')

    // Each error was treated as a fresh transient glitch.
    expect(h.hls.recoverMediaError).toHaveBeenCalledTimes(3)
    expect(h.hls.swapAudioCodec).not.toHaveBeenCalled()
    expect(h.hls.destroy).not.toHaveBeenCalled()
  })

  it('network errors schedule startLoad with capped backoff', () => {
    const h = harness()

    h.handler('network')
    h.handler('network')

    expect(h.scheduled.map((s) => s.delayMs)).toEqual([500, 1000])
    h.scheduled[0].fn()
    expect(h.hls.startLoad).toHaveBeenCalledTimes(1)

    // Delay caps at 3000ms regardless of retry count.
    for (let i = 0; i < 5; i += 1) h.handler('network')
    expect(h.scheduled[h.scheduled.length - 1].delayMs).toBe(3000)
  })

  it('gives up with a visible error after MAX_NET_RETRIES network errors', () => {
    const h = harness()

    for (let i = 0; i < MAX_NET_RETRIES; i += 1) h.handler('network')
    expect(h.setError).not.toHaveBeenCalled()

    h.handler('network')

    expect(h.setError).toHaveBeenCalledTimes(1)
    expect(h.setError.mock.calls[0][0]).toMatch(/warming up/)
    expect(h.hls.destroy).toHaveBeenCalledTimes(1)
  })

  it('other fatal errors destroy immediately with a message', () => {
    const h = harness()

    h.handler('other')

    expect(h.setError).toHaveBeenCalledWith('Playback failed.')
    expect(h.hls.destroy).toHaveBeenCalledTimes(1)
  })

  it('does nothing once cancelled — including pending network retries', () => {
    const h = harness()

    h.handler('network')
    h.cancel()
    h.scheduled[0].fn()
    h.handler('media')

    expect(h.hls.startLoad).not.toHaveBeenCalled()
    expect(h.hls.recoverMediaError).not.toHaveBeenCalled()
  })
})

describe('applySubtitleTrack', () => {
  it('switches the HLS engine (live path) and returns the applied id', () => {
    const hls = { audioTrack: 0, subtitleTrack: -1 }

    const applied = applySubtitleTrack(hls, null, 1)

    expect(applied).toBe(1)
    expect(hls.subtitleTrack).toBe(1)
  })

  it('prefers HLS over native and leaves native textTracks untouched', () => {
    const hls = { audioTrack: 0, subtitleTrack: -1 }
    const video = fakeVideoWithText([{ mode: 'disabled' }, { mode: 'showing' }])

    const applied = applySubtitleTrack(hls, video as never, 0)

    expect(applied).toBe(0)
    expect(hls.subtitleTrack).toBe(0)
    const tracks = video.textTracks as Record<number, TextTrackFake>
    expect([tracks[0].mode, tracks[1].mode]).toEqual(['disabled', 'showing'])
  })

  it('switches the native subtitle track when no HLS engine', () => {
    const video = fakeVideoWithText([{ mode: 'disabled' }, { mode: 'showing' }])

    const applied = applySubtitleTrack(null, video as never, 0)

    expect(applied).toBe(0)
    const tracks = video.textTracks as Record<number, TextTrackFake>
    expect([tracks[0].mode, tracks[1].mode]).toEqual(['showing', 'disabled'])
  })

  it('applies the "Off" (-1) selection on the native path (no length guard)', () => {
    const video = fakeVideoWithText([{ mode: 'showing' }])

    const applied = applySubtitleTrack(null, video as never, -1)

    expect(applied).toBe(-1)
    const tracks = video.textTracks as Record<number, TextTrackFake>
    expect(tracks[0].mode).toBe('disabled')
  })

  it('returns null when there is no engine at all', () => {
    expect(applySubtitleTrack(null, null, 0)).toBeNull()
  })
})

describe('createHlsStallWatchdog', () => {
  function harness() {
    const hls = { startLoad: vi.fn() }
    const scheduled: Array<{ fn: () => void; delayMs: number }> = []
    let cancelled = false
    let currentTime = 0
    const video = {
      get currentTime() { return currentTime },
    }
    const watchdog = createHlsStallWatchdog({
      hls,
      video: video as unknown as { currentTime: number },
      isCancelled: () => cancelled,
      schedule: (fn: () => void, delayMs: number) => {
        const entry = { fn, delayMs }
        scheduled.push(entry)
        return scheduled.length - 1
      },
      clearScheduled: (id: number) => {
        scheduled[id] = { fn: () => {}, delayMs: -1 }
      },
    })
    return {
      hls,
      scheduled,
      watchdog,
      cancel: () => { cancelled = true },
      advanceTime: (secs: number) => { currentTime += secs },
    }
  }

  it('does not call startLoad when onStall fires and playhead advances before the timer fires', () => {
    const h = harness()

    h.watchdog.onStall()
    h.advanceTime(1)
    // fire the timer that was scheduled
    h.scheduled[0].fn()

    expect(h.hls.startLoad).not.toHaveBeenCalled()
  })

  it('calls startLoad when onStall fires and playhead has not advanced after the stall window', () => {
    const h = harness()

    h.watchdog.onStall()
    // playhead stays at 0 — deliberate no advanceTime
    h.scheduled[0].fn()

    expect(h.hls.startLoad).toHaveBeenCalledTimes(1)
  })

  it('does not call startLoad if already cancelled when timer fires', () => {
    const h = harness()

    h.watchdog.onStall()
    h.cancel()
    h.scheduled[0].fn()

    expect(h.hls.startLoad).not.toHaveBeenCalled()
  })

  it('onProgress clears a pending stall timer so startLoad is not called', () => {
    const h = harness()

    h.watchdog.onStall()
    h.watchdog.onProgress()
    h.scheduled[0].fn()

    expect(h.hls.startLoad).not.toHaveBeenCalled()
  })

  it('successive onStall calls do not stack multiple timers', () => {
    const h = harness()
    const activeScheduled: number[] = []

    h.watchdog.onStall()
    activeScheduled.push(h.scheduled.length - 1)
    h.watchdog.onStall()

    // Only one timer entry with a positive delayMs should exist (the second
    // onStall is a no-op because one is already pending).
    const active = h.scheduled.filter((s) => s.delayMs >= 0)
    expect(active.length).toBe(1)
  })

  it('schedules the stall timer with a 4000ms delay', () => {
    const h = harness()

    h.watchdog.onStall()

    expect(h.scheduled[0].delayMs).toBe(4000)
  })

  it('cleanup cancels a pending stall timer', () => {
    const h = harness()

    h.watchdog.onStall()
    h.watchdog.cleanup()
    h.scheduled[0].fn()

    expect(h.hls.startLoad).not.toHaveBeenCalled()
  })
})

describe('createProgressiveStallEscalator', () => {
  function harness() {
    const onEscalate = vi.fn()
    const scheduled: Array<{ fn: () => void; delayMs: number }> = []
    let cancelled = false
    let currentTime = 0
    let seeking = false
    let nowMs = 0
    const video = {
      get currentTime() { return currentTime },
      get seeking() { return seeking },
    }
    const esc = createProgressiveStallEscalator({
      video: video as unknown as { currentTime: number; seeking: boolean },
      onEscalate,
      isCancelled: () => cancelled,
      schedule: (fn: () => void, delayMs: number) => {
        scheduled.push({ fn, delayMs })
        return scheduled.length - 1
      },
      clearScheduled: (id: number) => {
        scheduled[id] = { fn: () => {}, delayMs: -1 }
      },
      now: () => nowMs,
    })
    const activeTimers = () => scheduled.filter((s) => s.delayMs >= 0)
    return {
      onEscalate,
      scheduled,
      esc,
      activeTimers,
      cancel: () => { cancelled = true },
      setSeeking: (v: boolean) => { seeking = v },
      /** Advance the playhead AND the wall clock, then report progress. */
      play: (secs: number) => {
        currentTime += secs
        nowMs += secs * 1000
        esc.onProgress()
      },
      wait: (ms: number) => { nowMs += ms },
      /** Fire the most recently scheduled still-active timer (consuming it,
       *  as a real timeout would). */
      fireLast: () => {
        const active = activeTimers()
        const entry = active[active.length - 1]
        const fn = entry.fn
        entry.delayMs = -1
        fn()
      },
      /** Produce one CONFIRMED stall episode (playback must have begun). */
      confirmedEpisode: () => {
        esc.onStall()
        nowMs += ESCALATE_CONFIRM_MS
        const active = activeTimers()
        const entry = active[active.length - 1]
        const fn = entry.fn
        entry.delayMs = -1
        fn() // playhead unchanged → counts
      },
      /** ≥5 s of continuous progress to close the open episode. */
      closeEpisode: () => {
        currentTime += 1; nowMs += 1000; esc.onProgress()
        currentTime += 5; nowMs += 5000; esc.onProgress()
      },
    }
  }

  it('escalates exactly once on the second confirmed episode', () => {
    const h = harness()
    h.play(2) // playback has begun

    h.confirmedEpisode()
    expect(h.onEscalate).not.toHaveBeenCalled()
    h.closeEpisode()
    h.confirmedEpisode()

    expect(h.onEscalate).toHaveBeenCalledTimes(1)
  })

  it('ignores stalls before playback has begun', () => {
    const h = harness()

    h.esc.onStall()

    expect(h.activeTimers().length).toBe(0)
  })

  it('ignores stalls while the user is seeking', () => {
    const h = harness()
    h.play(2)
    h.setSeeking(true)

    h.esc.onStall()

    expect(h.activeTimers().length).toBe(0)
    expect(h.onEscalate).not.toHaveBeenCalled()
  })

  it('a stall that recovers before the confirm window never counts', () => {
    const h = harness()
    h.play(2)

    h.esc.onStall()
    h.play(1) // playhead advanced → confirm cleared
    h.closeEpisode()
    h.confirmedEpisode() // only the FIRST confirmed episode

    expect(h.onEscalate).not.toHaveBeenCalled()
  })

  it('repeated stall events inside one open episode count once', () => {
    const h = harness()
    h.play(2)

    h.confirmedEpisode()
    h.esc.onStall()
    h.esc.onStall()

    expect(h.activeTimers().length).toBe(0) // no new confirm timers stacked
    expect(h.onEscalate).not.toHaveBeenCalled() // still just 1 episode
  })

  it('an episode only closes after 5s of continuous progress', () => {
    const h = harness()
    h.play(2)
    h.confirmedEpisode()

    // 2s of progress is NOT enough to close the episode…
    h.play(1)
    h.play(1)
    // …so this stall is absorbed by the open episode, not counted as #2.
    h.esc.onStall()

    expect(h.onEscalate).not.toHaveBeenCalled()
  })

  it('episodes outside the rolling 120s window do not pair up', () => {
    const h = harness()
    h.play(2)

    h.confirmedEpisode()
    h.closeEpisode()
    h.wait(ESCALATE_WINDOW_MS + 1000)
    h.confirmedEpisode() // first episode expired → still only 1 in window
    expect(h.onEscalate).not.toHaveBeenCalled()

    h.closeEpisode()
    h.confirmedEpisode() // 2 within the window now
    expect(h.onEscalate).toHaveBeenCalledTimes(1)
  })

  it('disarms permanently after escalating', () => {
    const h = harness()
    h.play(2)
    h.confirmedEpisode()
    h.closeEpisode()
    h.confirmedEpisode()
    expect(h.onEscalate).toHaveBeenCalledTimes(1)

    h.closeEpisode()
    h.esc.onStall()

    expect(h.activeTimers().length).toBe(0)
    expect(h.onEscalate).toHaveBeenCalledTimes(1)
  })

  it('does nothing once cancelled', () => {
    const h = harness()
    h.play(2)
    h.esc.onStall()
    h.cancel()
    h.wait(ESCALATE_CONFIRM_MS)
    h.fireLast()

    expect(h.onEscalate).not.toHaveBeenCalled()
  })

  it('cleanup cancels a pending confirm timer', () => {
    const h = harness()
    h.play(2)
    h.esc.onStall()
    h.esc.cleanup()
    h.scheduled[h.scheduled.length - 1].fn()

    expect(h.onEscalate).not.toHaveBeenCalled()
  })
})

describe('createHlsDurationPin', () => {
  const harness = (durationSecs = 7679) => {
    let cancelled = false
    const pin = createHlsDurationPin({ durationSecs, isCancelled: () => cancelled })
    const mediaSource = { duration: Number.NaN, readyState: 'open' }
    return { pin, mediaSource, cancel: () => (cancelled = true) }
  }

  it('pins the full duration on attach (fresh MediaSource reports NaN)', () => {
    const h = harness()
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })

    expect(h.mediaSource.duration).toBe(7679)
  })

  it('re-asserts the pin while the playlist is still growing (live details)', () => {
    const h = harness()
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })
    // Something (an hls.js code path) shrank it back to the playlist extent.
    h.mediaSource.duration = 92
    h.pin.onLevelUpdated(undefined, { details: { live: true } })

    expect(h.mediaSource.duration).toBe(7679)
  })

  it('stops asserting once ENDLIST lands (live=false) — the muxed total wins', () => {
    const h = harness()
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })
    h.mediaSource.duration = 7675.4 // endOfStream() snapped to the real total
    h.pin.onLevelUpdated(undefined, { details: { live: false } })

    expect(h.mediaSource.duration).toBe(7675.4)
  })

  it('never shrinks a duration that already exceeds the probe estimate', () => {
    const h = harness(7679)
    h.mediaSource.duration = 7700
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })

    expect(h.mediaSource.duration).toBe(7700)
  })

  it('leaves a non-open MediaSource alone (setting duration would throw)', () => {
    const h = harness()
    h.mediaSource.readyState = 'ended'
    h.mediaSource.duration = 7675.4
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })

    expect(h.mediaSource.duration).toBe(7675.4)
  })

  it('swallows a mid-append InvalidStateError and retries on the next refresh', () => {
    const h = harness()
    let blocked = true
    let value = Number.NaN
    const throwing = {
      readyState: 'open',
      get duration() {
        return value
      },
      set duration(v: number) {
        if (blocked) throw new Error('InvalidStateError: SourceBuffer updating')
        value = v
      },
    }
    h.pin.onMediaAttached(undefined, { mediaSource: throwing })
    expect(Number.isNaN(throwing.duration)).toBe(true)

    blocked = false
    h.pin.onLevelUpdated(undefined, { details: { live: true } })
    expect(throwing.duration).toBe(7679)
  })

  it('does nothing once cancelled or without a MediaSource handle', () => {
    const h = harness()
    h.pin.onLevelUpdated(undefined, { details: { live: true } }) // no attach yet
    h.cancel()
    h.pin.onMediaAttached(undefined, { mediaSource: h.mediaSource })

    expect(Number.isNaN(h.mediaSource.duration)).toBe(true)
  })
})
