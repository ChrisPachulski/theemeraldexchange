/* eslint-disable react-refresh/only-export-components -- this file exports pure
   track-switcher helpers alongside the default IptvPlayer component so they can be
   unit-tested directly; fast-refresh is irrelevant for these pure functions. */
import { useEffect, useRef, useState } from 'react'
import type { StreamGrant } from '../../lib/api/iptv'
import './IptvPlayer.css'

export type TrackOption = {
  id: number
  label: string
}

type MediaTrackLike = {
  id?: string
  label?: string
  language?: string
  enabled?: boolean
}

type MediaTrackListLike = {
  length: number
  [index: number]: MediaTrackLike
}

type VideoWithTracks = HTMLVideoElement & {
  audioTracks?: MediaTrackListLike
}

type HlsPlayer = {
  audioTracks: Array<{ name?: string; lang?: string }>
  subtitleTracks: Array<{ name?: string; lang?: string }>
  audioTrack: number
  subtitleTrack: number
  destroy: () => void
}

type MpegtsPlayer = {
  attachMediaElement: (video: HTMLMediaElement) => void
  detachMediaElement: () => void
  load: () => void
  unload: () => void
  play: () => Promise<void> | void
  destroy: () => void
  on: (event: string, handler: (...args: unknown[]) => void) => void
}

export type IptvPlayerProps = {
  grant: StreamGrant
  autoPlay?: boolean
  startPositionSecs?: number
  /** A finite VOD title (local-media transcode), not a live channel. hls.js
   *  treats the session's growing EVENT playlist as LIVE until ENDLIST and
   *  by default starts at the live edge — fine for IPTV, but a faster-than-
   *  realtime transcode (a copy-remux runs at I/O speed) is MINUTES ahead by
   *  the time the player attaches, so a movie would open minutes in. VOD
   *  pins startPosition to 0 (a resume offset is baked server-side via -ss,
   *  so the session timeline always begins at the intended position). */
  vodHls?: boolean
  /** The session's known total media duration (secs). An HLS transcode grows
   *  its playlist as ffmpeg writes segments, so the element's duration — the
   *  total time the native controls render — creeps from ~a minute up to the
   *  full title over the first ~30 s of a session. The grant already knows
   *  the real total: pin MediaSource.duration to it at attach so the
   *  timeline reads full-length from the first frame. */
  pinnedDurationSecs?: number | null
  /** Render the browser's native control bar (default). MediaPlayer passes
   *  false and draws its own controls instead: a resumed HLS session's media
   *  timeline is the raw -ss session (starts at 0:00), so only an app-drawn
   *  bar can present absolute title time. (hls.js's `timelineOffset` — the
   *  one mechanism that could shift the MEDIA timeline — is broken on the
   *  growing EVENT playlists these sessions serve: its live code paths mix
   *  offset and playlist coordinates, discarding startPosition, double-adding
   *  the offset, and refusing seeks behind the live-sync point. Lab- and
   *  production-verified; do not reintroduce it.) */
  nativeControls?: boolean
  /** Hands the owner the underlying <video> element on mount (null on
   *  unmount) so custom controls can drive play/pause/seek/volume directly. */
  onVideoElement?: (video: HTMLVideoElement | null) => void
  onPositionUpdate?: (pos: number, durationSecs: number | null) => void
  /** HLS only: session-relative end of what the transcoder has PRODUCED so far
   *  (the growing EVENT playlist's edge), reported on each playlist refresh.
   *  Lets app controls re-grant a forward seek past the produced edge instead
   *  of dying on a segment that doesn't exist yet. */
  onSeekableEndUpdate?: (sessionSecs: number) => void
  onEnded?: () => void
  /** Progressive delivery only: fired ONCE when the stream has genuinely
   *  struggled (≥2 confirmed stall episodes in 120 s, user seeks excluded).
   *  The owner is expected to re-grant with buffered (HLS) delivery at the
   *  current position. Absent prop = no escalation (IPTV unaffected). */
  onDeliveryStruggling?: () => void
}

export function labelForTrack(track: { name?: string; lang?: string; label?: string; language?: string }, index: number): string {
  return track.name || track.label || track.lang || track.language || `Track ${index + 1}`
}

export function audioOptionsFromVideo(video: VideoWithTracks): TrackOption[] {
  const tracks = video.audioTracks
  if (!tracks?.length) return []
  return Array.from({ length: tracks.length }, (_, id) => ({
    id,
    label: labelForTrack(tracks[id], id),
  }))
}

export function subtitleOptionsFromVideo(video: HTMLVideoElement): TrackOption[] {
  const tracks = video.textTracks
  if (!tracks?.length) return []
  return Array.from({ length: tracks.length }, (_, id) => ({
    id,
    label: labelForTrack(tracks[id], id),
  }))
}

export function selectedAudioFromVideo(video: VideoWithTracks): number {
  const tracks = video.audioTracks
  if (!tracks?.length) return 0
  for (let i = 0; i < tracks.length; i += 1) {
    if (tracks[i].enabled) return i
  }
  return 0
}

export function selectedSubtitleFromVideo(video: HTMLVideoElement): number {
  const tracks = video.textTracks
  for (let i = 0; i < tracks.length; i += 1) {
    if (tracks[i].mode === 'showing') return i
  }
  return -1
}

function safePlay(video: HTMLVideoElement): void {
  void video.play().catch(() => undefined)
}

export function setNativeAudioTrack(video: VideoWithTracks, trackId: number): void {
  const tracks = video.audioTracks
  if (!tracks?.length) return
  for (let i = 0; i < tracks.length; i += 1) {
    tracks[i].enabled = i === trackId
  }
}

export function setNativeSubtitleTrack(video: HTMLVideoElement, trackId: number): void {
  for (let i = 0; i < video.textTracks.length; i += 1) {
    video.textTracks[i].mode = i === trackId ? 'showing' : 'disabled'
  }
}

// Minimal structural type for the hls.js handle we mutate. Mirrors the
// properties IptvPlayer assigns; kept local so tests need no hls.js import.
export type HlsTrackController = { audioTrack: number; subtitleTrack: number }

// Applies an audio-track selection to whichever engine is active and reports
// the selection that should be reflected in component state. HLS takes
// precedence (live path); otherwise the native <video> audioTracks are used.
// Returns the trackId that was applied, or null when there is no switchable
// engine (so the caller can skip the setState).
export function applyAudioTrack(
  hls: HlsTrackController | null,
  video: VideoWithTracks | null,
  trackId: number,
): number | null {
  if (hls) {
    hls.audioTrack = trackId
    return trackId
  }
  if (!video) return null
  const tracks = video.audioTracks
  if (!tracks?.length) return null
  setNativeAudioTrack(video, trackId)
  return trackId
}

// Subtitle counterpart. HLS precedence; otherwise native textTracks via
// setNativeSubtitleTrack. trackId === -1 means "Off" and is always applicable
// on the native path (setNativeSubtitleTrack disables all tracks), so unlike
// audio there is no length guard — return the applied id when a video exists.
export function applySubtitleTrack(
  hls: HlsTrackController | null,
  video: HTMLVideoElement | null,
  trackId: number,
): number | null {
  if (hls) {
    hls.subtitleTrack = trackId
    return trackId
  }
  if (!video) return null
  setNativeSubtitleTrack(video, trackId)
  return trackId
}

// ── HLS engine selection ─────────────────────────────────────────────
//
// Which engine plays an HLS grant: hls.js (MSE) or the browser's native
// <video> HLS. MSE wins whenever it is available. Native HLS is a fallback
// ONLY for engines without MSE (iOS Safari) — desktop Chrome reports
// canPlayType('application/vnd.apple.mpegurl') === 'maybe' yet cannot actually
// play HLS in a <video>, so trusting canPlayType first silently routes Chrome
// to a dead native path (video.src = .m3u8 → MEDIA_ERR_SRC_NOT_SUPPORTED, a
// blank player frozen at 0:00). Regression: a Chrome update flipped that MIME
// from '' to 'maybe', breaking all transcoded playback until this went
// MSE-first.
export type HlsEngine = 'mse' | 'native' | 'unsupported'

export function selectHlsEngine(mseSupported: boolean, nativeHlsCanPlay: string): HlsEngine {
  if (mseSupported) return 'mse'
  if (nativeHlsCanPlay) return 'native' // 'maybe' | 'probably' — any non-empty string
  return 'unsupported'
}

// ── Playlist load policy ─────────────────────────────────────────────
//
// hls.js's default manifest/playlist policy waits maxLoadTimeMs = 20 s
// before abandoning a load whose headers arrived but whose body never
// completes — and that exact failure recurs on the tunnel path (the
// edge intermittently drops a manifest response mid-body), so every
// fresh transcode session risked a silent 20 s spinner before the
// instant-retry succeeded. A playlist is a few KB: once the first byte
// lands the body must follow within seconds, so time out fast and lean
// on free immediate retries instead. Applies to live IPTV too — a
// stalled level reload mid-watch otherwise eats the same 20 s.
// (Segments keep their own generous fragLoadPolicy: big bodies on a
// modest uplink legitimately take tens of seconds.)
export const HLS_PLAYLIST_LOAD_POLICY = {
  default: {
    maxTimeToFirstByteMs: 6000,
    maxLoadTimeMs: 8000,
    timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
  },
} as const

// ── Fatal hls.js error recovery ──────────────────────────────────────
//
// hls.js fatal errors fall into three classes with different recovery
// contracts (https://github.com/video-dev/hls.js/blob/master/docs/API.md):
//   network — reload the source (startLoad), with backoff + a retry cap;
//   media   — the documented ladder: recoverMediaError(), then
//             swapAudioCodec()+recoverMediaError() if a second fatal media
//             error lands inside MEDIA_RECOVERY_WINDOW_MS, then give up.
//             Without the ladder a persistent MSE append rejection (the
//             5.1-AAC grey-box class) loops recoverMediaError() forever on
//             a frozen player. Errors spaced wider than the window reset
//             the ladder so an occasional transient glitch never kills a
//             long session.
//   other   — unrecoverable; destroy and surface a message.

export type FatalHlsErrorKind = 'network' | 'media' | 'other'

// Minimal structural slice of the hls.js instance the handler drives; kept
// local so tests need no hls.js import (same convention as HlsTrackController).
export type RecoverableHls = {
  startLoad: () => void
  recoverMediaError: () => void
  swapAudioCodec: () => void
  destroy: () => void
}


// ── HLS stall watchdog ───────────────────────────────────────────────
//
// hls.js does not fire its own ERROR event on a simple buffer underrun —
// it just stops advancing and the <video> emits `waiting`. Without a
// watchdog on the hls path, the player freezes silently until hls.js
// exhausts fragLoadingMaxRetry (up to 8 × 8 s = 64 s) and surfaces a
// fatal error. This watchdog mirrors the mpegts stall recovery: on a
// `waiting`/`stalled` event, wait 4 s for the buffer to refill on its
// own; if the playhead still hasn't moved, call startLoad() to re-issue
// the stalled segment request. `onProgress` (bound to `playing` +
// `timeupdate`) cancels a pending stall timer.
export type HlsStallRecoverer = { startLoad: () => void }

export function createHlsStallWatchdog(opts: {
  hls: HlsStallRecoverer
  video: { currentTime: number }
  isCancelled: () => boolean
  schedule?: (fn: () => void, delayMs: number) => number
  clearScheduled?: (id: number) => void
}): { onStall: () => void; onProgress: () => void; cleanup: () => void } {
  const { hls, video, isCancelled } = opts
  const schedule =
    opts.schedule ?? ((fn, delayMs) => window.setTimeout(fn, delayMs) as unknown as number)
  const clearScheduled = opts.clearScheduled ?? ((id) => window.clearTimeout(id))

  const STALL_WINDOW_MS = 4000
  let stallTimer: number | null = null
  let stallMark = 0

  const clearStall = () => {
    if (stallTimer !== null) {
      clearScheduled(stallTimer)
      stallTimer = null
    }
  }

  const onStall = () => {
    if (stallTimer !== null) return // already waiting
    stallMark = video.currentTime
    stallTimer = schedule(() => {
      stallTimer = null
      if (isCancelled()) return
      if (video.currentTime <= stallMark + 0.1) hls.startLoad()
    }, STALL_WINDOW_MS)
  }

  const onProgress = () => {
    clearStall()
  }

  const cleanup = () => {
    clearStall()
  }

  return { onStall, onProgress, cleanup }
}

// ── Progressive stall escalator ──────────────────────────────────────
//
// Progressive direct play hands the ORIGINAL file to the native <video>;
// the browser owns the readahead (~2 s over the tunnel) and nothing
// server-side deepens it. When THIS stream on THIS connection genuinely
// struggles, the player escalates once into the managed HLS pipeline
// (lossless copy-remux + the tuned hls.js buffer) via `onEscalate`.
//
// Scoring: a stall EPISODE is a `waiting`/`stalled` event after playback
// has begun while the user is NOT seeking (seeks fire `waiting` on this
// path and say nothing about delivery health), confirmed by ~1 s of a
// non-advancing playhead (a refill that recovers faster never counts).
// One rebuffer = one episode: an open episode absorbs further stall
// events and only closes after ≥5 s of continuous progress. The SECOND
// counted episode inside a rolling 120 s window fires `onEscalate()`
// exactly once, then the escalator disarms permanently — escalation is a
// one-way, once-per-mount decision.
export const ESCALATE_EPISODE_THRESHOLD = 2
export const ESCALATE_WINDOW_MS = 120_000
export const ESCALATE_CONFIRM_MS = 1000
export const ESCALATE_EPISODE_CLOSE_MS = 5000

export function createProgressiveStallEscalator(opts: {
  video: { currentTime: number; seeking: boolean }
  onEscalate: () => void
  isCancelled: () => boolean
  schedule?: (fn: () => void, delayMs: number) => number
  clearScheduled?: (id: number) => void
  now?: () => number
}): { onStall: () => void; onProgress: () => void; cleanup: () => void } {
  const { video, onEscalate, isCancelled } = opts
  const schedule =
    opts.schedule ?? ((fn, delayMs) => window.setTimeout(fn, delayMs) as unknown as number)
  const clearScheduled = opts.clearScheduled ?? ((id) => window.clearTimeout(id))
  const now = opts.now ?? (() => Date.now())

  let begun = false
  let disarmed = false
  let confirmTimer: number | null = null
  let episodeOpen = false
  let progressSince: number | null = null
  let lastTime = 0
  let episodeTimes: number[] = []

  const clearConfirm = () => {
    if (confirmTimer !== null) {
      clearScheduled(confirmTimer)
      confirmTimer = null
    }
  }

  const countEpisode = () => {
    const t = now()
    episodeTimes = episodeTimes.filter((at) => t - at <= ESCALATE_WINDOW_MS)
    episodeTimes.push(t)
    episodeOpen = true
    progressSince = null
    if (episodeTimes.length >= ESCALATE_EPISODE_THRESHOLD) {
      disarmed = true
      clearConfirm()
      onEscalate()
    }
  }

  const onStall = () => {
    if (disarmed || isCancelled()) return
    if (!begun || video.seeking) return
    if (episodeOpen) {
      // Same rebuffer — restart the close clock, don't count again.
      progressSince = null
      return
    }
    if (confirmTimer !== null) return
    const stallMark = video.currentTime
    confirmTimer = schedule(() => {
      confirmTimer = null
      if (disarmed || isCancelled() || video.seeking) return
      if (video.currentTime <= stallMark + 0.1) countEpisode()
    }, ESCALATE_CONFIRM_MS)
  }

  const onProgress = () => {
    if (disarmed || isCancelled()) return
    const t = video.currentTime
    const advanced = t > lastTime + 0.01
    lastTime = t
    if (!advanced) return
    if (!begun && t > 0) begun = true
    clearConfirm()
    if (episodeOpen) {
      const ts = now()
      if (progressSince === null) {
        progressSince = ts
      } else if (ts - progressSince >= ESCALATE_EPISODE_CLOSE_MS) {
        episodeOpen = false
        progressSince = null
      }
    }
  }

  const cleanup = () => {
    clearConfirm()
  }

  return { onStall, onProgress, cleanup }
}

// ── HLS known-duration pin ───────────────────────────────────────────
//
// A VOD transcode session serves an EVENT playlist that GROWS as ffmpeg
// writes segments, and hls.js derives MediaSource.duration from the
// playlist — so the native controls' total time creeps upward until the
// transcode finishes (ENDLIST). The grant carries the probed full-title
// duration, so pin MediaSource.duration to it the moment the source
// attaches. hls.js only ever GROWS the duration (BufferController skips
// the update when the element already reports a larger finite duration),
// so a single early pin holds; re-asserting on each playlist refresh
// covers the attach-races and the recoverMediaError() re-attach path
// (which builds a fresh, unpinned MediaSource). Once ENDLIST lands the
// pin stops: hls.js + MSE endOfStream() snap the duration to the exact
// muxed total, which is authoritative over the probe estimate.
export type PinnableMediaSource = { duration: number; readyState: string }

export function createHlsDurationPin(opts: {
  durationSecs: number
  isCancelled: () => boolean
}): {
  onMediaAttached: (evt: unknown, data: { mediaSource?: PinnableMediaSource | null }) => void
  onLevelUpdated: (evt: unknown, data: { details: { live: boolean } }) => void
} {
  const { durationSecs, isCancelled } = opts
  let mediaSource: PinnableMediaSource | null = null

  const pin = () => {
    if (isCancelled() || !mediaSource) return
    // Setting duration is only legal on an open MediaSource; 'ended' means
    // endOfStream() already fixed the true total — never fight that.
    if (mediaSource.readyState !== 'open') return
    // NaN (nothing buffered yet) fails this comparison too, so a fresh
    // MediaSource always takes the pin. Never shrink an already-larger
    // duration: if the playlist outgrows the probe estimate, it wins.
    if (mediaSource.duration >= durationSecs) return
    try {
      mediaSource.duration = durationSecs
    } catch {
      // A SourceBuffer append was mid-flight (setting duration then throws
      // InvalidStateError); the next playlist refresh retries.
    }
  }

  return {
    onMediaAttached: (_evt, data) => {
      mediaSource = data.mediaSource ?? null
      pin()
    },
    onLevelUpdated: (_evt, data) => {
      if (data.details.live) pin()
    },
  }
}

export const MAX_NET_RETRIES = 8
export const MEDIA_RECOVERY_WINDOW_MS = 3000

export function createFatalHlsErrorHandler(opts: {
  hls: RecoverableHls
  isCancelled: () => boolean
  setError: (message: string) => void
  schedule?: (fn: () => void, delayMs: number) => void
  now?: () => number
}): (kind: FatalHlsErrorKind) => void {
  const { hls, isCancelled, setError } = opts
  const schedule = opts.schedule ?? ((fn, delayMs) => window.setTimeout(fn, delayMs))
  const now = opts.now ?? (() => Date.now())

  let netRetries = 0
  let mediaRecoverStep = 0
  let lastMediaErrorAt = 0

  return (kind) => {
    if (isCancelled()) return
    if (kind === 'network') {
      if (netRetries >= MAX_NET_RETRIES) {
        setError('Couldn’t start playback. The transcoder may still be warming up; try again in a moment.')
        hls.destroy()
        return
      }
      netRetries += 1
      // Backoff a touch so a warm-up 503 has time to resolve.
      schedule(() => {
        if (!isCancelled()) hls.startLoad()
      }, Math.min(500 * netRetries, 3000))
      return
    }
    if (kind === 'media') {
      const t = now()
      if (t - lastMediaErrorAt > MEDIA_RECOVERY_WINDOW_MS) mediaRecoverStep = 0
      lastMediaErrorAt = t
      mediaRecoverStep += 1
      if (mediaRecoverStep === 1) {
        hls.recoverMediaError()
      } else if (mediaRecoverStep === 2) {
        hls.swapAudioCodec()
        hls.recoverMediaError()
      } else {
        setError('Playback failed; this stream couldn’t be decoded. Close and re-open to retry.')
        hls.destroy()
      }
      return
    }
    setError('Playback failed.')
    hls.destroy()
  }
}

export default function IptvPlayer({
  grant,
  autoPlay = false,
  startPositionSecs,
  vodHls = false,
  pinnedDurationSecs,
  nativeControls = true,
  onVideoElement,
  onPositionUpdate,
  onSeekableEndUpdate,
  onEnded,
  onDeliveryStruggling,
}: IptvPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<HlsPlayer | null>(null)
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState(0)
  const [selectedSubtitle, setSelectedSubtitle] = useState(-1)
  const [error, setError] = useState<string | null>(null)

  // Hand the element to the owner (custom controls). Mount-scoped: the
  // <video> itself persists across engine swaps, so this fires once.
  useEffect(() => {
    onVideoElement?.(videoRef.current)
    return () => onVideoElement?.(null)
  }, [onVideoElement])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined

    const updateNativeTracks = () => {
      const videoWithTracks = video as VideoWithTracks
      setAudioTracks(audioOptionsFromVideo(videoWithTracks))
      setSubtitleTracks(subtitleOptionsFromVideo(video))
      setSelectedAudio(selectedAudioFromVideo(videoWithTracks))
      setSelectedSubtitle(selectedSubtitleFromVideo(video))
    }

    const onLoadedMetadata = () => {
      updateNativeTracks()
      if (startPositionSecs && Number.isFinite(startPositionSecs) && startPositionSecs > 0) {
        video.currentTime = startPositionSecs
      }
    }
    const onTimeUpdate = () => {
      const durationSecs = Number.isFinite(video.duration) ? video.duration : null
      onPositionUpdate?.(video.currentTime, durationSecs)
    }
    const onVideoEnded = () => onEnded?.()
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onVideoEnded)
    video.addEventListener('loadedmetadata', onLoadedMetadata)

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', onVideoEnded)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
    }
  }, [onEnded, onPositionUpdate, startPositionSecs])

  useEffect(() => {
    const videoElement = videoRef.current
    if (!videoElement) return undefined
    const video: HTMLVideoElement = videoElement

    let cancelled = false
    let cleanupEngine: (() => void) | undefined

    const resetTracks = () => {
      setAudioTracks([])
      setSubtitleTracks([])
      setSelectedAudio(0)
      setSelectedSubtitle(-1)
    }

    const resetVideo = () => {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }

    const updateNativeTracks = () => {
      const videoWithTracks = video as VideoWithTracks
      setAudioTracks(audioOptionsFromVideo(videoWithTracks))
      setSubtitleTracks(subtitleOptionsFromVideo(video))
      setSelectedAudio(selectedAudioFromVideo(videoWithTracks))
      setSelectedSubtitle(selectedSubtitleFromVideo(video))
    }

    async function setup() {
      setError(null)
      resetTracks()
      hlsRef.current = null

      if (grant.delivery === 'progressive') {
        video.src = grant.url
        updateNativeTracks()
        if (onDeliveryStruggling) {
          const escalator = createProgressiveStallEscalator({
            video,
            onEscalate: onDeliveryStruggling,
            isCancelled: () => cancelled,
          })
          video.addEventListener('waiting', escalator.onStall)
          video.addEventListener('stalled', escalator.onStall)
          video.addEventListener('playing', escalator.onProgress)
          video.addEventListener('timeupdate', escalator.onProgress)
          cleanupEngine = () => {
            escalator.cleanup()
            video.removeEventListener('waiting', escalator.onStall)
            video.removeEventListener('stalled', escalator.onStall)
            video.removeEventListener('playing', escalator.onProgress)
            video.removeEventListener('timeupdate', escalator.onProgress)
          }
        }
        if (autoPlay) safePlay(video)
        return
      }

      if (grant.delivery === 'hls') {
        const Hls = (await import('hls.js')).default
        if (cancelled) return

        const engine = selectHlsEngine(Hls.isSupported(), video.canPlayType('application/vnd.apple.mpegurl'))
        if (engine === 'native') {
          video.src = grant.url
          updateNativeTracks()
          if (autoPlay) safePlay(video)
          return
        }
        if (engine === 'unsupported') {
          setError('HLS playback is not supported in this browser.')
          return
        }
        // engine === 'mse' — drive the <video> through hls.js below.

        // Live HLS (the remux path) over the same proxy → cloudflared →
        // edge transport as mpegts. Default hls.js sits near the live edge
        // and underruns on tunnel jitter, so favor a resilient buffer over
        // low latency: sit a few segments back, allow a deep forward
        // buffer, bridge small gaps, and retry fragments generously. A few
        // seconds of latency is irrelevant for IPTV; uninterrupted playback
        // is everything.
        const hls = new Hls({
          lowLatencyMode: false,
          liveSyncDurationCount: 4,
          maxBufferHole: 0.5,
          enableWorker: true,
          // Fast-failing playlist loads (see HLS_PLAYLIST_LOAD_POLICY): the
          // default 20 s body timeout turned an edge-dropped manifest
          // response into a 20 s startup spinner on fresh sessions.
          manifestLoadPolicy: HLS_PLAYLIST_LOAD_POLICY,
          playlistLoadPolicy: HLS_PLAYLIST_LOAD_POLICY,
          // Generous fragment retries over the tunnel path: cloudflared TTFB
          // can be seconds, and a 10-20 MB fMP4 copy segment at a modest
          // uplink legitimately takes tens of seconds — bailing early turns
          // a slow fetch into a fatal error. (fragLoadPolicy supersedes the
          // deprecated fragLoadingMaxRetry* keys.)
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 15000,
              maxLoadTimeMs: 65000,
              timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000 },
              errorRetry: { maxNumRetry: 4, retryDelayMs: 2000, maxRetryDelayMs: 16000 },
            },
          },
          // Local-media VOD sessions grow an EVENT playlist that hls.js
          // treats as live until ENDLIST, which trips TWO live behaviors a
          // finite title must not get:
          //  * the default live-edge START — a faster-than-realtime encode
          //    (copy-remuxes run at I/O speed) is minutes ahead by attach
          //    time, so the movie opened minutes in → pin startPosition 0
          //    (any resume offset is baked server-side via ffmpeg -ss, so
          //    session position 0 IS the resume point);
          //  * the max-latency CATCH-UP SEEK — with a finite cap, hls.js
          //    force-seeks the playhead toward the runaway "edge" mid-watch
          //    (observed: playback jumped 0:00 → 7:48 as the remux outran
          //    it) → Infinity disables the forced seek for VOD while IPTV
          //    keeps the bounded latency window it needs.
          //
          // Buffer budgets are split VOD vs live because the BYTE cap is the
          // real governor: hls.js stops fetching at maxBufferSize regardless
          // of the time targets, and the default 60 MB held only 3-6 of the
          // 10-20 MB fMP4 copy segments — one slow tunnel fetch from an
          // underrun. 120 MB stays under Chrome's ~150 MB SourceBuffer
          // ceiling (drop it first if QuotaExceededError ever appears).
          // backBufferLength must be FINITE: the default (Infinity) grows the
          // SourceBuffer until the browser evicts mid-play — the documented
          // stall-an-hour-into-a-movie failure mode.
          ...(vodHls
            ? {
                startPosition: 0,
                liveMaxLatencyDurationCount: Infinity,
                maxBufferLength: 60,
                maxMaxBufferLength: 120,
                maxBufferSize: 120 * 1024 * 1024,
                backBufferLength: 60,
              }
            : {
                liveMaxLatencyDurationCount: 16,
                maxBufferLength: 30,
                maxMaxBufferLength: 120,
                backBufferLength: 10,
                // Gentle rate-based catch-up (default 1 = none): drifting
                // slowly back to the sync window beats a hard seek.
                maxLiveSyncPlaybackRate: 1.05,
              }),
        })
        hlsRef.current = hls

        const updateHlsTracks = () => {
          if (cancelled) return
          setAudioTracks(hls.audioTracks.map((track, id) => ({ id, label: labelForTrack(track, id) })))
          setSubtitleTracks(hls.subtitleTracks.map((track, id) => ({ id, label: labelForTrack(track, id) })))
          setSelectedAudio(hls.audioTrack)
          setSelectedSubtitle(hls.subtitleTrack)
        }

        hls.on(Hls.Events.MANIFEST_PARSED, updateHlsTracks)
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateHlsTracks)
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateHlsTracks)

        // Fatal-error recovery. Without this a transient manifest/segment error
        // — e.g. a transcoder still emitting its first segment (HTTP 503 during
        // warm-up) — leaves a blank <video> with no feedback. Retry network
        // errors (reloading the manifest), run the documented media-error
        // recovery ladder, and only give up with a visible message after a
        // bounded number of attempts.
        const onFatalError = createFatalHlsErrorHandler({
          hls,
          isCancelled: () => cancelled,
          setError,
        })
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (cancelled || !data.fatal) return
          onFatalError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'network'
              : data.type === Hls.ErrorTypes.MEDIA_ERROR
                ? 'media'
                : 'other',
          )
        })

        // Buffer-underrun stall watchdog for the hls.js path. hls.js does
        // not surface a fatal ERROR on a simple underrun — it just stalls
        // and fires `waiting` on the <video>. Without this, a brief
        // cloudflared jitter can freeze the player silently for up to 64 s
        // (fragLoadingMaxRetry × fragLoadingMaxRetryTimeout) before a fatal
        // error surfaces. The watchdog calls startLoad() after 4 s of
        // no-progress, matching the mpegts recovery pattern.
        const stallWatchdog = createHlsStallWatchdog({
          hls,
          video,
          isCancelled: () => cancelled,
        })

        // Full-length timeline from the first frame: pin MediaSource.duration
        // to the grant's known total instead of letting it creep up with the
        // growing transcode playlist (see createHlsDurationPin).
        if (pinnedDurationSecs != null && Number.isFinite(pinnedDurationSecs) && pinnedDurationSecs > 0) {
          const durationPin = createHlsDurationPin({
            durationSecs: pinnedDurationSecs,
            isCancelled: () => cancelled,
          })
          hls.on(Hls.Events.MEDIA_ATTACHED, durationPin.onMediaAttached)
          hls.on(Hls.Events.LEVEL_UPDATED, durationPin.onLevelUpdated)
        }
        // Report the produced edge (last fragment end) so app controls can
        // re-grant a forward seek past what ffmpeg has transcoded. totalduration
        // is the sum of fragment durations — the produced length of the 0-based
        // VOD EVENT playlist. hls.destroy() in cleanupEngine drops this listener.
        if (onSeekableEndUpdate) {
          hls.on(
            Hls.Events.LEVEL_UPDATED,
            (_evt: unknown, data: { details: { totalduration?: number } }) => {
              const edge = data.details.totalduration
              if (typeof edge === 'number' && Number.isFinite(edge)) onSeekableEndUpdate(edge)
            },
          )
        }
        video.addEventListener('waiting', stallWatchdog.onStall)
        video.addEventListener('stalled', stallWatchdog.onStall)
        video.addEventListener('playing', stallWatchdog.onProgress)
        video.addEventListener('timeupdate', stallWatchdog.onProgress)

        hls.loadSource(grant.url)
        hls.attachMedia(video)
        cleanupEngine = () => {
          stallWatchdog.cleanup()
          video.removeEventListener('waiting', stallWatchdog.onStall)
          video.removeEventListener('stalled', stallWatchdog.onStall)
          video.removeEventListener('playing', stallWatchdog.onProgress)
          video.removeEventListener('timeupdate', stallWatchdog.onProgress)
          hls.destroy()
        }
        updateHlsTracks()
        if (autoPlay) safePlay(video)
        return
      }

      const mpegtsModule = (await import('mpegts.js')) as unknown as {
        default: {
          isSupported: () => boolean
          createPlayer: (mds: object, config?: object) => MpegtsPlayer
          Events: Record<string, string>
          ErrorTypes: Record<string, string>
        }
      }
      const mpegts = mpegtsModule.default
      if (cancelled) return
      if (!mpegts.isSupported()) {
        setError('MPEG-TS playback is not supported in this browser.')
        return
      }

      // Live MPEG-TS reaches the browser via backend proxy → cloudflared
      // tunnel → CF edge — a path with real jitter. The config favors a
      // resilient buffer over minimal latency; the recovery + stall watchdog
      // below turn a transient underrun into a brief reconnect instead of
      // the frozen "spinner of death".
      //   - enableStashBuffer (~1 MB): the jitter shock-absorber. Without
      //     it the demuxer starves on every hiccup.
      //   - liveBufferLatencyChasing: FALSE. When true, mpegts.js hard-SEEKS
      //     the playhead toward the live edge whenever latency grows — a
      //     ~6s MSE-flushing jump that itself reads as a freeze (and a wider
      //     window makes the jump bigger). We'd rather drift a few seconds
      //     behind live (fine for IPTV) and stay smooth.
      //   - enableWorker: demux off the main thread.
      //   - fixAudioTimestampGap: ride over occasional upstream TS gaps.
      const player: MpegtsPlayer = mpegts.createPlayer(
        { type: 'mpegts', isLive: true, url: grant.url },
        {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 1024,
          lazyLoad: false,
          lazyLoadMaxDuration: 0,
          deferLoadAfterSourceOpen: false,
          liveBufferLatencyChasing: false,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 30,
          autoCleanupMinBackwardDuration: 10,
          fixAudioTimestampGap: true,
          reuseRedirectedURL: true,
        },
      )

      // ── Recovery + stall watchdog ───────────────────────────────────────
      // A silent bandwidth underrun fires the video element's `waiting`
      // event but NOT mpegts' ERROR — so without a watchdog the player just
      // freezes on the spinner forever (the "smooth ~10s then dies" symptom).
      // Both the ERROR path and a sustained stall funnel into recover(),
      // which reloads the engine to resume at the live edge, with exponential
      // backoff so a jitter burst can't burn the whole budget in seconds, and
      // a reset after a stable playing window so a later blip starts fresh.
      let recoveries = 0
      let recovering = false
      let stallTimer: number | null = null
      let stableTimer: number | null = null
      let stallMark = 0
      const RECOVERY_CAP = 8

      const recover = () => {
        if (cancelled || recovering) return
        if (recoveries >= RECOVERY_CAP) {
          setError('Live stream interrupted. Close and re-open the channel to retry.')
          return
        }
        recovering = true
        const delay = Math.min(500 * 2 ** recoveries, 8000)
        recoveries += 1
        window.setTimeout(() => {
          if (cancelled) return
          try {
            player.unload()
            player.load()
            void player.play()
          } catch {
            /* a later waiting/error will retry */
          }
          recovering = false
        }, delay)
      }

      const clearStall = () => {
        if (stallTimer !== null) {
          window.clearTimeout(stallTimer)
          stallTimer = null
        }
      }
      const onStall = () => {
        if (stallTimer !== null || recovering) return
        stallMark = video.currentTime
        // Give the buffer a few seconds to refill on its own; only force a
        // live-edge reload if the playhead genuinely hasn't advanced.
        stallTimer = window.setTimeout(() => {
          stallTimer = null
          if (cancelled) return
          if (video.currentTime <= stallMark + 0.1) recover()
        }, 4000)
      }
      const onProgress = () => {
        clearStall()
        if (stableTimer === null) {
          stableTimer = window.setTimeout(() => {
            recoveries = 0
            stableTimer = null
          }, 12000)
        }
      }

      player.on(mpegts.Events.ERROR, () => {
        if (cancelled) return
        recover()
      })
      video.addEventListener('waiting', onStall)
      video.addEventListener('stalled', onStall)
      video.addEventListener('playing', onProgress)
      video.addEventListener('timeupdate', onProgress)

      player.attachMediaElement(video)
      player.load()
      cleanupEngine = () => {
        clearStall()
        if (stableTimer !== null) window.clearTimeout(stableTimer)
        video.removeEventListener('waiting', onStall)
        video.removeEventListener('stalled', onStall)
        video.removeEventListener('playing', onProgress)
        video.removeEventListener('timeupdate', onProgress)
        player.unload()
        player.detachMediaElement()
        player.destroy()
      }
      updateNativeTracks()
      if (autoPlay) void player.play()
    }

    void setup()

    return () => {
      cancelled = true
      cleanupEngine?.()
      hlsRef.current = null
      resetVideo()
      resetTracks()
    }
  }, [autoPlay, grant, vodHls, pinnedDurationSecs, onDeliveryStruggling, onSeekableEndUpdate])

  const chooseAudioTrack = (trackId: number) => {
    const applied = applyAudioTrack(
      hlsRef.current,
      videoRef.current as VideoWithTracks | null,
      trackId,
    )
    if (applied !== null) setSelectedAudio(applied)
  }

  const chooseSubtitleTrack = (trackId: number) => {
    const applied = applySubtitleTrack(hlsRef.current, videoRef.current, trackId)
    if (applied !== null) setSelectedSubtitle(applied)
  }

  // This selector is hls.js-first: chooseSubtitleTrack drives hls.subtitleTrack
  // (in-manifest HLS subs), which is correct for IPTV but cannot reach a native
  // sidecar <track> on the MSE path. When the app draws its own controls
  // (nativeControls=false — the local-media MediaPlayer), MediaControls owns the
  // sidecar subtitle toggle via the native textTracks API, so suppress this
  // duplicate, non-functional-for-sidecar selector. IPTV (nativeControls=true)
  // keeps it for genuine in-manifest subtitle tracks.
  const showSubtitleSelect = nativeControls && subtitleTracks.length > 0

  return (
    <div className="iptv-player">
      <video
        ref={videoRef}
        data-testid="iptv-player-video"
        className="iptv-player__video"
        src={grant.delivery === 'progressive' ? grant.url : undefined}
        controls={nativeControls}
        playsInline
        // Progressive direct play streams the ORIGINAL file over the tunnel;
        // the browser's readahead is the only buffer it gets, and with
        // preload="metadata" Chrome trickles shallow range requests that
        // underrun on any jitter. "auto" tells it to buffer ahead
        // aggressively. MSE deliveries ignore preload (hls.js/mpegts.js own
        // the SourceBuffer), so gating on delivery is about intent, not need.
        preload={grant.delivery === 'progressive' ? 'auto' : 'metadata'}
        // A cross-origin <track> (the sidecar .vtt on the local-media transcode
        // path) only loads when the media element opts into CORS. MSE (hls.js)
        // drives the video through a same-origin blob URL, so this governs ONLY
        // the track fetch; left unset when there's no sidecar so the progressive
        // and no-subtitle paths stay byte-identical to before.
        crossOrigin={grant.subtitle ? 'anonymous' : undefined}
      >
        {grant.subtitle && (
          // Forced/narrative tracks auto-show (default); a full subtitle track
          // is loaded but off until a control toggles it (follow-up). The app
          // draws its own controls (nativeControls=false), so there is no native
          // menu yet — forced subs are the immediately-visible case.
          <track
            kind="subtitles"
            src={grant.subtitle.url}
            srcLang={grant.subtitle.language ?? undefined}
            label={grant.subtitle.language ?? 'Subtitles'}
            default={grant.subtitle.forced}
          />
        )}
      </video>

      {(audioTracks.length > 0 || showSubtitleSelect) && (
        <div className="iptv-player__controls">
          {audioTracks.length > 0 && (
            <label className="iptv-player__selector">
              Audio
              <select value={selectedAudio} onChange={(e) => chooseAudioTrack(Number(e.target.value))}>
                {audioTracks.map((track) => (
                  <option key={track.id} value={track.id}>{track.label}</option>
                ))}
              </select>
            </label>
          )}

          {showSubtitleSelect && (
            <label className="iptv-player__selector">
              Subtitles
              <select value={selectedSubtitle} onChange={(e) => chooseSubtitleTrack(Number(e.target.value))}>
                <option value={-1}>Off</option>
                {subtitleTracks.map((track) => (
                  <option key={track.id} value={track.id}>{track.label}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {error && <p className="iptv-player__error">{error}</p>}
    </div>
  )
}
