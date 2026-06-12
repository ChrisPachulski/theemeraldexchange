/* eslint-disable react-refresh/only-export-components -- exports the pure
   seek-resolution helper alongside the component so the node vitest env can
   drive it directly; fast-refresh is irrelevant for a pure function. */
import { useEffect, useRef, useState } from 'react'
import { formatPlaybackTime } from './playbackSession'
import './MediaControls.css'

// ── Why an app-drawn control bar ─────────────────────────────────────
//
// A resumed HLS session is served from ffmpeg -ss, so the MEDIA timeline the
// <video> exposes is session-relative: it starts at 0:00 no matter where in
// the title the session begins. Native browser controls render that media
// timeline and nothing can re-label them. The one hls.js mechanism that can
// shift the media timeline itself (`timelineOffset`) is broken on the growing
// EVENT playlists these sessions serve — its live code paths mix offset and
// playlist coordinates (startPosition below the offset is discarded to a
// live-edge start, a startPosition at the offset is double-shifted, and
// synchronizeToLiveEdge refuses playback behind the live-sync point), which
// produced the resume-to-black-screen failure. Lab- and production-verified;
// do not reintroduce it.
//
// So the player does what every transcoding frontend does: the session stays
// 0-based and THIS bar presents absolute title time (offset + currentTime).
// Scrubbing below the session's start has no media in this session at all —
// it hands the target back to the owner, which re-grants the session at the
// new position (the same machinery the stall escalator uses).

/** Map a scrubber commit (absolute title secs) onto the session: an element
 *  seek when the session has the media, a re-grant when it's before the
 *  session's -ss floor. */
export function resolveSeekTarget(args: {
  targetSecs: number
  offsetSecs: number
}): { kind: 'element'; sessionSecs: number } | { kind: 'regrant'; targetSecs: number } {
  const target = Math.max(0, args.targetSecs)
  if (target < args.offsetSecs) {
    return { kind: 'regrant', targetSecs: Math.floor(target) }
  }
  return { kind: 'element', sessionSecs: target - args.offsetSecs }
}

type Props = {
  video: HTMLVideoElement
  /** Title time where the session's media 0 sits (the -ss offset). 0 for
   *  fresh starts and progressive (direct-play) sessions. */
  offsetSecs: number
  /** Full title length for the scrubber range. Null = unknown (the scrubber
   *  falls back to the element's own duration plus the offset). */
  totalDurationSecs: number | null
  /** A scrub below the session floor — re-grant at this absolute target. */
  onSeekBelowOffset: (targetSecs: number) => void
}

export function MediaControls({ video, offsetSecs, totalDurationSecs, onSeekBelowOffset }: Props) {
  const [paused, setPaused] = useState(video.paused)
  const [muted, setMuted] = useState(video.muted)
  const [positionSecs, setPositionSecs] = useState(offsetSecs + video.currentTime)
  const [elementDurationSecs, setElementDurationSecs] = useState<number | null>(
    Number.isFinite(video.duration) ? video.duration : null,
  )
  const [fullscreen, setFullscreen] = useState(false)
  // While dragging, the scrubber shows the drag target, not the playhead.
  const [dragSecs, setDragSecs] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  // Ref twin of the element prop: the handlers below drive the element
  // imperatively (seek/mute/play), which the immutability lint only permits
  // through a ref.
  const videoElRef = useRef(video)
  useEffect(() => {
    videoElRef.current = video
  }, [video])

  useEffect(() => {
    const onPlayPause = () => setPaused(video.paused)
    const onVolumeChange = () => setMuted(video.muted)
    const onTimeUpdate = () => setPositionSecs(offsetSecs + video.currentTime)
    const onDurationChange = () =>
      setElementDurationSecs(Number.isFinite(video.duration) ? video.duration : null)
    // Click-to-toggle on the picture itself — the affordance the native bar
    // provided and users expect.
    const onClick = () => {
      if (video.paused) void video.play().catch(() => undefined)
      else video.pause()
    }
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement != null)
    video.addEventListener('play', onPlayPause)
    video.addEventListener('pause', onPlayPause)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('seeked', onTimeUpdate)
    video.addEventListener('durationchange', onDurationChange)
    video.addEventListener('click', onClick)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // Sync once on bind: the element may already be mid-flight.
    onPlayPause()
    onVolumeChange()
    onTimeUpdate()
    onDurationChange()
    return () => {
      video.removeEventListener('play', onPlayPause)
      video.removeEventListener('pause', onPlayPause)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('seeked', onTimeUpdate)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('click', onClick)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [video, offsetSecs])

  const totalSecs =
    totalDurationSecs ?? (elementDurationSecs != null ? offsetSecs + elementDurationSecs : null)

  const commitSeek = (targetSecs: number) => {
    const resolved = resolveSeekTarget({ targetSecs, offsetSecs })
    if (resolved.kind === 'regrant') {
      onSeekBelowOffset(resolved.targetSecs)
    } else {
      videoElRef.current.currentTime = resolved.sessionSecs
    }
  }

  const togglePlay = () => {
    const el = videoElRef.current
    if (el.paused) void el.play().catch(() => undefined)
    else el.pause()
  }
  const toggleMute = () => {
    const el = videoElRef.current
    el.muted = !el.muted
  }
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    // Fullscreen the whole player surface (modal) so this bar rides along;
    // fall back to the bare element if the player ever renders bare.
    const el = videoElRef.current
    const surface = el.closest('.iptv-player-modal') ?? el
    void surface.requestFullscreen().catch(() => undefined)
  }

  const shownSecs = dragSecs ?? positionSecs

  return (
    <div className="media-controls" role="group" aria-label="Playback controls">
      <button
        className="media-controls__button"
        type="button"
        onClick={togglePlay}
        aria-label={paused ? 'Play' : 'Pause'}
      >
        {paused ? '▶' : '❚❚'}
      </button>
      <span className="media-controls__time" aria-label="Playback position">
        {formatPlaybackTime(shownSecs)}
        <span className="media-controls__time-total">
          {' / '}
          {totalSecs != null ? formatPlaybackTime(totalSecs) : '--:--'}
        </span>
      </span>
      <input
        className="media-controls__scrubber"
        type="range"
        min={0}
        max={totalSecs != null ? Math.ceil(totalSecs) : 1}
        step={1}
        value={Math.min(Math.floor(shownSecs), totalSecs != null ? Math.ceil(totalSecs) : 1)}
        disabled={totalSecs == null}
        aria-label="Seek"
        onChange={(e) => {
          const v = Number(e.target.value)
          // Keyboard (arrow-key) seeks arrive as lone change events with no
          // pointer drag in flight — commit those immediately.
          if (dragRef.current == null) {
            commitSeek(v)
          } else {
            dragRef.current = v
            setDragSecs(v)
          }
        }}
        onPointerDown={() => {
          dragRef.current = Math.floor(shownSecs)
          setDragSecs(dragRef.current)
        }}
        onPointerUp={() => {
          const target = dragRef.current
          dragRef.current = null
          setDragSecs(null)
          if (target != null) commitSeek(target)
        }}
      />
      <button
        className="media-controls__button"
        type="button"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <button
        className="media-controls__button"
        type="button"
        onClick={toggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        ⤢
      </button>
    </div>
  )
}

export default MediaControls
