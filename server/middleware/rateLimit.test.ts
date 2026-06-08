// Dedicated unit coverage for the token-bucket limiter in rateLimit.ts.
//
// The existing radarr.test.ts (lines ~841-902) covers three integration-y
// cases: admit-then-429 keyed per sub, the `rate_limited` error code, and
// independent budgets per session. This suite STRENGTHENS coverage by
// exercising the currently-untested branches:
//   - lazy time-based refill math (elapsed >= intervalMs)
//   - the Math.min capacity clamp (no token overflow)
//   - sub-interval elapsed does NOT refill
//   - IP fallback keying (cf-connecting-ip, then x-forwarded-for first hop)
//   - anonymous 'anon' bucket when no session and no IP headers
//   - the Retry-After header + retry_after_ms body on 429
//   - per-name registry isolation
//   - __resetRateLimitsForTests() clearing drained buckets
//   - handler short-circuit on 429
//
// Each `it` uses a UNIQUE limiter `name` so buckets never collide across
// cases, and beforeEach clears the registry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { rateLimit, __resetRateLimitsForTests } from './rateLimit.js'
import type { Env } from './auth.js'
import { env } from '../env.js'

/** Build an app whose limiter is keyed by a fixed session sub. */
function appWithSession(
  limiter: ReturnType<typeof rateLimit>,
  sub: string,
): Hono<Env> {
  const app = new Hono<Env>()
  app.use('*', async (c, next) => {
    c.set('session', { sub, username: sub, role: 'user' } as never)
    await next()
  })
  app.post('/x', limiter, (c) => c.json({ ok: true }))
  return app
}

/** Build an app with NO session (so the limiter falls back to IP/anon keying). */
function appNoSession(limiter: ReturnType<typeof rateLimit>): Hono<Env> {
  const app = new Hono<Env>()
  app.post('/x', limiter, (c) => c.json({ ok: true }))
  return app
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    __resetRateLimitsForTests()
    ;(env as Record<string, unknown>).trustClientIpHeaders = false
  })

  it('refills tokens after one full interval elapses (fake timers)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = rateLimit({ name: 'rl-refill', capacity: 2, refill: 2, intervalMs: 1000 })
    const app = appWithSession(limiter, 'plex:refill')

    // Drain the bucket: 2 admits, then 429.
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)

    // Advance one full interval — Date.now() moves 1000ms, restoring `refill` tokens.
    vi.advanceTimersByTime(1000)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('caps refill at capacity (no token overflow over many intervals)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = rateLimit({ name: 'rl-cap', capacity: 2, refill: 2, intervalMs: 1000 })
    const app = appWithSession(limiter, 'plex:cap')

    // Consume 1 of 2 tokens (1 left).
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)

    // Advance 10 intervals. Naive accumulation would yield 1 + 10*2 = 21 tokens;
    // the Math.min(capacity, ...) clamp pins it at capacity (2).
    vi.advanceTimersByTime(10_000)

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      statuses.push((await app.request('/x', { method: 'POST' })).status)
    }
    // At most `capacity` (2) succeed, then 429 — proving tokens did NOT overflow.
    expect(statuses).toEqual([200, 200, 429])
  })

  it('does NOT refill when less than one full interval has elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const limiter = rateLimit({ name: 'rl-frac', capacity: 1, refill: 1, intervalMs: 1000 })
    const app = appWithSession(limiter, 'plex:frac')

    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)

    // Half an interval — below the `elapsed >= intervalMs` guard, so no refill.
    vi.advanceTimersByTime(500)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)
  })

  it('falls back to cf-connecting-ip keying when there is no session', async () => {
    ;(env as Record<string, unknown>).trustClientIpHeaders = true
    const limiter = rateLimit({ name: 'rl-ip', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appNoSession(limiter)

    const sameIp = { 'cf-connecting-ip': '203.0.113.7' }
    expect((await app.request('/x', { method: 'POST', headers: sameIp })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST', headers: sameIp })).status).toBe(429)

    // A different IP gets its own fresh bucket.
    const otherIp = { 'cf-connecting-ip': '203.0.113.8' }
    expect((await app.request('/x', { method: 'POST', headers: otherIp })).status).toBe(200)
  })

  it('uses the first hop of x-forwarded-for when cf-connecting-ip is absent', async () => {
    ;(env as Record<string, unknown>).trustClientIpHeaders = true
    const limiter = rateLimit({ name: 'rl-xff', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appNoSession(limiter)

    const hopA = { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }
    expect((await app.request('/x', { method: 'POST', headers: hopA })).status).toBe(200)
    // Same first hop (198.51.100.4) → same bucket → 429, even though the rest differs.
    const hopASameFirst = { 'x-forwarded-for': '198.51.100.4, 172.16.0.9' }
    expect((await app.request('/x', { method: 'POST', headers: hopASameFirst })).status).toBe(429)

    // Different first hop → different bucket → 200.
    const hopB = { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }
    expect((await app.request('/x', { method: 'POST', headers: hopB })).status).toBe(200)
  })

  it('shares a single anon bucket when there is no session and no IP headers', async () => {
    const limiter = rateLimit({ name: 'rl-anon', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appNoSession(limiter)

    // Both header-less, session-less requests collapse to key 'anon'.
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)
  })

  it('ignores forwarded IP headers when proxy-header trust is disabled', async () => {
    const limiter = rateLimit({ name: 'rl-untrusted-ip', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appNoSession(limiter)

    expect((await app.request('/x', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    })).status).toBe(200)
    expect((await app.request('/x', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.8' },
    })).status).toBe(429)
  })

  it('emits a Retry-After header and retry_after_ms body hint on 429', async () => {
    const limiter = rateLimit({ name: 'rl-retry', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appWithSession(limiter, 'plex:retry')

    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    const r = await app.request('/x', { method: 'POST' })
    expect(r.status).toBe(429)

    const retryAfter = r.headers.get('Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(Number.isNaN(Number(retryAfter))).toBe(false)
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(0)

    const body = (await r.json()) as { error: string; retry_after_ms: number }
    expect(body.error).toBe('rate_limited')
    expect(typeof body.retry_after_ms).toBe('number')
    expect(body.retry_after_ms).toBeGreaterThanOrEqual(0)
  })

  it('keeps independent buckets per limiter name for the same caller', async () => {
    const limiterA = rateLimit({ name: 'rl-name-a', capacity: 1, refill: 1, intervalMs: 60_000 })
    const limiterB = rateLimit({ name: 'rl-name-b', capacity: 1, refill: 1, intervalMs: 60_000 })
    const sub = 'plex:shared'
    const appA = appWithSession(limiterA, sub)
    const appB = appWithSession(limiterB, sub)

    // Drain limiter A for this sub.
    expect((await appA.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await appA.request('/x', { method: 'POST' })).status).toBe(429)

    // Limiter B has its own registry for the same sub — still full.
    expect((await appB.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('__resetRateLimitsForTests() clears drained buckets back to full', async () => {
    const limiter = rateLimit({ name: 'rl-reset', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = appWithSession(limiter, 'plex:reset')

    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)

    __resetRateLimitsForTests()

    // Registry cleared — the limiter resolves a fresh full bucket on the next call.
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
  })

  it('does not run the route handler on a 429 (short-circuit)', async () => {
    let handlerHits = 0
    const limiter = rateLimit({ name: 'rl-short', capacity: 1, refill: 1, intervalMs: 60_000 })
    const app = new Hono<Env>()
    app.use('*', async (c, next) => {
      c.set('session', { sub: 'plex:short', username: 'short', role: 'user' } as never)
      await next()
    })
    app.post('/x', limiter, (c) => {
      handlerHits++
      return c.json({ ok: true })
    })

    expect((await app.request('/x', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/x', { method: 'POST' })).status).toBe(429)
    // The 429 request never reached the handler.
    expect(handlerHits).toBe(1)
  })

  afterEach(() => {
    // Never let fake-timer state leak into other suites (radarr.test.ts etc).
    vi.useRealTimers()
  })
})
