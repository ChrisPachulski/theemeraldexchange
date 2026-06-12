// @vitest-environment jsdom
//
// Mounted-DOM tests for the stateful MediaPlayer. The static-markup suite
// (MediaPlayer.test.tsx) pins what every UI state LOOKS like, and
// playbackSession.test.ts pins the grant/heartbeat/stop controller in
// isolation — this file mounts the real component (jsdom, per-file override
// of the node default) and proves the two are actually WIRED together:
// grant → engine render, grant failure → readable error, heartbeat 404 →
// teardown + "Play again" re-grant, unmount/pagehide → mediaApi.stop. This
// surface has four historical production incidents behind it; the lifecycle
// wiring is exactly what static markup could not cover.

import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaPlayer } from './MediaPlayer'
import { HEARTBEAT_INTERVAL_MS } from './playbackSession'
import type { PlaybackGrant } from '../../lib/api/media'

const { playbackMock, heartbeatMock, stopMock, flushWatchMock, reportMock, engineProps } = vi.hoisted(() => ({
  playbackMock: vi.fn(),
  heartbeatMock: vi.fn(),
  stopMock: vi.fn(),
  flushWatchMock: vi.fn(),
  reportMock: vi.fn(),
  engineProps: {
    current: null as null | {
      grant: { url: string; delivery: string }
      onPositionUpdate?: (positionSecs: number, durationSecs: number | null) => void
      onDeliveryStruggling?: () => void
    },
  },
}))

// Module-boundary mocks: the api client (network) and the watch-progress
// hook (react-query). IptvPlayer is stubbed too — the engine wiring has its
// own mounted suite (../player/IptvPlayer.dom.test.tsx); here we only need
// the grant the player was handed plus its onPositionUpdate callback (so the
// final-flush tests can place a known position into the player's ref).
vi.mock('../../lib/api/media', () => ({
  mediaApi: {
    playback: playbackMock,
    heartbeat: heartbeatMock,
    stop: stopMock,
    flushWatch: flushWatchMock,
  },
}))
vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useReportWatch: () => reportMock,
}))
vi.mock('../player/IptvPlayer', () => ({
  default: (props: {
    grant: { url: string; delivery: string }
    onPositionUpdate?: (positionSecs: number, durationSecs: number | null) => void
    onDeliveryStruggling?: () => void
  }) => {
    engineProps.current = props
    return (
      <div data-testid="player-engine" data-delivery={props.grant.delivery} data-url={props.grant.url} />
    )
  },
}))

function hlsGrant(overrides: Partial<PlaybackGrant> = {}): PlaybackGrant {
  return {
    delivery: 'hls',
    url: 'https://api.example/api/transcode/session/abc/index.m3u8?t=tok',
    durationSecs: 5400,
    heartbeatUrl: 'https://api.example/api/transcode/session/abc/heartbeat?t=tok',
    stopUrl: 'https://api.example/api/transcode/session/abc/stop?t=tok',
    sessionId: 'abc',
    ...overrides,
  }
}

function progressiveGrant(): PlaybackGrant {
  return {
    delivery: 'progressive',
    url: 'https://api.example/api/media/stream/movie/9?t=tok',
    durationSecs: 7200,
    heartbeatUrl: null,
    stopUrl: null,
  }
}

/** Flush the microtask queue so a resolved grant promise commits its state. */
async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  playbackMock.mockReset()
  heartbeatMock.mockReset()
  stopMock.mockReset()
  flushWatchMock.mockReset()
  reportMock.mockReset()
  engineProps.current = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MediaPlayer (mounted) — grant flow', () => {
  it('requests a grant on mount and renders the engine with the granted URL', async () => {
    const grant = progressiveGrant()
    playbackMock.mockResolvedValue(grant)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)

    // Pre-grant: the starting state, no engine yet.
    expect(screen.getByText('Starting playback…')).toBeInTheDocument()
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()

    await flush()

    expect(playbackMock).toHaveBeenCalledTimes(1)
    expect(playbackMock).toHaveBeenCalledWith('movie', 9, undefined, undefined, false)
    const engine = screen.getByTestId('player-engine')
    expect(engine).toHaveAttribute('data-url', grant.url)
    expect(engine).toHaveAttribute('data-delivery', 'progressive')
    expect(screen.queryByText('Starting playback…')).not.toBeInTheDocument()
  })

  it('gates a resumable title behind the prompt, then forwards the chosen offset', async () => {
    playbackMock.mockResolvedValue(hlsGrant())

    render(<MediaPlayer kind="episode" id={42} title="S01E07" startPositionSecs={300} onClose={() => {}} />)
    await flush()

    // Nothing plays until the user picks resume-or-start-over.
    expect(playbackMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resume from 5:00' }))
    await flush()

    expect(playbackMock).toHaveBeenCalledWith('episode', 42, undefined, 300, false)
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
  })

  it('start-from-beginning grants a fresh session with no offset', async () => {
    playbackMock.mockResolvedValue(hlsGrant())

    render(<MediaPlayer kind="episode" id={42} title="S01E07" startPositionSecs={300} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start from beginning' }))
    await flush()

    expect(playbackMock).toHaveBeenCalledWith('episode', 42, undefined, undefined, false)
  })

  it('escalates once: onDeliveryStruggling re-grants with forceHls at the captured position', async () => {
    // Progressive grant first; the escalated re-grant returns HLS.
    playbackMock
      .mockResolvedValueOnce(progressiveGrant())
      .mockResolvedValueOnce(hlsGrant())

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()
    expect(screen.getByTestId('player-engine')).toHaveAttribute('data-delivery', 'progressive')

    // The player reports the playhead, then the escalator fires.
    act(() => {
      engineProps.current?.onPositionUpdate?.(612.7, 7200)
      engineProps.current?.onDeliveryStruggling?.()
    })
    // Mid-swap: engine torn down, starting state shown.
    expect(screen.getByText('Starting playback…')).toBeInTheDocument()
    await flush()

    expect(playbackMock).toHaveBeenCalledTimes(2)
    expect(playbackMock).toHaveBeenLastCalledWith('movie', 9, undefined, 612, true)
    expect(screen.getByTestId('player-engine')).toHaveAttribute('data-delivery', 'hls')

    // Post-escalation progress must be offset by the captured position so
    // resume points don't regress (the HLS timeline restarts at the -ss bake).
    reportMock.mockClear()
    act(() => {
      engineProps.current?.onPositionUpdate?.(10, null)
    })
    expect(reportMock).toHaveBeenCalledWith(622, 5400, false)

    // One-way and once: a second call must not re-grant again.
    act(() => {
      engineProps.current?.onDeliveryStruggling?.()
    })
    await flush()
    expect(playbackMock).toHaveBeenCalledTimes(2)
  })

  it('shows a readable error (and no engine, no retry) when the grant fails', async () => {
    playbackMock.mockRejectedValue(new Error('Media /playback/movie/9 failed (503)'))

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    expect(screen.getByText('Media /playback/movie/9 failed (503)')).toBeInTheDocument()
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()
    // A grant failure is not a reaped session — no "Play again" re-grant offer.
    expect(screen.queryByRole('button', { name: 'Play again' })).not.toBeInTheDocument()
  })
})

describe('MediaPlayer (mounted) — heartbeat 404 (reaped transcode session)', () => {
  it('tears the player down, shows the session-lost error, and stops heartbeating', async () => {
    vi.useFakeTimers()
    playbackMock.mockResolvedValue(hlsGrant())
    heartbeatMock.mockResolvedValue(404)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()

    // First heartbeat answers 404 → the transcoder reaped the session.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    })

    expect(heartbeatMock).toHaveBeenCalledTimes(1)
    expect(heartbeatMock).toHaveBeenCalledWith(hlsGrant().heartbeatUrl)
    // The stream is a corpse: engine gone, re-grant-able error in its place.
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()
    expect(screen.getByText(/Playback session expired/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play again' })).toBeInTheDocument()

    // Heartbeats stopped — no more beats against the dead session.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)
    })
    expect(heartbeatMock).toHaveBeenCalledTimes(1)
    // The stop URL points at the same dead session — it must NOT be POSTed.
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('"Play again" runs the grant flow again and restores the engine', async () => {
    vi.useFakeTimers()
    playbackMock.mockResolvedValue(hlsGrant())
    heartbeatMock.mockResolvedValue(404)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    })
    expect(screen.queryByTestId('player-engine')).not.toBeInTheDocument()

    // Re-grant: a fresh session this time, with healthy heartbeats.
    playbackMock.mockResolvedValue(hlsGrant({ sessionId: 'def' }))
    heartbeatMock.mockResolvedValue(200)
    fireEvent.click(screen.getByRole('button', { name: 'Play again' }))
    await flush()

    expect(playbackMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
    expect(screen.queryByText(/Playback session expired/)).not.toBeInTheDocument()
  })

  it('keeps beating through a transient blip (non-404 / network failure)', async () => {
    vi.useFakeTimers()
    playbackMock.mockResolvedValue(hlsGrant())
    // A 503 and a network failure (undefined) are NOT a reaped session.
    heartbeatMock.mockResolvedValueOnce(503).mockResolvedValueOnce(undefined)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    })

    expect(heartbeatMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('player-engine')).toBeInTheDocument()
    expect(screen.queryByText(/Playback session expired/)).not.toBeInTheDocument()
  })
})

describe('MediaPlayer (mounted) — stop lifecycle', () => {
  it('frees the transcoder slot on unmount (mediaApi.stop with the grant stopUrl)', async () => {
    const grant = hlsGrant()
    playbackMock.mockResolvedValue(grant)
    heartbeatMock.mockResolvedValue(200)

    const { unmount } = render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()
    expect(stopMock).not.toHaveBeenCalled()

    unmount()

    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith(grant.stopUrl)
  })

  it('frees the transcoder slot on pagehide (hard tab close skips React cleanup)', async () => {
    const grant = hlsGrant()
    playbackMock.mockResolvedValue(grant)
    heartbeatMock.mockResolvedValue(200)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    fireEvent(window, new Event('pagehide'))

    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith(grant.stopUrl)
  })

  it('pagehide flushes the final watch position via keepalive before stopping the session', async () => {
    playbackMock.mockResolvedValue(progressiveGrant())

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    // Drive a position through the engine so the player's latest-position
    // ref holds a real resume point (progressive: absolute = reported).
    act(() => engineProps.current?.onPositionUpdate?.(540, 7200))

    fireEvent(window, new Event('pagehide'))

    expect(flushWatchMock).toHaveBeenCalledTimes(1)
    expect(flushWatchMock).toHaveBeenCalledWith({
      kind: 'movie',
      id: 9,
      positionSecs: 540,
      durationSecs: 7200,
      completed: false,
    })
  })

  it('pagehide marks the flush completed inside the completion tail', async () => {
    playbackMock.mockResolvedValue(progressiveGrant())

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    act(() => engineProps.current?.onPositionUpdate?.(7195, 7200))
    fireEvent(window, new Event('pagehide'))

    expect(flushWatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ completed: true }),
    )
  })

  it('pagehide does not flush when nothing has played yet (position 0)', async () => {
    playbackMock.mockResolvedValue(progressiveGrant())

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    fireEvent(window, new Event('pagehide'))

    expect(flushWatchMock).not.toHaveBeenCalled()
  })

  it('visibilitychange→hidden flushes progress but does NOT stop the session', async () => {
    const grant = hlsGrant()
    playbackMock.mockResolvedValue(grant)
    heartbeatMock.mockResolvedValue(200)

    render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    await flush()

    // HLS: the engine reports relative position; with no -ss baked here the
    // absolute position equals the reported one. The exact value matters less
    // than the contract: flush yes, stop no.
    act(() => engineProps.current?.onPositionUpdate?.(120, null))

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    })
    fireEvent(document, new Event('visibilitychange'))

    expect(flushWatchMock).toHaveBeenCalledTimes(1)
    expect(stopMock).not.toHaveBeenCalled()

    // restore for other tests
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('stops a grant that resolves after close instead of leaking the slot', async () => {
    const grant = hlsGrant()
    let resolveGrant: (g: PlaybackGrant) => void = () => {}
    playbackMock.mockReturnValue(
      new Promise<PlaybackGrant>((resolve) => {
        resolveGrant = resolve
      }),
    )

    const { unmount } = render(<MediaPlayer kind="movie" id={9} title="300" onClose={() => {}} />)
    unmount()
    resolveGrant(grant)
    await flush()

    // The session it just claimed is freed immediately (not left to the reaper).
    expect(stopMock).toHaveBeenCalledTimes(1)
    expect(stopMock).toHaveBeenCalledWith(grant.stopUrl)
  })
})
