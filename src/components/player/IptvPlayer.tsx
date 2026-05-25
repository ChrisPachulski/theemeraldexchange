import { useEffect, useRef, useState } from 'react'
import type { StreamGrant } from '../../lib/api/iptv'
import styles from './IptvPlayer.module.css'

type TrackOption = {
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
}

export type IptvPlayerProps = {
  grant: StreamGrant
  autoPlay?: boolean
  startPositionSecs?: number
  onPositionUpdate?: (pos: number, durationSecs: number | null) => void
  onEnded?: () => void
}

function labelForTrack(track: { name?: string; lang?: string; label?: string; language?: string }, index: number): string {
  return track.name || track.label || track.lang || track.language || `Track ${index + 1}`
}

function audioOptionsFromVideo(video: VideoWithTracks): TrackOption[] {
  const tracks = video.audioTracks
  if (!tracks?.length) return []
  return Array.from({ length: tracks.length }, (_, id) => ({
    id,
    label: labelForTrack(tracks[id], id),
  }))
}

function subtitleOptionsFromVideo(video: HTMLVideoElement): TrackOption[] {
  const tracks = video.textTracks
  if (!tracks?.length) return []
  return Array.from({ length: tracks.length }, (_, id) => ({
    id,
    label: labelForTrack(tracks[id], id),
  }))
}

function selectedAudioFromVideo(video: VideoWithTracks): number {
  const tracks = video.audioTracks
  if (!tracks?.length) return 0
  for (let i = 0; i < tracks.length; i += 1) {
    if (tracks[i].enabled) return i
  }
  return 0
}

function selectedSubtitleFromVideo(video: HTMLVideoElement): number {
  const tracks = video.textTracks
  for (let i = 0; i < tracks.length; i += 1) {
    if (tracks[i].mode === 'showing') return i
  }
  return -1
}

function safePlay(video: HTMLVideoElement): void {
  void video.play().catch(() => undefined)
}

function setNativeAudioTrack(video: VideoWithTracks, trackId: number): void {
  const tracks = video.audioTracks
  if (!tracks?.length) return
  for (let i = 0; i < tracks.length; i += 1) {
    tracks[i].enabled = i === trackId
  }
}

function setNativeSubtitleTrack(video: HTMLVideoElement, trackId: number): void {
  for (let i = 0; i < video.textTracks.length; i += 1) {
    video.textTracks[i].mode = i === trackId ? 'showing' : 'disabled'
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

        const hls = new Hls()
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
        hls.loadSource(grant.url)
        hls.attachMedia(video)
        cleanupEngine = () => hls.destroy()
        updateHlsTracks()
        if (autoPlay) safePlay(video)
        return
      }

      const mpegts = (await import('mpegts.js')).default
      if (cancelled) return
      if (!mpegts.isSupported()) {
        setError('MPEG-TS playback is not supported in this browser.')
        return
      }

      const player: MpegtsPlayer = mpegts.createPlayer({ type: 'mpegts', url: grant.url })
      player.attachMediaElement(video)
      player.load()
      cleanupEngine = () => {
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
    const hls = hlsRef.current
    if (hls) {
      hls.audioTrack = trackId
      setSelectedAudio(trackId)
      return
    }

    const video = videoRef.current as VideoWithTracks | null
    if (!video) return
    const tracks = video.audioTracks
    if (!tracks?.length) return
    setNativeAudioTrack(video, trackId)
    setSelectedAudio(trackId)
  }

  const chooseSubtitleTrack = (trackId: number) => {
    const hls = hlsRef.current
    if (hls) {
      hls.subtitleTrack = trackId
      setSelectedSubtitle(trackId)
      return
    }

    const video = videoRef.current
    if (!video) return
    setNativeSubtitleTrack(video, trackId)
    setSelectedSubtitle(trackId)
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
