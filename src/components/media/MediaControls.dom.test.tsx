// @vitest-environment jsdom
//
// Mounted tests for the app-drawn control bar. The bar exists because a
// resumed -ss session's MEDIA timeline starts at 0:00 — only an app bar can
// display absolute title time (hls.js's timelineOffset is broken on growing
// EVENT playlists; see MediaControls' doc block). These tests pin the two
// behaviors that make the bar correct: the offset arithmetic on display and
// the seek split (element seek in-session, re-grant below the floor).

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaControls } from './MediaControls'

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
