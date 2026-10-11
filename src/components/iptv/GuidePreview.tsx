import { useEffect, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type StreamGrant } from '../../lib/api/iptv'

export const PREVIEW_REST_MS = 1_500

const mute = (video: HTMLVideoElement | null) => {
  if (video) video.muted = true
}

// Muted live preview for the guide's detail pane (Apple GuidePreview.swift).
// The owner mounts one per channel (keyed by stream id). The grant is minted
// only once the pointer has rested PREVIEW_REST_MS, so sweeping across the grid
// never churns the provider, and it asks for intent=preview so it can't evict
// this account's watch on another device. Unmounting (focus moved, preview
// turned off, the real player opened) releases the session.
export function GuidePreview({ streamId, name }: { streamId: number; name: string }) {
  const [grant, setGrant] = useState<StreamGrant | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let sessionId: string | undefined
    const timer = setTimeout(() => {
      iptvApi.grantLive(String(streamId), { intent: 'preview' }).then(
        (g) => {
          if (!cancelled) {
            sessionId = g.sessionId
            setGrant(g)
          } else if (g.sessionId) {
            void iptvApi.killSession(g.sessionId).catch(() => undefined)
          }
        },
        // Best-effort (a 429 included): the pane just says so.
        () => {
          if (!cancelled) setFailed(true)
        },
      )
    }, PREVIEW_REST_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // A borrowed preview (same channel already playing here) has no session.
      if (sessionId) void iptvApi.killSession(sessionId).catch(() => undefined)
    }
  }, [streamId])

  return (
    <div className="epg-detail__preview" role="group" aria-label={`${name} live preview`}>
      {grant ? (
        <IptvPlayer grant={grant} autoPlay nativeControls={false} onVideoElement={mute} />
      ) : (
        <span>{failed ? 'Preview unavailable' : name}</span>
      )}
    </div>
  )
}
