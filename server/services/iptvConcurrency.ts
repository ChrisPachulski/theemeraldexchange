import { env } from '../env.js'

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
}
export type AcquireResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'iptv_concurrency_limit'; limit: number; current: number; sessions: SessionView[] }

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

interface Session extends SessionView {}

export interface ConcurrencyTracker {
  tryAcquire: (opts: AcquireOpts) => AcquireResult
  heartbeat: (sessionId: string) => void
  release: (sessionId: string) => void
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

  function tryAcquire({ sub, sessionId, kind, resourceId, ip, title }: AcquireOpts): AcquireResult {
    sweep()
    const existing = sessions.get(sessionId)
    if (existing) {
      existing.lastSeen = Date.now()
      return { ok: true, sessionId }
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

  function release(sessionId: string): void {
    sessions.delete(sessionId)
  }

  return { tryAcquire, heartbeat, release, sweep, size: () => sessions.size, list }
}

let singleton: ConcurrencyTracker | null = null
export function streamConcurrency(): ConcurrencyTracker {
  if (!singleton) singleton = createConcurrencyTracker({ cap: env.IPTV_MAX_CONCURRENT_STREAMS, idleMs: 30_000 })
  return singleton
}
