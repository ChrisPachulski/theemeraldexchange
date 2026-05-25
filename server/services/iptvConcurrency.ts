import { env } from '../env.js'

export interface AcquireOpts { sub: string; sessionId: string }
export type AcquireResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'iptv_concurrency_limit'; limit: number; current: number }

interface Session { sub: string; sessionId: string; lastSeen: number }

export interface ConcurrencyTracker {
  tryAcquire: (opts: AcquireOpts) => AcquireResult
  heartbeat: (sessionId: string) => void
  release: (sessionId: string) => void
  sweep: () => void
  size: () => number
}

export function createConcurrencyTracker(opts: { cap: number; idleMs: number }): ConcurrencyTracker {
  const sessions = new Map<string, Session>()

  function sweep(): void {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > opts.idleMs) sessions.delete(id)
    }
  }

  function tryAcquire({ sub, sessionId }: AcquireOpts): AcquireResult {
    sweep()
    if (sessions.has(sessionId)) {
      sessions.get(sessionId)!.lastSeen = Date.now()
      return { ok: true, sessionId }
    }
    if (sessions.size >= opts.cap) {
      return { ok: false, reason: 'iptv_concurrency_limit', limit: opts.cap, current: sessions.size }
    }
    sessions.set(sessionId, { sub, sessionId, lastSeen: Date.now() })
    return { ok: true, sessionId }
  }

  function heartbeat(sessionId: string): void {
    const s = sessions.get(sessionId)
    if (s) s.lastSeen = Date.now()
  }

  function release(sessionId: string): void {
    sessions.delete(sessionId)
  }

  return { tryAcquire, heartbeat, release, sweep, size: () => sessions.size }
}

let singleton: ConcurrencyTracker | null = null
export function streamConcurrency(): ConcurrencyTracker {
  if (!singleton) singleton = createConcurrencyTracker({ cap: env.IPTV_MAX_CONCURRENT_STREAMS, idleMs: 30_000 })
  return singleton
}
