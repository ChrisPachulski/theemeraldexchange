import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createConcurrencyTracker } from './iptvConcurrency.js'

const baseOpts = (sub: string, sessionId: string) => ({
  sub,
  sessionId,
  kind: 'live' as const,
  resourceId: '1',
  ip: null,
  title: null,
})

describe('iptv concurrency tracker', () => {
  beforeEach(() => vi.useFakeTimers())

  it('grants up to the cap then 429s', () => {
    const t = createConcurrencyTracker({ cap: 2, idleMs: 30_000 })
    const a = t.tryAcquire(baseOpts('u1', 's1'))
    const b = t.tryAcquire(baseOpts('u2', 's2'))
    const c = t.tryAcquire(baseOpts('u3', 's3'))
    expect(a.ok && b.ok).toBe(true)
    expect(c.ok).toBe(false)
    if (!c.ok && c.reason === 'iptv_concurrency_limit') {
      // The 429 payload now includes the active sessions so the UI can
      // show them inline and let the user kick one.
      expect(c.sessions).toHaveLength(2)
      expect(c.sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
    } else {
      throw new Error('expected iptv_concurrency_limit')
    }
  })

  it('releases on heartbeat timeout', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire(baseOpts('u1', 's1'))
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(false)
    vi.advanceTimersByTime(150)
    t.sweep()
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(true)
  })

  it('heartbeat resets idle timer', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire(baseOpts('u1', 's1'))
    vi.advanceTimersByTime(80)
    t.heartbeat('s1')
    vi.advanceTimersByTime(80)
    t.sweep()
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(false)
  })

  it('list() returns sessions sorted newest first with metadata', () => {
    const t = createConcurrencyTracker({ cap: 5, idleMs: 30_000 })
    t.tryAcquire({ ...baseOpts('u1', 's1'), kind: 'live', resourceId: '100', title: 'TNT' })
    vi.advanceTimersByTime(50)
    t.tryAcquire({ ...baseOpts('u2', 's2'), kind: 'vod', resourceId: '200', title: 'Inception', ip: '10.0.0.5' })
    const list = t.list()
    expect(list).toHaveLength(2)
    expect(list[0].sessionId).toBe('s2')
    expect(list[0].kind).toBe('vod')
    expect(list[0].ip).toBe('10.0.0.5')
    expect(list[0].title).toBe('Inception')
    expect(list[1].sessionId).toBe('s1')
  })

  it('release() frees a slot immediately', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 30_000 })
    t.tryAcquire(baseOpts('u1', 's1'))
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(false)
    t.release('s1')
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(true)
  })
})
