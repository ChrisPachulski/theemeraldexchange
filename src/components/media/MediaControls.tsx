/* eslint-disable react-refresh/only-export-components -- exports the pure
   seek-resolution helper alongside the component so the node vitest env can
   drive it directly; fast-refresh is irrelevant for a pure function. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { formatPlaybackTime } from './playbackSession'
import './MediaControls.css'

// Inline control icons — currentColor, matched to the app's SVG idiom
// (ReplayButton): 24-unit viewBox, round caps/joins, ~1.6 stroke. aria-hidden;
// each button carries its own label. Replaces the unicode/emoji glyphs that
// read as default-OS chrome rather than part of the emerald system.
function PlayIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.52.86l10.5-6.5a1 1 0 0 0 0-1.72L9.52 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
    </svg>
  )
}
function PauseIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" />
    </svg>
  )
}
function VolumeOnIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3l4.4-3.5a.6.6 0 0 1 1 .47v11.06a.6.6 0 0 1-1 .47L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none" />
      <path d="M16 9a4 4 0 0 1 0 6" />
      <path d="M18.6 6.6a7.5 7.5 0 0 1 0 10.8" />
    </svg>
  )
}
function VolumeOffIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3l4.4-3.5a.6.6 0 0 1 1 .47v11.06a.6.6 0 0 1-1 .47L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" fill="currentColor" stroke="none" />
      <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" />
    </svg>
  )
}
function FullscreenEnterIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M20 9V5.5A1.5 1.5 0 0 0 18.5 4H15M4 15v3.5A1.5 1.5 0 0 0 5.5 20H9M20 15v3.5A1.5 1.5 0 0 1 18.5 20H15" />
    </svg>
  )
}
function FullscreenExitIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 4v3A1.5 1.5 0 0 1 7 8.5H4M15.5 4v3A1.5 1.5 0 0 0 17 8.5h3M8.5 20v-3A1.5 1.5 0 0 0 7 15.5H4M15.5 20v-3a1.5 1.5 0 0 1 1.5-1.5h3" />
    </svg>
  )
}

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
// A forward seek that lands within this many seconds of the produced edge is
// still an element seek — the encoder is about to reach it, so a brief buffer
// wait beats tearing down and re-granting the whole session.
const SEEK_REGRANT_EPSILON_SECS = 5

export function resolveSeekTarget(args: {
  targetSecs: number
  offsetSecs: number
  /** Session-relative end of what the transcoder has PRODUCED so far (the
   *  growing EVENT playlist's edge). A forward seek past it can't be served by
   *  an element seek — the segments don't exist yet — so it re-grants instead.
   *  Omitted/null means "edge unknown" → behave as a plain in-session seek. */
  seekableEndSecs?: number | null
}): { kind: 'element'; sessionSecs: number } | { kind: 'regrant'; targetSecs: number } {
  const target = Math.max(0, args.targetSecs)
  if (target < args.offsetSecs) {
    return { kind: 'regrant', targetSecs: Math.floor(target) }
  }
  const sessionSecs = target - args.offsetSecs
  // Forward past the produced edge: an element seek would stall or snap back
  // (hls.js has no segment there), so re-grant a fresh session at the target —
  // the same machinery as a below-floor back-seek (server bakes -ss).
  const edge = args.seekableEndSecs
  if (edge != null && Number.isFinite(edge) && sessionSecs > edge + SEEK_REGRANT_EPSILON_SECS) {
    return { kind: 'regrant', targetSecs: Math.floor(target) }
  }
  return { kind: 'element', sessionSecs }
}

type Props = {
  video: HTMLVideoElement
  /** Title time where the session's media 0 sits (the -ss offset). 0 for
   *  fresh starts and progressive (direct-play) sessions. */
  offsetSecs: number
  /** Full title length for the scrubber range. Null = unknown (the scrubber
   *  falls back to the element's own duration plus the offset). */
  totalDurationSecs: number | null
  /** Session-relative produced edge (HLS sessions only) so a forward seek past
   *  what ffmpeg has transcoded re-grants instead of dying. Null/undefined for
   *  progressive direct play (the whole file is already seekable). */
  seekableEndSecs?: number | null
  /** A scrub outside the session's produced range (below the -ss floor, or
   *  forward past the produced edge) — re-grant at this absolute target. */
  onSeekBelowOffset: (targetSecs: number) => void
}

export function MediaControls({
  video,
  offsetSecs,
  totalDurationSecs,
  seekableEndSecs,
  onSeekBelowOffset,
}: Props) {
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
    const resolved = resolveSeekTarget({ targetSecs, offsetSecs, seekableEndSecs })
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
  // Drives the scrubber's emerald fill (left of the thumb) via a CSS variable —
  // a controlled <input type=range> can't paint its own progress in WebKit, so
  // the track gradient reads --progress.
  const progressPct =
    totalSecs != null && totalSecs > 0
      ? Math.min(100, Math.max(0, (shownSecs / totalSecs) * 100))
      : 0

  return (
    <div className="media-controls" role="group" aria-label="Playback controls">
      <button
        className="media-controls__button media-controls__button--primary"
        type="button"
        onClick={togglePlay}
        aria-label={paused ? 'Play' : 'Pause'}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
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
        style={{ '--progress': `${progressPct}%` } as CSSProperties}
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
        {muted ? <VolumeOffIcon /> : <VolumeOnIcon />}
      </button>
      <button
        className="media-controls__button"
        type="button"
        onClick={toggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        {fullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
      </button>
    </div>
  )
}

export default MediaControls
