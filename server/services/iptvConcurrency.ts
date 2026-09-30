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
  // Additional upstream budget shared by live/remux/DVR reservations.
  // Other kinds count only themselves; VOD/series do not consume live slots.
  kindCap?: number
  /** Replace this viewer's live reservations only after admission succeeds. */
  replaceLive?: boolean
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

/** Covers the remux's eighty-second window and buffered fetch gaps. */
export const REMUX_IDLE_MS = 90_000

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
      const idleMs = s.kind === 'remux' ? Math.max(opts.idleMs, REMUX_IDLE_MS) : opts.idleMs
      if (now - s.lastSeen > idleMs) sessions.delete(id)
    }
  }

  function list(): SessionView[] {
    sweep()
    return Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  function tryAcquire({ sub, sessionId, kind, resourceId, ip, title, kindCap, replaceLive }: AcquireOpts): AcquireResult {
    sweep()
    const existing = sessions.get(sessionId)
    if (existing) {
      existing.lastSeen = Date.now()
      return { ok: true, sessionId }
    }
    const isLive = (k: SessionKind): boolean => k === 'live' || k === 'remux'
    const replaced = Array.from(sessions.values()).filter(s => s.sub === sub && (
      (s.kind === kind && s.resourceId === resourceId) || (replaceLive && isLive(kind) && isLive(s.kind))
    ))
    const replacedIds = new Set(replaced.map(s => s.sessionId))
    const remaining = Array.from(sessions.values()).filter(s => !replacedIds.has(s.sessionId))
    if (kindCap !== undefined) {
      const count = remaining.filter(s => isLive(kind) ? isLive(s.kind) : s.kind === kind).length
      if (count >= kindCap) return {
        ok: false, reason: 'iptv_concurrency_limit', limit: kindCap, current: count,
        sessions: list(),
      }
    }
    if (remaining.length >= opts.cap) return {
      ok: false, reason: 'iptv_concurrency_limit', limit: opts.cap, current: remaining.length,
      sessions: list(),
    }
    for (const id of replacedIds) sessions.delete(id)
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
