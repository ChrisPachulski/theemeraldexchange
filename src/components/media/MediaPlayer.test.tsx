import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MediaPlayer, MediaPlayerView, type MediaPlayerViewProps } from './MediaPlayer'
import type { StreamGrant } from '../../lib/api/iptv'

// Static-markup coverage of every MediaPlayer UI state (the node vitest env
// has no DOM to mount effects in). The grant/heartbeat/stop/404 LIFECYCLE the
// stateful component drives is unit-tested in ./playbackSession.test.ts at
// the api-client boundary; these tests pin what the user actually sees in
// each state, including the re-grant-able session-lost error.

vi.mock('../../lib/hooks/useMediaLibrary', () => ({
  useReportWatch: () => vi.fn(),
}))

const noop = () => {}

function viewProps(overrides: Partial<MediaPlayerViewProps> = {}): MediaPlayerViewProps {
  return {
    title: 'Severance — S01E02 · Half Loop',
    error: null,
    sessionLost: false,
    streamGrant: null,
    onClose: noop,
    onRetry: noop,
    onPositionUpdate: noop,
    onEnded: noop,
    ...overrides,
  }
}

function hlsStreamGrant(): StreamGrant {
  return {
    delivery: 'hls',
    url: 'https://api.example/api/transcode/abc/index.m3u8?t=tok',
    mime: 'application/vnd.apple.mpegurl',
  }
}

function progressiveStreamGrant(): StreamGrant {
  return {
    delivery: 'progressive',
    url: 'https://api.example/api/media/stream/9?t=tok',
    mime: 'video/mp4',
  }
}

describe('MediaPlayerView', () => {
  it('renders a labelled modal dialog with the a11y wiring useModalA11y needs', () => {
    const html = renderToStaticMarkup(<MediaPlayerView {...viewProps()} />)

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Severance — S01E02 · Half Loop"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-label="Close player"')
  })

  it('shows the starting state before a grant arrives', () => {
    const html = renderToStaticMarkup(<MediaPlayerView {...viewProps()} />)

    expect(html).toContain('Starting playback…')
    expect(html).not.toContain('<video')
  })

  it('surfaces a grant failure without a player or a retry button', () => {
    const html = renderToStaticMarkup(
      <MediaPlayerView {...viewProps({ error: 'Media /playback/movie/9 failed (503)' })} />,
    )

    expect(html).toContain('Media /playback/movie/9 failed (503)')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('Play again')
  })

  it('offers a re-grant button when the transcoder reaped the session', () => {
    const html = renderToStaticMarkup(
      <MediaPlayerView
        {...viewProps({
          error: 'Playback session expired — the transcoder shut it down.',
          sessionLost: true,
        })}
      />,
    )

    expect(html).toContain('Playback session expired')
    expect(html).toContain('Play again')
    expect(html).not.toContain('<video')
  })

  it('direct-play grants load the file into the native <video> with the resume seek', () => {
    const html = renderToStaticMarkup(
      <MediaPlayerView
        {...viewProps({ streamGrant: progressiveStreamGrant(), startPositionSecs: 300 })}
      />,
    )

    // The progressive path sets the <video> src directly (native playback).
    expect(html).toContain(`src="${progressiveStreamGrant().url.replace(/&/g, '&amp;')}"`)
  })

  it('HLS grants leave the <video> src to the hls.js engine (no native source)', () => {
    const html = renderToStaticMarkup(
      <MediaPlayerView {...viewProps({ streamGrant: hlsStreamGrant(), startPositionSecs: 300 })} />,
    )

    expect(html).toContain('<video')
    expect(html).not.toContain('src=')
  })

  it('asks resume-or-start-over (with the formatted offset) before anything plays', () => {
    const html = renderToStaticMarkup(
      <MediaPlayerView {...viewProps({ resumePromptSecs: 13 * 60 + 24 })} />,
    )

    expect(html).toContain('Resume from 13:24')
    expect(html).toContain('Start from beginning')
    expect(html).not.toContain('Starting playback…')
    expect(html).not.toContain('<video')
  })

  it('never shows the prompt once a grant is live or after an error', () => {
    const playing = renderToStaticMarkup(
      <MediaPlayerView
        {...viewProps({ resumePromptSecs: 60, streamGrant: hlsStreamGrant() })}
      />,
    )
    expect(playing).not.toContain('Start from beginning')

    const failed = renderToStaticMarkup(
      <MediaPlayerView {...viewProps({ resumePromptSecs: 60, error: 'boom' })} />,
    )
    expect(failed).not.toContain('Start from beginning')
  })
})

describe('MediaPlayer', () => {
  it('renders the starting state as a labelled dialog before any grant resolves', () => {
    const html = renderToStaticMarkup(
      <MediaPlayer kind="movie" id={9} title="300" onClose={noop} />,
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="300"')
    expect(html).toContain('Starting playback…')
  })

  it('gates a resumable title behind the prompt — no session until a choice', () => {
    const html = renderToStaticMarkup(
      <MediaPlayer kind="movie" id={9} title="300" startPositionSecs={772} onClose={noop} />,
    )

    expect(html).toContain('Resume from 12:52')
    expect(html).toContain('Start from beginning')
    expect(html).not.toContain('Starting playback…')
  })
})
