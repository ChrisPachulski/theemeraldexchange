// @vitest-environment jsdom
//
// Mounted-DOM tests for IptvPlayer's hls.js engine wiring. The pure handler
// (createFatalHlsErrorHandler) is unit-tested in IptvPlayer.test.tsx; this
// file mounts the real component with a mocked hls.js module and fires
// synthetic Hls.Events.ERROR events to prove the component actually ROUTES
// fatal errors into the recovery ladder — recoverMediaError → swapAudioCodec
// +recoverMediaError → destroy + visible error — bounded, with the message
// rendered where the user can see it. (The 5.1-AAC grey-box incident was
// exactly this path: a persistent MSE append rejection that needed a bounded
// escalation instead of an infinite recoverMediaError loop.)

import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import IptvPlayer from './IptvPlayer'
import type { StreamGrant } from '../../lib/api/iptv'

// ── hls.js module mock ───────────────────────────────────────────────
// Structural stand-in for the parts IptvPlayer touches: statics
// (isSupported/Events/ErrorTypes), the engine methods the recovery ladder
// drives, and an `on` bus we can fire synthetic events through.

const { FakeHls, hlsInstances } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  class FakeHls {
    static isSupported = () => true
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
      SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
      ERROR: 'hlsError',
    }
    static ErrorTypes = {
      NETWORK_ERROR: 'networkError',
      MEDIA_ERROR: 'mediaError',
      OTHER_ERROR: 'otherError',
    }

    audioTracks: Array<{ name?: string; lang?: string }> = []
    subtitleTracks: Array<{ name?: string; lang?: string }> = []
    audioTrack = -1
    subtitleTrack = -1

    loadSource = vi.fn()
    attachMedia = vi.fn()
    startLoad = vi.fn()
    recoverMediaError = vi.fn()
    swapAudioCodec = vi.fn()
    destroy = vi.fn()

    private handlers = new Map<string, Handler[]>()
    on(event: string, handler: Handler) {
      const list = this.handlers.get(event) ?? []
      list.push(handler)
      this.handlers.set(event, list)
    }
    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(event, ...args)
    }

    constructor() {
      hlsInstances.push(this)
    }
  }
  return { FakeHls, hlsInstances: [] as InstanceType<typeof FakeHls>[] }
})

vi.mock('hls.js', () => ({ default: FakeHls }))

function hlsGrant(): StreamGrant {
  return {
    delivery: 'hls',
    url: '/api/transcode/session/abc/index.m3u8?t=tok',
    mime: 'application/vnd.apple.mpegurl',
  }
}

beforeAll(() => {
  // jsdom has no media pipeline: canPlayType must report "can't play HLS
  // natively" so the component takes the hls.js branch (like Chrome), and
  // play/pause/load must not hit jsdom's not-implemented stubs.
  Object.defineProperty(HTMLMediaElement.prototype, 'canPlayType', {
    configurable: true,
    writable: true,
    value: () => '',
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(() => Promise.resolve()),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  cleanup()
  hlsInstances.length = 0
  vi.useRealTimers()
})

/** Mount the player and wait for the async hls.js setup (dynamic import) to
 *  construct the engine. Returns the live FakeHls instance. */
async function mountHlsPlayer() {
  const utils = render(<IptvPlayer grant={hlsGrant()} />)
  await waitFor(() => expect(hlsInstances).toHaveLength(1))
  return { ...utils, hls: hlsInstances[0] }
}

function fatalError(type: string) {
  return { fatal: true, type }
}

describe('IptvPlayer (mounted) — hls.js engine wiring', () => {
  it('loads the grant URL into hls.js and attaches the <video> element', async () => {
    const { hls } = await mountHlsPlayer()

    expect(hls.loadSource).toHaveBeenCalledWith(hlsGrant().url)
    expect(hls.attachMedia).toHaveBeenCalledWith(screen.getByTestId('iptv-player-video'))
  })

  it('destroys the engine on unmount', async () => {
    const { hls, unmount } = await mountHlsPlayer()

    unmount()

    expect(hls.destroy).toHaveBeenCalledTimes(1)
  })

  it('ignores non-fatal errors entirely', async () => {
    const { hls } = await mountHlsPlayer()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, { fatal: false, type: FakeHls.ErrorTypes.MEDIA_ERROR })
    })

    expect(hls.recoverMediaError).not.toHaveBeenCalled()
    expect(hls.destroy).not.toHaveBeenCalled()
    expect(screen.queryByText(/Playback failed/)).not.toBeInTheDocument()
  })
})

describe('IptvPlayer (mounted) — MEDIA_ERROR recovery ladder', () => {
  it('first fatal media error → recoverMediaError() only, player still alive', async () => {
    const { hls } = await mountHlsPlayer()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
    })

    expect(hls.recoverMediaError).toHaveBeenCalledTimes(1)
    expect(hls.swapAudioCodec).not.toHaveBeenCalled()
    expect(hls.destroy).not.toHaveBeenCalled()
    expect(screen.queryByText(/Playback failed/)).not.toBeInTheDocument()
  })

  it('second fatal media error inside the window → swapAudioCodec() + recoverMediaError()', async () => {
    const { hls } = await mountHlsPlayer()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
    })

    expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1)
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2)
    expect(hls.destroy).not.toHaveBeenCalled()
    expect(screen.queryByText(/Playback failed/)).not.toBeInTheDocument()
  })

  it('third fatal media error → bounded give-up: destroy + a VISIBLE error, no recovery loop', async () => {
    const { hls } = await mountHlsPlayer()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.MEDIA_ERROR))
    })

    expect(hls.destroy).toHaveBeenCalledTimes(1)
    // The escalation is bounded: exactly two recovery attempts, then stop.
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2)
    expect(hls.swapAudioCodec).toHaveBeenCalledTimes(1)
    // The user sees a real message instead of a frozen grey box.
    expect(
      screen.getByText('Playback failed — this stream couldn’t be decoded. Close and re-open to retry.'),
    ).toBeInTheDocument()
  })

  it('fatal errors of unknown type destroy immediately with a visible message', async () => {
    const { hls } = await mountHlsPlayer()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.OTHER_ERROR))
    })

    expect(hls.destroy).toHaveBeenCalledTimes(1)
    expect(hls.recoverMediaError).not.toHaveBeenCalled()
    expect(screen.getByText('Playback failed.')).toBeInTheDocument()
  })
})

describe('IptvPlayer (mounted) — NETWORK_ERROR retry', () => {
  it('fatal network error schedules a backed-off startLoad() instead of dying', async () => {
    const { hls } = await mountHlsPlayer()
    // Fake timers AFTER setup so the dynamic import resolved on real timers;
    // the handler grabs window.setTimeout lazily, so it picks up the fake.
    vi.useFakeTimers()

    act(() => {
      hls.emit(FakeHls.Events.ERROR, fatalError(FakeHls.ErrorTypes.NETWORK_ERROR))
    })
    expect(hls.startLoad).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(hls.startLoad).toHaveBeenCalledTimes(1)
    expect(hls.destroy).not.toHaveBeenCalled()
    expect(screen.queryByText(/Couldn’t start playback/)).not.toBeInTheDocument()
  })
})
