/* eslint-disable react-refresh/only-export-components -- this file exports pure
   track-switcher helpers alongside the default IptvPlayer component so they can be
   unit-tested directly; fast-refresh is irrelevant for these pure functions. */
import { useEffect, useRef, useState } from 'react'
import type { StreamGrant } from '../../lib/api/iptv'
import styles from './IptvPlayer.module.css'

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
  onPositionUpdate?: (pos: number, durationSecs: number | null) => void
  onEnded?: () => void
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
        setError('Couldn’t start playback. The transcoder may still be warming up — try again in a moment.')
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
        setError('Playback failed — this stream couldn’t be decoded. Close and re-open to retry.')
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
  onPositionUpdate,
  onEnded,
}: IptvPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<HlsPlayer | null>(null)
  const [audioTracks, setAudioTracks] = useState<TrackOption[]>([])
  const [subtitleTracks, setSubtitleTracks] = useState<TrackOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState(0)
  const [selectedSubtitle, setSelectedSubtitle] = useState(-1)
  const [error, setError] = useState<string | null>(null)

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
        if (autoPlay) safePlay(video)
        return
      }

      if (grant.delivery === 'hls') {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = grant.url
          updateNativeTracks()
          if (autoPlay) safePlay(video)
          return
        }

        const Hls = (await import('hls.js')).default
        if (cancelled) return
        if (!Hls.isSupported()) {
          setError('HLS playback is not supported in this browser.')
          return
        }

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
          liveMaxLatencyDurationCount: 16,
          maxBufferLength: 30,
          maxMaxBufferLength: 120,
          maxBufferHole: 0.5,
          fragLoadingMaxRetry: 8,
          fragLoadingMaxRetryTimeout: 8000,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
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

        hls.loadSource(grant.url)
        hls.attachMedia(video)
        cleanupEngine = () => hls.destroy()
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
  }, [autoPlay, grant])

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

  return (
    <div className={styles.player}>
      <video
        ref={videoRef}
        data-testid="iptv-player-video"
        className={styles.video}
        src={grant.delivery === 'progressive' ? grant.url : undefined}
        controls
        playsInline
        preload="metadata"
      />

      {(audioTracks.length > 0 || subtitleTracks.length > 0) && (
        <div className={styles.controls}>
          {audioTracks.length > 0 && (
            <label className={styles.selector}>
              Audio
              <select value={selectedAudio} onChange={(e) => chooseAudioTrack(Number(e.target.value))}>
                {audioTracks.map((track) => (
                  <option key={track.id} value={track.id}>{track.label}</option>
                ))}
              </select>
            </label>
          )}

          {subtitleTracks.length > 0 && (
            <label className={styles.selector}>
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

      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
