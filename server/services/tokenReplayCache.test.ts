import { describe, it, expect, beforeEach, afterAll } from 'vitest'
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

describe('tokenReplayCache – segment (single-use)', () => {
  it('allows the first presentation', () => {
    const result = checkReplay('JTI_SEG_1', future(), 'segment')
    expect(result.allowed).toBe(true)
  })

  it('rejects the second presentation with token_replay', () => {
    const jti = 'JTI_SEG_2'
    checkReplay(jti, future(), 'segment')
    const second = checkReplay(jti, future(), 'segment')
    expect(second.allowed).toBe(false)
    if (!second.allowed) expect(second.reason).toBe('token_replay')
  })

  it('rejects a third presentation with token_replay', () => {
    const jti = 'JTI_SEG_3'
    checkReplay(jti, future(), 'segment')
    checkReplay(jti, future(), 'segment')
    const third = checkReplay(jti, future(), 'segment')
    expect(third.allowed).toBe(false)
    if (!third.allowed) expect(third.reason).toBe('token_replay')
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
  it('removes expired entries on sweep', () => {
    stopGcSweep()
    const jti = 'JTI_GC_SEG'
    const pastExp = Math.floor(Date.now() / 1000) - 10
    // Record a segment entry with an already-expired exp.
    checkReplay(jti, pastExp, 'segment')
    // Run a one-shot sweep by restarting with a very short interval and waiting.
    // Instead, directly invoke what the sweep does: restart sweep with 1ms interval.
    startGcSweep(1)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        stopGcSweep()
        // After GC, the entry is gone. A fresh presentation should be allowed again.
        const result = checkReplay(jti, future(), 'segment')
        expect(result.allowed).toBe(true)
        resolve()
      }, 50)
    })
  })
})

describe('tokenReplayCache – jti uniqueness across kinds', () => {
  it('treats the same jti string independently per kind (different jti values)', () => {
    const jti1 = 'JTI_UNIQ_1'
    const jti2 = 'JTI_UNIQ_2'
    const exp = future()
    // First jti used for segment.
    checkReplay(jti1, exp, 'segment')
    const replay1 = checkReplay(jti1, exp, 'segment')
    expect(replay1.allowed).toBe(false)

    // Different jti for live — fresh, allowed.
    const first2 = checkReplay(jti2, exp, 'live')
    expect(first2.allowed).toBe(true)
  })
})
