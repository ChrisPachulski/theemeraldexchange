import { env } from '../env.js'
import type { SourceUnavailablePayload } from './sourcePrecedence.js'

/**
 * Concurrency-tracker session kinds. Note that `'remux'` has dual membership: it is a valid
 * kind for the concurrency tracker (used when acquiring/releasing sessions for AVPlayer remux
 * playback) AND a valid stream token kind in `StreamKind`. Both enums retain `'remux'` — an
 * earlier draft incorrectly proposed removing it from `StreamKind`, which would have broken
 * segment token validation on the same remux session. See §5.3 of the M1.5 contract.
 */
export type SessionKind = 'live' | 'vod' | 'series' | 'catchup' | 'remux'

export interface AcquireOpts {
  sub: string
  sessionId: string
  kind: SessionKind
  resourceId: string
  ip?: string | null
  title?: string | null
  // Optional cap scoped to sessions of THIS kind, checked in ADDITION to the
  // global cap. The remux path opens a HARD-capped live upstream connection
  // (IPTV_MAX_UPSTREAM_CONNECTIONS ffmpeg sessions); granting more remux slots
  // than that just gets the surplus viewer silently ffmpeg-evicted mid-stream
  // when its session spawns past the ceiling. So the remux grant passes
  // kindCap = min(concurrent, upstream) and the surplus grant is rejected HERE
  // with the structured iptv_concurrency_limit 429 the client already renders,
  // instead of the silent eviction. Scoped to same-kind sessions so VOD/series
  // (which open no live upstream connection) are never limited by it.
  kindCap?: number
}
// Closed `reason` enum values for grant-endpoint denials (§12.4).
// Extend only with a contract bump — Swift Decodable switch-exhausts on
// this enum; adding a value without a client release is a crash vector.
//
//   'iptv_concurrency_limit'  — too many concurrent IPTV streams.
//   'source_unavailable'      — rank-1 source offline mid-session; client
//                               must surface explicit user action with the
//                               available_alternatives payload (§9 / §12.4).
export type AcquireResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'iptv_concurrency_limit'; limit: number; current: number; sessions: SessionView[] }
  | { ok: false; reason: 'source_unavailable'; available_alternatives: SourceUnavailablePayload['available_alternatives'] }

export interface SessionView {
  sessionId: string
  sub: string
  kind: SessionKind
  resourceId: string
  title: string | null
  ip: string | null
  startedAt: number
  lastSeen: number
}

type Session = SessionView

export interface ConcurrencyTracker {
  tryAcquire: (opts: AcquireOpts) => AcquireResult
  heartbeat: (sessionId: string) => void
  /**
   * Heartbeat the active session matching (sub, kind, resourceId) — the same
   * tuple tryAcquire dedupes on. The byte-serving handlers know the user's
   * sub (from the stream token) and the kind+resourceId from the route, but
   * NOT the opaque sessionId minted at grant time, so they keep a stream's
   * slot alive through this resource-keyed path instead of the id-keyed one
   * (finding 8-1). Returns true when a matching session was refreshed.
   */
  heartbeatByResource: (sub: string, kind: SessionKind, resourceId: string) => boolean
  release: (sessionId: string) => void
  /** Resource-keyed counterpart to release() for the byte-path handlers. */
  releaseByResource: (sub: string, kind: SessionKind, resourceId: string) => boolean
  sweep: () => void
  size: () => number
  list: () => SessionView[]
}

export function createConcurrencyTracker(opts: { cap: number; idleMs: number }): ConcurrencyTracker {
  const sessions = new Map<string, Session>()

  function sweep(): void {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > opts.idleMs) sessions.delete(id)
    }
  }

  function list(): SessionView[] {
    sweep()
    return Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  function tryAcquire({ sub, sessionId, kind, resourceId, ip, title, kindCap }: AcquireOpts): AcquireResult {
    sweep()
    const existing = sessions.get(sessionId)
    if (existing) {
      existing.lastSeen = Date.now()
      return { ok: true, sessionId }
    }
    // Dedupe by (sub, kind, resourceId): a re-grant for a channel the same
    // user is ALREADY watching supersedes the prior session rather than
    // booking a SECOND slot against the upstream connection cap. Without
    // this, selecting the same channel twice held two connections — and on a
    // ~2-slot provider line, two such double-books saturate it and every
    // further grant stalls. Replacing also frees the stale slot immediately
    // (the old player is being torn down and re-created with the new token).
    for (const [id, s] of sessions) {
      if (s.sub === sub && s.kind === kind && s.resourceId === resourceId) {
        sessions.delete(id)
      }
    }
    // Kind-scoped cap (remux ↔ upstream-connection ceiling). Checked after the
    // dedupe above so a re-grant for a channel the same user already holds does
    // not count itself. Reuses the iptv_concurrency_limit shape so the client
    // renders "provider connection limit reached" instead of the silent
    // mid-stream eviction it would get past the upstream cap.
    if (kindCap !== undefined) {
      let sameKind = 0
      for (const s of sessions.values()) if (s.kind === kind) sameKind++
      if (sameKind >= kindCap) {
        return {
          ok: false,
          reason: 'iptv_concurrency_limit',
          limit: kindCap,
          current: sameKind,
          sessions: Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt),
        }
      }
    }
    if (sessions.size >= opts.cap) {
      return {
        ok: false,
        reason: 'iptv_concurrency_limit',
        limit: opts.cap,
        current: sessions.size,
        sessions: Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt),
      }
    }
    const now = Date.now()
    sessions.set(sessionId, {
      sub,
      sessionId,
      kind,
      resourceId,
      title: title ?? null,
      ip: ip ?? null,
      startedAt: now,
      lastSeen: now,
    })
    return { ok: true, sessionId }
  }

  function heartbeat(sessionId: string): void {
    const s = sessions.get(sessionId)
    if (s) s.lastSeen = Date.now()
  }

  function findByResource(sub: string, kind: SessionKind, resourceId: string): Session | undefined {
    for (const s of sessions.values()) {
      if (s.sub === sub && s.kind === kind && s.resourceId === resourceId) return s
    }
    return undefined
  }

  function heartbeatByResource(sub: string, kind: SessionKind, resourceId: string): boolean {
    const s = findByResource(sub, kind, resourceId)
    if (!s) return false
    s.lastSeen = Date.now()
    return true
  }

  function release(sessionId: string): void {
    sessions.delete(sessionId)
  }

  function releaseByResource(sub: string, kind: SessionKind, resourceId: string): boolean {
    const s = findByResource(sub, kind, resourceId)
    if (!s) return false
    sessions.delete(s.sessionId)
    return true
  }

  return {
    tryAcquire,
    heartbeat,
    heartbeatByResource,
    release,
    releaseByResource,
    sweep,
    size: () => sessions.size,
    list,
  }
}

let singleton: ConcurrencyTracker | null = null
export function streamConcurrency(): ConcurrencyTracker {
  if (!singleton) singleton = createConcurrencyTracker({ cap: env.IPTV_MAX_CONCURRENT_STREAMS, idleMs: 30_000 })
  return singleton
}
