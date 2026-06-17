import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  checkReplay,
  clearReplayCache,
  stopGcSweep,
  startGcSweep,
} from './tokenReplayCache.js'

// Stop the module-level GC sweep so it doesn't interfere with tests or
// leave open handles that cause Vitest to warn about resource leaks.
afterAll(() => {
  stopGcSweep()
})

beforeEach(() => {
  clearReplayCache()
})

const future = () => Math.floor(Date.now() / 1000) + 300

describe('tokenReplayCache – segment (multi-use within TTL; MED-17)', () => {
  // Segment tokens were strict single-use, which broke HLS seek-back / buffer
  // recovery (the player re-fetches the same segment). They are now multi-use
  // within TTL like every other kind — a segment token is bound to one segment
  // URL and lives only 300s, so re-presentation re-fetches the same segment.
  it('allows the first presentation', () => {
    const result = checkReplay('JTI_SEG_1', future(), 'segment')
    expect(result.allowed).toBe(true)
  })

  it('allows repeated presentations within TTL (seek-back / buffer recovery)', () => {
    const jti = 'JTI_SEG_2'
    const exp = future()
    expect(checkReplay(jti, exp, 'segment').allowed).toBe(true)
    expect(checkReplay(jti, exp, 'segment').allowed).toBe(true)
    expect(checkReplay(jti, exp, 'segment').allowed).toBe(true)
  })

  it('rejects a segment token re-presented after exp', () => {
    const jti = 'JTI_SEG_3'
    const pastExp = Math.floor(Date.now() / 1000) - 10
    checkReplay(jti, pastExp, 'segment')
    const second = checkReplay(jti, pastExp, 'segment')
    expect(second.allowed).toBe(false)
    if (!second.allowed) expect(second.reason).toBe('token_expired')
  })
})

describe('tokenReplayCache – multi-use kinds (live / vod / series / catchup / remux)', () => {
  for (const kind of ['live', 'vod', 'series', 'catchup', 'remux'] as const) {
    it(`allows repeated presentations for ${kind} within TTL`, () => {
      const jti = `JTI_MULTI_${kind}`
      const exp = future()
      expect(checkReplay(jti, exp, kind).allowed).toBe(true)
      expect(checkReplay(jti, exp, kind).allowed).toBe(true)
      expect(checkReplay(jti, exp, kind).allowed).toBe(true)
    })

    it(`rejects ${kind} token when exp is in the past`, () => {
      const jti = `JTI_EXPIRED_${kind}`
      const pastExp = Math.floor(Date.now() / 1000) - 10
      // First presentation records it.
      checkReplay(jti, pastExp, kind)
      // Second presentation with a past exp is rejected.
      const result = checkReplay(jti, pastExp, kind)
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.reason).toBe('token_expired')
    })
  }
})

describe('tokenReplayCache – playlist (excluded)', () => {
  it('always allows playlist tokens', () => {
    // playlist is excluded from this cache; we cast to bypass TS type guard.
    const result = checkReplay('JTI_PLAYLIST', future(), 'playlist' as Parameters<typeof checkReplay>[2])
    expect(result.allowed).toBe(true)
    // A second call also passes through.
    const result2 = checkReplay('JTI_PLAYLIST', future(), 'playlist' as Parameters<typeof checkReplay>[2])
    expect(result2.allowed).toBe(true)
  })
})

describe('tokenReplayCache – GC sweep', () => {
  // LOW-45: deterministic via fake timers — no real wall-clock wait, no CI flake.
  it('removes expired entries on sweep', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    try {
      stopGcSweep()
      const jti = 'JTI_GC_SEG'
      const pastExp = Math.floor(Date.now() / 1000) - 10
      // Record a segment entry whose exp is already in the past.
      checkReplay(jti, pastExp, 'segment')
      startGcSweep(1000)
      vi.advanceTimersByTime(1100) // fire the sweep at least once
      stopGcSweep()
      // If GC removed the entry, a fresh presentation records a new (unexpired)
      // entry and is allowed. If GC had NOT removed it, the stale expired entry
      // would make checkReplay return token_expired — so this asserts the sweep.
      const result = checkReplay(jti, Math.floor(Date.now() / 1000) + 300, 'segment')
      expect(result.allowed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tokenReplayCache – distinct jtis are independent', () => {
  it('records each jti separately and allows re-presentation within TTL', () => {
    const jti1 = 'JTI_UNIQ_1'
    const jti2 = 'JTI_UNIQ_2'
    const exp = future()
    // Segment jti: first presentation records it, re-presentation still allowed
    // within TTL (multi-use).
    checkReplay(jti1, exp, 'segment')
    expect(checkReplay(jti1, exp, 'segment').allowed).toBe(true)

    // A different jti for live is independent — fresh, allowed.
    expect(checkReplay(jti2, exp, 'live').allowed).toBe(true)
  })
})
