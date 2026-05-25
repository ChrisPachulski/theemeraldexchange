import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createConcurrencyTracker } from './iptvConcurrency.js'

describe('iptv concurrency tracker', () => {
  beforeEach(() => vi.useFakeTimers())

  it('grants up to the cap then 429s', () => {
    const t = createConcurrencyTracker({ cap: 2, idleMs: 30_000 })
    const a = t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    const b = t.tryAcquire({ sub: 'u2', sessionId: 's2' })
    const c = t.tryAcquire({ sub: 'u3', sessionId: 's3' })
    expect(a.ok && b.ok).toBe(true)
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe('iptv_concurrency_limit')
  })

  it('releases on heartbeat timeout', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(false)
    vi.advanceTimersByTime(150)
    t.sweep()
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(true)
  })

  it('heartbeat resets idle timer', () => {
    const t = createConcurrencyTracker({ cap: 1, idleMs: 100 })
    t.tryAcquire({ sub: 'u1', sessionId: 's1' })
    vi.advanceTimersByTime(80)
    t.heartbeat('s1')
    vi.advanceTimersByTime(80)
    t.sweep()
    expect(t.tryAcquire({ sub: 'u2', sessionId: 's2' }).ok).toBe(false)
  })
})
