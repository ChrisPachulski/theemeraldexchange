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

  it('dedupes a re-grant for the same (sub, kind, resourceId) — no double-booking', () => {
    const t = createConcurrencyTracker({ cap: 2, idleMs: 30_000 })
    // Same user re-selects the SAME channel (resourceId '1') with a fresh
    // sessionId. Must REPLACE the prior session, not hold two slots.
    expect(t.tryAcquire(baseOpts('u1', 's1')).ok).toBe(true)
    expect(t.tryAcquire(baseOpts('u1', 's2')).ok).toBe(true)
    expect(t.size()).toBe(1)
    expect(t.list().map((s) => s.sessionId)).toEqual(['s2'])
  })

  it('does NOT dedupe different channels for the same user', () => {
    const t = createConcurrencyTracker({ cap: 2, idleMs: 30_000 })
    expect(t.tryAcquire(baseOpts('u1', 's1')).ok).toBe(true) // resourceId '1'
    expect(t.tryAcquire({ ...baseOpts('u1', 's2'), resourceId: '2' }).ok).toBe(true)
    expect(t.size()).toBe(2)
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

  it('a live stream held >30s WITH periodic byte-path heartbeats keeps its slot (finding 8-1)', () => {
    // Regression for finding 8-1: previously the live/segment byte handlers
    // never heartbeat the grant session, so a long live view with no re-grant
    // was idle-reaped after the 30s window even while bytes flowed. The byte
    // handlers now call heartbeat() on each chunk/range request — simulate
    // that and assert the slot survives well past the idle window.
    const t = createConcurrencyTracker({ cap: 1, idleMs: 30_000 })
    expect(t.tryAcquire(baseOpts('u1', 's1')).ok).toBe(true)
    // 90 seconds of playback, a heartbeat every 10s (as a streaming byte path
    // would issue). The slot must never be reaped.
    for (let elapsed = 0; elapsed < 90_000; elapsed += 10_000) {
      vi.advanceTimersByTime(10_000)
      t.heartbeat('s1')
      t.sweep()
      expect(t.size()).toBe(1)
    }
    // A second user still cannot acquire — the long-running stream holds the cap.
    expect(t.tryAcquire(baseOpts('u2', 's2')).ok).toBe(false)
  })
})
