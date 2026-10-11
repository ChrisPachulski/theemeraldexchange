// @vitest-environment jsdom
//
// Mounted tests for the app-drawn control bar. The bar exists because a
// resumed -ss session's MEDIA timeline starts at 0:00 — only an app bar can
// display absolute title time (hls.js's timelineOffset is broken on growing
// EVENT playlists; see MediaControls' doc block). These tests pin the two
// behaviors that make the bar correct: the offset arithmetic on display and
// the seek split (element seek in-session, re-grant below the floor).

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaControls } from './MediaControls'
import type { MediaEpisode } from '../../lib/api/media'
import { setPlaybackPrefs, showTrackMemory } from '../../lib/playbackPrefs'

afterEach(cleanup)

function makeVideo(): HTMLVideoElement {
  const video = document.createElement('video')
  // jsdom's play() is unimplemented (no media pipeline); stub the promise API.
  Object.defineProperty(video, 'play', { value: vi.fn(() => Promise.resolve()) })
  document.body.appendChild(video)
  return video
}

describe('MediaControls', () => {
  it('displays absolute title time: offset + element position', () => {
    const video = makeVideo()
    video.currentTime = 42
    render(
      <MediaControls
        video={video}
        offsetSecs={600}
        totalDurationSecs={7200}
        onSeekBelowOffset={() => undefined}
      />,
    )

    expect(screen.getByLabelText('Playback position')).toHaveTextContent('10:42 / 2:00:00')

    video.currentTime = 100
    fireEvent(video, new Event('timeupdate'))
    expect(screen.getByLabelText('Playback position')).toHaveTextContent('11:40 / 2:00:00')
  })

  it('commits an in-session scrub as an element seek in session coordinates', () => {
    const video = makeVideo()
    const onSeekBelowOffset = vi.fn()
    render(
      <MediaControls
        video={video}
        offsetSecs={600}
        totalDurationSecs={7200}
        onSeekBelowOffset={onSeekBelowOffset}
      />,
    )

    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '700' } })

    expect(video.currentTime).toBe(100)
    expect(onSeekBelowOffset).not.toHaveBeenCalled()
  })

  it('hands a below-floor scrub to the owner for a re-grant', () => {
    const video = makeVideo()
    video.currentTime = 42
    const onSeekBelowOffset = vi.fn()
    render(
      <MediaControls
        video={video}
        offsetSecs={600}
        totalDurationSecs={7200}
        onSeekBelowOffset={onSeekBelowOffset}
      />,
    )

    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '300' } })

    expect(onSeekBelowOffset).toHaveBeenCalledExactlyOnceWith(300)
    expect(video.currentTime).toBe(42) // untouched — the re-grant remounts
  })

  it('toggles play/pause from the button and reflects element state', () => {
    const video = makeVideo()
    render(
      <MediaControls
        video={video}
        offsetSecs={0}
        totalDurationSecs={100}
        onSeekBelowOffset={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(video.play).toHaveBeenCalledOnce()

    // The element reports the transition; the button flips to Pause.
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    fireEvent(video, new Event('play'))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('toggles mute on the element', () => {
    const video = makeVideo()
    render(
      <MediaControls
        video={video}
        offsetSecs={0}
        totalDurationSecs={100}
        onSeekBelowOffset={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(video.muted).toBe(true)
    fireEvent(video, new Event('volumechange'))
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument()
  })

  it('falls back to offset + element duration when the grant has no total', () => {
    const video = makeVideo()
    Object.defineProperty(video, 'duration', { value: 90, configurable: true })
    render(
      <MediaControls
        video={video}
        offsetSecs={600}
        totalDurationSecs={null}
        onSeekBelowOffset={() => undefined}
      />,
    )

    expect(screen.getByLabelText('Playback position')).toHaveTextContent('/ 11:30')
  })
})

// ── Sidecar subtitle (CC) toggle ─────────────────────────────────────
//
// The bar owns the on/off toggle for the native sidecar <track> (forced subs
// ship on; non-forced load off). Driven entirely through video.textTracks, so
// it works on the MSE path where IptvPlayer's hls.js-first <select> can't reach
// a native track. jsdom has no real textTracks pipeline, so the list is a stub
// with mutable `mode`. NOT covered (the OWED browser proof): whether the .vtt
// cues actually paint over hls.js/MSE — that needs the cross-origin .vtt to
// load at the real edge.
type FakeTrack = { kind: string; mode: string; label?: string; language?: string }

function videoWithTracks(tracks: FakeTrack[]): HTMLVideoElement {
  const video = makeVideo()
  const list = Object.assign(
    { length: tracks.length },
    Object.fromEntries(tracks.map((t, i) => [i, t])),
  )
  Object.defineProperty(video, 'textTracks', { value: list, configurable: true })
  return video
}

function renderBar(video: HTMLVideoElement) {
  render(
    <MediaControls
      video={video}
      offsetSecs={0}
      totalDurationSecs={3600}
      onSeekBelowOffset={() => undefined}
    />,
  )
}

describe('MediaControls subtitle toggle', () => {
  it('renders no CC button when the video carries no subtitle track', () => {
    renderBar(videoWithTracks([{ kind: 'metadata', mode: 'disabled' }]))
    expect(screen.queryByRole('button', { name: /subtitles/i })).toBeNull()
  })

  it('shows an OFF CC button for a non-forced (disabled) subtitle track', () => {
    renderBar(videoWithTracks([{ kind: 'subtitles', mode: 'disabled' }]))
    expect(screen.getByRole('button', { name: 'Turn on subtitles' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('shows an ON CC button for a forced (showing) subtitle track', () => {
    renderBar(videoWithTracks([{ kind: 'subtitles', mode: 'showing' }]))
    expect(screen.getByRole('button', { name: 'Turn off subtitles' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('flips the native track mode and button state on click', () => {
    const video = videoWithTracks([{ kind: 'subtitles', mode: 'disabled' }])
    const tracks = (video as unknown as { textTracks: Record<number, FakeTrack> }).textTracks
    renderBar(video)

    fireEvent.click(screen.getByRole('button', { name: 'Turn on subtitles' }))
    expect(tracks[0].mode).toBe('showing')
    const onBtn = screen.getByRole('button', { name: 'Turn off subtitles' })
    expect(onBtn).toHaveAttribute('aria-pressed', 'true')
    expect(onBtn).toHaveClass('media-controls__button--active')

    fireEvent.click(onBtn)
    expect(tracks[0].mode).toBe('disabled')
    expect(screen.getByRole('button', { name: 'Turn on subtitles' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})

// Keyboard operability of the custom control path: the app-drawn bar replaces
// the native controls, so the conventional player keys must work while the
// player is mounted, without stealing keys from form fields or buttons.
describe('MediaControls keyboard shortcuts', () => {
  function makeKeyVideo(): HTMLVideoElement {
    const video = makeVideo()
    Object.defineProperty(video, 'pause', { value: vi.fn() })
    Object.defineProperty(video, 'requestFullscreen', {
      value: vi.fn(() => Promise.resolve()),
    })
    return video
  }

  it('Space and k toggle play/pause', () => {
    const video = makeKeyVideo()
    render(
      <MediaControls video={video} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} />,
    )
    fireEvent.keyDown(document, { key: ' ' })
    expect(video.play).toHaveBeenCalledTimes(1)
    Object.defineProperty(video, 'paused', { value: false, configurable: true })
    fireEvent.keyDown(document, { key: 'k' })
    expect(video.pause).toHaveBeenCalledTimes(1)
  })

  it('ArrowRight/ArrowLeft seek 10s in absolute title time (re-grants below the session floor)', () => {
    const video = makeKeyVideo()
    video.currentTime = 42
    const onSeekBelowOffset = vi.fn()
    render(
      <MediaControls video={video} offsetSecs={600} totalDurationSecs={7200} onSeekBelowOffset={onSeekBelowOffset} />,
    )
    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(video.currentTime).toBe(52)
    video.currentTime = 5
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(onSeekBelowOffset).toHaveBeenCalledExactlyOnceWith(595)
  })

  it('m mutes, f requests fullscreen, ArrowUp/ArrowDown step the volume', () => {
    const video = makeKeyVideo()
    render(
      <MediaControls video={video} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} />,
    )
    fireEvent.keyDown(document, { key: 'm' })
    expect(video.muted).toBe(true)
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(video.volume).toBeCloseTo(0.9)
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(video.volume).toBeCloseTo(1)
    fireEvent.keyDown(document, { key: 'f' })
    expect(video.requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('leaves keys typed into form fields and pressed on buttons alone', () => {
    const video = makeKeyVideo()
    render(
      <div>
        <input aria-label="Search" />
        <MediaControls video={video} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} />
      </div>,
    )
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: ' ' })
    fireEvent.keyDown(screen.getByLabelText('Mute'), { key: ' ' })
    expect(video.play).not.toHaveBeenCalled()
    expect(video.muted).toBe(false)
  })
})

// ── Player parity with the Apple app (skip, markers, episodes, prefs) ──
describe('MediaControls parity controls', () => {
  afterEach(() => localStorage.clear())

  const ep = (id: number, episode: number): MediaEpisode => ({
    id,
    showId: 5,
    season: 1,
    episode,
    title: `E${episode}`,
    airDate: null,
    fileId: id,
  })

  it('back 10 / forward 30 buttons seek in title time, clamped to the title', () => {
    const video = makeVideo()
    video.currentTime = 50
    render(<MediaControls video={video} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Forward 30 seconds' }))
    expect(video.currentTime).toBe(80)
    fireEvent.click(screen.getByRole('button', { name: 'Back 10 seconds' }))
    expect(video.currentTime).toBe(70)
    video.currentTime = 90
    fireEvent.click(screen.getByRole('button', { name: 'Forward 30 seconds' }))
    expect(video.currentTime).toBe(100)
  })

  it('offers Skip Intro inside the marker window and seeks to its end', () => {
    const video = makeVideo()
    video.currentTime = 5
    render(
      <MediaControls
        video={video}
        offsetSecs={0}
        totalDurationSecs={1500}
        onSeekBelowOffset={() => undefined}
        markers={[{ type: 'intro', startSecs: 0, endSecs: 20 }, { type: 'credits', startSecs: 1400, endSecs: 1500 }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Skip Intro' }))
    expect(video.currentTime).toBe(20)
    fireEvent(video, new Event('timeupdate'))
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull()
    video.currentTime = 1450
    fireEvent(video, new Event('timeupdate'))
    expect(screen.getByRole('button', { name: 'Skip Credits' })).toBeInTheDocument()
  })

  it('previous/next episode buttons follow the queue ends', () => {
    const onPick = vi.fn()
    const episodes = [ep(1, 1), ep(2, 2)]
    render(
      <MediaControls
        video={makeVideo()}
        offsetSecs={0}
        totalDurationSecs={100}
        onSeekBelowOffset={() => undefined}
        episodeNav={{ episodes, currentId: 1, prev: null, next: episodes[1], onPick }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Previous episode' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next episode' }))
    expect(onPick).toHaveBeenCalledExactlyOnceWith(episodes[1])
  })

  it('applies the persisted speed to the element and its default rate', () => {
    setPlaybackPrefs({ speed: 1.5 })
    const video = makeVideo()
    render(<MediaControls video={video} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} />)
    expect(video.playbackRate).toBe(1.5)
    expect(video.defaultPlaybackRate).toBe(1.5)
  })

  it('"Always" shows the preferred-language track, and a CC toggle-off is remembered for the show', () => {
    setPlaybackPrefs({ subtitleMode: 'always', subtitleLanguage: 'es' })
    const video = videoWithTracks([
      { kind: 'subtitles', mode: 'disabled', language: 'eng' },
      { kind: 'subtitles', mode: 'disabled', language: 'spa' },
    ])
    const tracks = (video as unknown as { textTracks: Record<number, FakeTrack> }).textTracks
    const episodes = [ep(1, 1)]
    render(
      <MediaControls
        video={video}
        offsetSecs={0}
        totalDurationSecs={100}
        onSeekBelowOffset={() => undefined}
        episodeNav={{ episodes, currentId: 1, prev: null, next: null, onPick: () => undefined }}
      />,
    )
    expect(tracks[1].mode).toBe('showing')
    expect(tracks[0].mode).toBe('disabled')

    fireEvent.click(screen.getByRole('button', { name: 'Turn off subtitles' }))
    expect(showTrackMemory(5)).toEqual({ subtitleOff: true })
  })

  it('lists embedded chapters (untitled ones numbered) and seeks through the session split', () => {
    const video = makeVideo()
    const onSeekBelowOffset = vi.fn()
    const chapters = [
      { title: 'Opening', startSecs: 0, endSecs: 300 },
      { title: null, startSecs: 1200, endSecs: 1800 },
    ]
    render(
      <MediaControls
        video={video}
        offsetSecs={600}
        totalDurationSecs={1800}
        onSeekBelowOffset={onSeekBelowOffset}
        chapters={chapters}
      />,
    )
    // The settings popover is closed (hidden) until its button opens it.
    const list = screen.getByRole('region', { name: 'Chapters', hidden: true })
    // In-session: an element seek in session coordinates.
    fireEvent.click(within(list).getByRole('button', { name: /Chapter 2\s*20:00/, hidden: true }))
    expect(video.currentTime).toBe(600)
    // Before this session's -ss floor: a re-grant at the chapter start.
    fireEvent.click(within(list).getByRole('button', { name: /Opening\s*0:00/, hidden: true }))
    expect(onSeekBelowOffset).toHaveBeenCalledWith(0)
  })

  it('shows no Chapters list when the file has none', () => {
    render(
      <MediaControls video={makeVideo()} offsetSecs={0} totalDurationSecs={100} onSeekBelowOffset={() => undefined} chapters={[]} />,
    )
    expect(screen.queryByRole('region', { name: 'Chapters', hidden: true })).toBeNull()
  })
})
