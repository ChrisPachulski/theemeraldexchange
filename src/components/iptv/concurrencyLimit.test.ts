import { describe, it, expect } from 'vitest'
import { concurrencyPayloadFromError } from './concurrencyLimit'
import { ApiError } from '../../lib/api/errors'
import type { SessionRow } from '../../lib/api/iptv'

// concurrencyPayloadFromError is the pure parser that IPTV components
// (LiveTab x2) feed a thrown error into to decide whether to surface the
// concurrency-limit modal on a 429. It has several
// silent guard branches (null/non-object, non-429, wrong/missing reason,
// garbage fields). A regression here silently breaks the modal, so each
// guard and fallback is pinned below.

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'sess-1',
    sub: 'local:01ABCDEF',
    kind: 'live',
    resourceId: 'res-1',
    title: 'Channel 1',
    resolvedTitle: 'Channel 1',
    ip: '10.0.0.1',
    startedAt: 1_700_000_000_000,
    lastSeen: 1_700_000_001_000,
    ...overrides,
  }
}

describe('concurrencyPayloadFromError', () => {
  it('returns null for null', () => {
    expect(concurrencyPayloadFromError(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(concurrencyPayloadFromError(undefined)).toBeNull()
  })

  it('returns null for a primitive string and a number', () => {
    expect(concurrencyPayloadFromError('boom')).toBeNull()
    expect(concurrencyPayloadFromError(429)).toBeNull()
  })

  it('returns null when status is not 429', () => {
    const err = new ApiError(500, 'x', undefined, { reason: 'iptv_concurrency_limit' })
    expect(concurrencyPayloadFromError(err)).toBeNull()
  })

  it('returns null when status is 429 but reason is missing entirely', () => {
    const err = new ApiError(429, 'x', undefined, {})
    expect(concurrencyPayloadFromError(err)).toBeNull()
  })

  it('returns null when status is 429 but reason is a different reason', () => {
    const err = new ApiError(429, 'x', undefined, { reason: 'rate_limited' })
    expect(concurrencyPayloadFromError(err)).toBeNull()
  })

  it('returns the payload on the happy path (429 + correct reason)', () => {
    const session = makeSession()
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      limit: 2,
      current: 2,
      sessions: [session],
    })
    expect(concurrencyPayloadFromError(err)).toEqual({
      limit: 2,
      current: 2,
      sessions: [session],
    })
  })

  it('falls back current to sessions.length when current is absent', () => {
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      limit: 2,
      sessions: [makeSession()],
    })
    const result = concurrencyPayloadFromError(err)
    expect(result).not.toBeNull()
    expect(result?.current).toBe(1)
    expect(result?.sessions).toHaveLength(1)
  })

  it('falls back sessions to [] when details.sessions is not an array', () => {
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      limit: 3,
      sessions: 'nope',
    })
    const result = concurrencyPayloadFromError(err)
    expect(result).not.toBeNull()
    expect(result?.sessions).toEqual([])
    expect(result?.current).toBe(0)
  })

  it('falls back limit to 0 when details has no limit field', () => {
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      sessions: [],
    })
    const result = concurrencyPayloadFromError(err)
    expect(result).not.toBeNull()
    expect(result?.limit).toBe(0)
  })

  it('coerces numeric string limit/current via Number()', () => {
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      limit: '5',
      current: '4',
      sessions: [],
    })
    const result = concurrencyPayloadFromError(err)
    expect(result).not.toBeNull()
    expect(result?.limit).toBe(5)
    expect(result?.current).toBe(4)
  })

  it('honors an explicit current:0 over sessions.length (?? not ||)', () => {
    // Guards the nullish-vs-falsy fallback: a legit current:0 alongside a
    // non-empty sessions array must stay 0, not silently fall back to
    // sessions.length. A `?? -> ||` regression would surface a wrong count.
    const err = new ApiError(429, 'x', undefined, {
      reason: 'iptv_concurrency_limit',
      limit: 2,
      current: 0,
      sessions: [makeSession(), makeSession({ sessionId: 'sess-2' })],
    })
    const result = concurrencyPayloadFromError(err)
    expect(result).not.toBeNull()
    expect(result?.current).toBe(0)
    expect(result?.sessions).toHaveLength(2)
  })
})
