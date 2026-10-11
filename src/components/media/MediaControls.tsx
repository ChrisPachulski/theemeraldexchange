/* eslint-disable react-refresh/only-export-components -- exports the pure
   seek-resolution helper alongside the component so the node vitest env can
   drive it directly; fast-refresh is irrelevant for a pure function. */
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { formatPlaybackTime } from './playbackSession'
import { EpisodeList } from './EpisodePicker'
import { PlaybackSettingsFields } from './PlaybackSettings'
import { parseTrickplayPlaylist, thumbAt, type TrickplayThumb } from './trickplay'
import type { MediaChapter, MediaEpisode, MediaMarker } from '../../lib/api/media'
import {
  SPEED_OPTIONS,
  getPlaybackPrefs,
  rememberShowSubtitle,
  setPlaybackPrefs,
  showTrackMemory,
  startupSubtitleIndex,
  usePlaybackPrefs,
} from '../../lib/playbackPrefs'
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
function SubtitlesIcon() {
  // A captions glyph: rounded frame with two stroked "subtitle" lines. The
  // active/inactive distinction is carried by the button's --active class +
  // aria-pressed, not the icon, so one glyph serves both states.
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M7 14h5M14.5 14h2.5M7 10.5h2.5M11.5 10.5h5.5" />
    </svg>
  )
}

/** Circular skip arrow with the step in seconds (back 10 / forward 30). */
function SkipIcon({ secs, forward = false }: { secs: number; forward?: boolean }) {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {forward ? (
        <path d="M12 4.5a7.5 7.5 0 1 0 7.1 5.1M12 4.5 9.8 2.6M12 4.5 9.8 6.4" />
      ) : (
        <path d="M12 4.5a7.5 7.5 0 1 1-7.1 5.1M12 4.5l2.2-1.9M12 4.5l2.2 1.9" />
      )}
      <text x="12" y="15.4" textAnchor="middle" fontSize="7.5" fontWeight="700" fill="currentColor" stroke="none">
        {secs}
      </text>
    </svg>
  )
}
function PrevEpisodeIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="2.2" height="14" rx="1" fill="currentColor" />
      <path d="M19 6.2v11.6a1 1 0 0 1-1.55.83l-8.6-5.8a1 1 0 0 1 0-1.66l8.6-5.8A1 1 0 0 1 19 6.2Z" fill="currentColor" />
    </svg>
  )
}
function NextEpisodeIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="16.8" y="5" width="2.2" height="14" rx="1" fill="currentColor" />
      <path d="M5 6.2v11.6a1 1 0 0 0 1.55.83l8.6-5.8a1 1 0 0 0 0-1.66l-8.6-5.8A1 1 0 0 0 5 6.2Z" fill="currentColor" />
    </svg>
  )
}
function EpisodesIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" strokeWidth="1.8" />
    </svg>
  )
}
function SettingsIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  )
}
function PipIcon() {
  return (
    <svg className="media-controls__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" stroke="none" />
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
// Keyboard steps: ArrowLeft/ArrowRight seek, ArrowUp/ArrowDown volume.
const SEEK_STEP_SECS = 10
const VOLUME_STEP = 0.1
// On-screen skip buttons (Apple's tvOS chrome: back 10, forward 30).
const SEEK_BACK_SECS = 10
const SEEK_FORWARD_SECS = 30
// The seek preview requests the thumbnail where the pointer rests this long,
// not every one a fast sweep crosses (each is a fetch over the tunnel).
const PREVIEW_SETTLE_MS = 80

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

// ── Sidecar subtitle toggle ──────────────────────────────────────────
//
// Local-media transcodes ship a sidecar WebVTT as a native <track> on the
// <video> (rendered by IptvPlayer). Forced/narrative tracks auto-show
// (the <track default>); a non-forced track is LOADED but off. This bar — the
// app-drawn controls for local media — owns the on/off toggle, driven entirely
// through the NATIVE textTracks API.
//
// This deliberately sidesteps IptvPlayer's own track <select>, which is
// hls.js-first: on the MSE path it drives `hls.subtitleTrack` (in-manifest HLS
// subs) and cannot reach a native sidecar <track> at all — toggling it there is
// a no-op for local media. Reading/writing `video.textTracks[i].mode` works
// regardless of the playback engine because the sidecar <track> is a real DOM
// child of the <video>, independent of the MSE pipeline.

type TextTrackLike = { kind: string; mode: string; label?: string; language?: string }
export type TextTrackListLike = {
  length: number
  [index: number]: TextTrackLike
}
type VideoWithTextTracks = HTMLVideoElement & { textTracks?: TextTrackListLike }

// Only subtitle/caption tracks are user-toggleable here; metadata/chapters
// tracks share the textTracks list but must never be flipped to 'showing'.
const SUBTITLE_TRACK_KINDS = new Set(['subtitles', 'captions'])

/** Indexes (into the textTracks list) of the subtitle/caption tracks, in
 *  document order. Empty when there are none — the button stays hidden. */
export function subtitleTrackIndexes(tracks: TextTrackListLike | undefined | null): number[] {
  if (!tracks) return []
  const out: number[] = []
  for (let i = 0; i < tracks.length; i += 1) {
    if (SUBTITLE_TRACK_KINDS.has(tracks[i].kind)) out.push(i)
  }
  return out
}

/** Index of the subtitle track currently 'showing', or -1 when subtitles are
 *  off (a forced track ships as 'showing'; a non-forced one as 'disabled'). */
export function showingSubtitleIndex(tracks: TextTrackListLike | undefined | null): number {
  for (const i of subtitleTrackIndexes(tracks)) {
    if (tracks![i].mode === 'showing') return i
  }
  return -1
}

/** Next target for a plain on/off toggle: if a subtitle is showing, turn
 *  everything off (-1); otherwise show the first subtitle track. null when
 *  there is nothing to toggle (so the caller can no-op). */
export function nextSubtitleToggleIndex(
  tracks: TextTrackListLike | undefined | null,
): number | null {
  const subs = subtitleTrackIndexes(tracks)
  if (subs.length === 0) return null
  return showingSubtitleIndex(tracks) === -1 ? subs[0] : -1
}

/** Apply a selection: the chosen subtitle index 'showing', every other
 *  subtitle track 'disabled'. index === -1 turns all subtitle tracks off.
 *  Non-subtitle tracks are left untouched. */
export function applySubtitleSelection(video: VideoWithTextTracks, index: number): void {
  const tracks = video.textTracks
  if (!tracks) return
  for (const i of subtitleTrackIndexes(tracks)) {
    tracks[i].mode = i === index ? 'showing' : 'disabled'
  }
}

/** The language of the audio track the element is playing, where the engine
 *  exposes one (Safari's audioTracks); null when unknown. */
function playingAudioLanguage(video: HTMLVideoElement): string | null {
  const tracks = (video as HTMLVideoElement & {
    audioTracks?: { length: number; [index: number]: { enabled: boolean; language: string } }
  }).audioTracks
  if (!tracks) return null
  for (let i = 0; i < tracks.length; i += 1) {
    if (tracks[i].enabled) return tracks[i].language || null
  }
  return null
}

/** A show's episodes around the playing one (from MediaPlayer). */
export type EpisodeNav = {
  episodes: MediaEpisode[]
  currentId: number
  prev: MediaEpisode | null
  next: MediaEpisode | null
  onPick: (ep: MediaEpisode) => void
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
  /** For the system media session (lock screen, media keys) and the info panel. */
  title?: string
  delivery?: 'progressive' | 'hls'
  /** Intro/credits windows (absolute title secs) that offer a Skip button. */
  markers?: ReadonlyArray<MediaMarker>
  /** Episode prev/next + queue; its show also keys the remembered subtitle pick. */
  episodeNav?: EpisodeNav | null
  /** The file's embedded chapters; the settings popover lists them (none = no list). */
  chapters?: ReadonlyArray<MediaChapter>
  /** The grant's trick-play playlist (re-encode sessions): hovering or
   *  dragging the scrubber previews the frame there. Absent = no preview. */
  trickplayUrl?: string | null
}

export function MediaControls({
  video,
  offsetSecs,
  totalDurationSecs,
  seekableEndSecs,
  onSeekBelowOffset,
  title = '',
  delivery,
  markers,
  episodeNav,
  chapters,
  trickplayUrl,
}: Props) {
  const [paused, setPaused] = useState(video.paused)
  const [muted, setMuted] = useState(video.muted)
  const [positionSecs, setPositionSecs] = useState(offsetSecs + video.currentTime)
  const [elementDurationSecs, setElementDurationSecs] = useState<number | null>(
    Number.isFinite(video.duration) ? video.duration : null,
  )
  const [fullscreen, setFullscreen] = useState(false)
  const [resolution, setResolution] = useState<string | null>(null)
  // Sidecar subtitle state, derived from the <video>'s native textTracks.
  // `available` gates the CC button (no track → no button); `on` reflects
  // whether a subtitle track is currently showing (a forced track ships on).
  const [subtitleAvailable, setSubtitleAvailable] = useState(
    () => subtitleTrackIndexes((video as VideoWithTextTracks).textTracks).length > 0,
  )
  const [subtitleOn, setSubtitleOn] = useState(
    () => showingSubtitleIndex((video as VideoWithTextTracks).textTracks) !== -1,
  )
  // While dragging, the scrubber shows the drag target, not the playhead.
  const [dragSecs, setDragSecs] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const settingsId = useId()
  const queueId = useId()
  const prefs = usePlaybackPrefs()
  const showId = episodeNav?.episodes.find((e) => e.id === episodeNav.currentId)?.showId ?? null
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
    const onResize = () =>
      setResolution(video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : null)
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
    video.addEventListener('resize', onResize)
    video.addEventListener('click', onClick)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    // Sync once on bind: the element may already be mid-flight.
    onPlayPause()
    onVolumeChange()
    onTimeUpdate()
    onDurationChange()
    onResize()
    return () => {
      video.removeEventListener('play', onPlayPause)
      video.removeEventListener('pause', onPlayPause)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('seeked', onTimeUpdate)
      video.removeEventListener('durationchange', onDurationChange)
      video.removeEventListener('resize', onResize)
      video.removeEventListener('click', onClick)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [video, offsetSecs])

  // Persisted speed. defaultPlaybackRate too: every engine (re)load resets
  // playbackRate to it, so the choice survives re-grants and episode swaps.
  useEffect(() => {
    const el = videoElRef.current
    el.defaultPlaybackRate = prefs.speed
    el.playbackRate = prefs.speed
  }, [video, prefs.speed])

  // Subtitle selection. Until the viewer toggles CC, the startup decision
  // (per-show memory > subtitle mode/language, see playbackPrefs) is re-applied
  // whenever a track appears: the sidecar <track> remounts on every failed
  // load while the .vtt is still being extracted, and a fresh track comes up
  // in its default mode. After a toggle, that pick is what gets re-applied.
  // The CC button + its on/off state stay in sync with the native textTracks;
  // jsdom and older engines don't fire these events reliably, so the toggle
  // handler also sets state optimistically — this effect is the backstop.
  const subtitleChoiceRef = useRef<number | null>(null)
  const subtitlePickedRef = useRef(false)
  useEffect(() => {
    const tracks = (video as VideoWithTextTracks).textTracks
    const sync = () => {
      setSubtitleAvailable(subtitleTrackIndexes(tracks).length > 0)
      setSubtitleOn(showingSubtitleIndex(tracks) !== -1)
    }
    const apply = () => {
      if (!subtitlePickedRef.current && tracks) {
        const subs = subtitleTrackIndexes(tracks)
        const choice = startupSubtitleIndex({
          tracks: subs.map((i) => tracks[i]),
          memory: showId != null ? showTrackMemory(showId) : null,
          prefs: getPlaybackPrefs(),
          playingAudioLanguage: playingAudioLanguage(video),
        })
        subtitleChoiceRef.current = choice == null || choice === -1 ? choice : subs[choice]
      }
      if (subtitleChoiceRef.current != null) applySubtitleSelection(video, subtitleChoiceRef.current)
      sync()
    }
    apply()
    const list = tracks as unknown as EventTarget | undefined
    list?.addEventListener?.('addtrack', apply)
    list?.addEventListener?.('removetrack', sync)
    list?.addEventListener?.('change', sync)
    // The playing audio language (foreign-audio mode) is known only once
    // metadata loads.
    video.addEventListener('loadedmetadata', apply)
    return () => {
      list?.removeEventListener?.('addtrack', apply)
      list?.removeEventListener?.('removetrack', sync)
      list?.removeEventListener?.('change', sync)
      video.removeEventListener('loadedmetadata', apply)
    }
  }, [video, showId])

  const totalSecs =
    totalDurationSecs ?? (elementDurationSecs != null ? offsetSecs + elementDurationSecs : null)

  // Seek previews, as Apple floats the trick-play frame over its transport.
  // Thumbnails are keyed by the playlist they came from so a new grant never
  // shows the previous title's frames.
  const [trickplay, setTrickplay] = useState<{ url: string; thumbs: TrickplayThumb[] } | null>(null)
  useEffect(() => {
    if (!trickplayUrl) return undefined
    let live = true
    fetch(trickplayUrl)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (live) setTrickplay({ url: trickplayUrl, thumbs: parseTrickplayPlaylist(text, trickplayUrl) })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [trickplayUrl])
  const thumbs = trickplayUrl && trickplay?.url === trickplayUrl ? trickplay.thumbs : null
  // The pointer over the scrubber: its title time and x within the bar.
  const [scrubPointer, setScrubPointer] = useState<{ secs: number; x: number } | null>(null)
  const previewThumb = scrubPointer && thumbs ? thumbAt(thumbs, scrubPointer.secs) : null
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!previewThumb) return undefined
    const timer = window.setTimeout(() => setPreviewSrc(previewThumb.url), PREVIEW_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [previewThumb])
  const trackScrubPointer = (e: PointerEvent<HTMLInputElement>) => {
    if (!thumbs || totalSecs == null) return
    const input = e.currentTarget
    const rect = input.getBoundingClientRect()
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0
    setScrubPointer({ secs: fraction * totalSecs, x: input.offsetLeft + fraction * input.offsetWidth })
  }

  const commitSeek = (targetSecs: number) => {
    const resolved = resolveSeekTarget({ targetSecs, offsetSecs, seekableEndSecs })
    if (resolved.kind === 'regrant') {
      onSeekBelowOffset(resolved.targetSecs)
    } else {
      videoElRef.current.currentTime = resolved.sessionSecs
    }
  }
  // Relative skip (on-screen buttons, media keys), kept inside the title.
  const skipBy = (deltaSecs: number) => {
    const abs = offsetSecs + videoElRef.current.currentTime
    commitSeek(Math.max(0, Math.min(abs + deltaSecs, totalSecs ?? Infinity)))
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
  const toggleSubtitles = () => {
    const el = videoElRef.current as VideoWithTextTracks
    const next = nextSubtitleToggleIndex(el.textTracks)
    if (next === null) return
    applySubtitleSelection(el, next)
    subtitlePickedRef.current = true
    subtitleChoiceRef.current = next
    // Remember the pick for the show (Apple's per-show track memory): an
    // explicit Off, or the language turned on.
    if (showId != null) {
      const language = next === -1 ? null : el.textTracks?.[next].language || null
      if (next === -1 || language) rememberShowSubtitle(showId, language)
    }
    // Optimistic: don't wait for the (engine-dependent) 'change' event.
    setSubtitleOn(next !== -1)
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
  const togglePictureInPicture = () => {
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined)
    } else {
      void videoElRef.current.requestPictureInPicture().catch(() => undefined)
    }
  }

  const shownSecs = dragSecs ?? positionSecs

  // Conventional player keys while the bar is mounted (Space/k, arrows, m, f).
  // The document listener subscribes once; the latest handlers and offset live
  // in a ref refreshed after every render. Keys typed into form fields, or
  // Space/Enter on a focused button (which already clicks it), are left alone.
  const keysRef = useRef({ togglePlay, toggleMute, toggleFullscreen, commitSeek, skipBy, offsetSecs, episodeNav })
  useEffect(() => {
    keysRef.current = { togglePlay, toggleMute, toggleFullscreen, commitSeek, skipBy, offsetSecs, episodeNav }
  })
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (target?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return
      const keys = keysRef.current
      const el = videoElRef.current
      const absoluteSecs = keys.offsetSecs + el.currentTime
      switch (e.key) {
        case ' ':
        case 'k':
          keys.togglePlay()
          break
        case 'ArrowRight':
          keys.commitSeek(absoluteSecs + SEEK_STEP_SECS)
          break
        case 'ArrowLeft':
          keys.commitSeek(Math.max(0, absoluteSecs - SEEK_STEP_SECS))
          break
        case 'ArrowUp':
          el.volume = Math.min(1, el.volume + VOLUME_STEP)
          break
        case 'ArrowDown':
          el.volume = Math.max(0, el.volume - VOLUME_STEP)
          break
        case 'm':
          keys.toggleMute()
          break
        case 'f':
          keys.toggleFullscreen()
          break
        default:
          return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // System media controls (lock screen, hardware media keys, headsets): the
  // title as Now Playing, with play/pause, skip and seek routed through the
  // same seek path as the bar. Without setPositionState the OS shows the
  // element's own timeline, so a seekto time is session-relative.
  useEffect(() => {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
    if (!session) return undefined
    session.metadata = new MediaMetadata({ title })
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => void videoElRef.current.play().catch(() => undefined)],
      ['pause', () => videoElRef.current.pause()],
      ['seekbackward', (d) => keysRef.current.skipBy(-(d.seekOffset ?? SEEK_BACK_SECS))],
      ['seekforward', (d) => keysRef.current.skipBy(d.seekOffset ?? SEEK_FORWARD_SECS)],
      ['seekto', (d) => {
        if (d.seekTime != null) keysRef.current.commitSeek(keysRef.current.offsetSecs + d.seekTime)
      }],
      ['previoustrack', () => {
        const nav = keysRef.current.episodeNav
        if (nav?.prev) nav.onPick(nav.prev)
      }],
      ['nexttrack', () => {
        const nav = keysRef.current.episodeNav
        if (nav?.next) nav.onPick(nav.next)
      }],
    ]
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        /* action unsupported by this browser */
      }
    }
    return () => {
      session.metadata = null
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null)
        } catch {
          /* action unsupported by this browser */
        }
      }
    }
  }, [title])

  // While a popover is open, Escape closes just the popover: useModalA11y's
  // container listener would otherwise see the key first and close the player.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const open = document.querySelector<HTMLElement>('.media-controls__popover:popover-open')
      if (!open) return
      e.stopPropagation()
      open.hidePopover()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Drives the scrubber's emerald fill (left of the thumb) via a CSS variable —
  // a controlled <input type=range> can't paint its own progress in WebKit, so
  // the track gradient reads --progress.
  const progressPct =
    totalSecs != null && totalSecs > 0
      ? Math.min(100, Math.max(0, (shownSecs / totalSecs) * 100))
      : 0
  const activeMarker = markers?.find((m) => m.startSecs <= positionSecs && positionSecs < m.endSecs)
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true

  return (
    <div className="media-controls" role="group" aria-label="Playback controls">
      {activeMarker && (
        <button
          className="media-controls__skip"
          type="button"
          onClick={() => commitSeek(Math.min(activeMarker.endSecs, totalSecs ?? activeMarker.endSecs))}
        >
          {activeMarker.type === 'intro' ? 'Skip Intro' : 'Skip Credits'}
        </button>
      )}
      {episodeNav && (
        <button
          className="media-controls__button"
          type="button"
          onClick={() => episodeNav.prev && episodeNav.onPick(episodeNav.prev)}
          disabled={!episodeNav.prev}
          aria-label="Previous episode"
        >
          <PrevEpisodeIcon />
        </button>
      )}
      <button
        className="media-controls__button"
        type="button"
        onClick={() => skipBy(-SEEK_BACK_SECS)}
        aria-label={`Back ${SEEK_BACK_SECS} seconds`}
      >
        <SkipIcon secs={SEEK_BACK_SECS} />
      </button>
      <button
        className="media-controls__button media-controls__button--primary"
        type="button"
        onClick={togglePlay}
        aria-label={paused ? 'Play' : 'Pause'}
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <button
        className="media-controls__button"
        type="button"
        onClick={() => skipBy(SEEK_FORWARD_SECS)}
        aria-label={`Forward ${SEEK_FORWARD_SECS} seconds`}
      >
        <SkipIcon secs={SEEK_FORWARD_SECS} forward />
      </button>
      {episodeNav && (
        <button
          className="media-controls__button"
          type="button"
          onClick={() => episodeNav.next && episodeNav.onPick(episodeNav.next)}
          disabled={!episodeNav.next}
          aria-label="Next episode"
        >
          <NextEpisodeIcon />
        </button>
      )}
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
        onPointerMove={trackScrubPointer}
        onPointerLeave={() => setScrubPointer(null)}
      />
      {scrubPointer && previewThumb && (
        <div
          className="media-controls__preview"
          style={{ '--preview-x': `${scrubPointer.x}px` } as CSSProperties}
          aria-hidden="true"
        >
          {previewSrc && <img src={previewSrc} alt="" />}
          <span>{formatPlaybackTime(scrubPointer.secs)}</span>
        </div>
      )}
      <button
        className="media-controls__button"
        type="button"
        onClick={toggleMute}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? <VolumeOffIcon /> : <VolumeOnIcon />}
      </button>
      {subtitleAvailable && (
        <button
          className={
            'media-controls__button' +
            (subtitleOn ? ' media-controls__button--active' : '')
          }
          type="button"
          onClick={toggleSubtitles}
          aria-label={subtitleOn ? 'Turn off subtitles' : 'Turn on subtitles'}
          aria-pressed={subtitleOn}
        >
          <SubtitlesIcon />
        </button>
      )}
      {episodeNav && (
        <button
          className="media-controls__button"
          type="button"
          popoverTarget={queueId}
          aria-label="Episodes"
        >
          <EpisodesIcon />
        </button>
      )}
      <button
        className="media-controls__button"
        type="button"
        popoverTarget={settingsId}
        aria-label="Playback settings"
      >
        <SettingsIcon />
      </button>
      {pipSupported && (
        <button
          className="media-controls__button"
          type="button"
          onClick={togglePictureInPicture}
          aria-label="Picture in picture"
        >
          <PipIcon />
        </button>
      )}
      <button
        className="media-controls__button"
        type="button"
        onClick={toggleFullscreen}
        aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
      >
        {fullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
      </button>

      {episodeNav && (
        <div
          id={queueId}
          popover="auto"
          className="media-controls__popover"
          role="group"
          aria-label="Episodes"
        >
          <EpisodeList
            episodes={episodeNav.episodes}
            currentId={episodeNav.currentId}
            onPick={episodeNav.onPick}
          />
        </div>
      )}
      <div
        id={settingsId}
        popover="auto"
        className="media-controls__popover"
        role="group"
        aria-label="Playback settings"
      >
        <dl className="media-controls__info">
          {title && (
            <>
              <dt>Title</dt>
              <dd>{title}</dd>
            </>
          )}
          <dt>Duration</dt>
          <dd>{totalSecs != null ? formatPlaybackTime(totalSecs) : 'Unknown'}</dd>
          {delivery && (
            <>
              <dt>Delivery</dt>
              <dd>{delivery === 'progressive' ? 'Direct play' : 'Transcoded (HLS)'}</dd>
            </>
          )}
          {resolution && (
            <>
              <dt>Resolution</dt>
              <dd>{resolution}</dd>
            </>
          )}
        </dl>
        <label className="playback-settings__row">
          <span>Speed</span>
          <select
            value={String(prefs.speed)}
            onChange={(e) => setPlaybackPrefs({ speed: Number(e.target.value) })}
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={String(s)}>
                {s === 1 ? 'Normal' : `${s}×`}
              </option>
            ))}
          </select>
        </label>
        <PlaybackSettingsFields />
        {chapters && chapters.length > 0 && (
          <section aria-label="Chapters">
            <h3 className="media-controls__heading">Chapters</h3>
            <ul className="media-episode-list">
              {chapters.map((c, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="media-episode-list__item"
                    onClick={(e) => {
                      commitSeek(c.startSecs)
                      e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover?.()
                    }}
                  >
                    <span className="media-episode-list__title">{c.title || `Chapter ${i + 1}`}</span>
                    <span className="media-episode-list__code">{formatPlaybackTime(c.startSecs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}

export default MediaControls
