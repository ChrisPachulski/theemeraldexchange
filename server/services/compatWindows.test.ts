import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  DATED_COMPAT_WINDOWS,
  warnExpiredCompatWindows,
  type CompatWindow,
} from './compatWindows.js'

describe('dated compat-window registry', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  const sample: CompatWindow[] = [
    {
      id: 'already-expired',
      expiresAt: '2026-01-01T00:00:00Z',
      location: 'somewhere.ts',
      remediation: 'delete it',
    },
    {
      id: 'still-open',
      expiresAt: '2099-01-01T00:00:00Z',
      location: 'elsewhere.ts',
      remediation: 'wait',
    },
  ]

  it('warns for (and returns) only windows past their expiry', () => {
    const expired = warnExpiredCompatWindows(new Date('2026-06-11T00:00:00Z'), sample)
    expect(expired.map((w) => w.id)).toEqual(['already-expired'])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = String(warnSpy.mock.calls[0][0])
    expect(line).toContain('already-expired')
    expect(line).toContain('somewhere.ts')
  })

  it('is silent while every window is still inside its date', () => {
    const expired = warnExpiredCompatWindows(new Date('2025-01-01T00:00:00Z'), sample)
    expect(expired).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('fires exactly at the expiry instant (>= semantics)', () => {
    const expired = warnExpiredCompatWindows(new Date('2026-01-01T00:00:00Z'), sample)
    expect(expired.map((w) => w.id)).toEqual(['already-expired'])
  })

  it('every registered window has a parseable expiry and remediation', () => {
    expect(DATED_COMPAT_WINDOWS.length).toBeGreaterThan(0)
    for (const w of DATED_COMPAT_WINDOWS) {
      expect(Number.isFinite(Date.parse(w.expiresAt))).toBe(true)
      expect(w.id.length).toBeGreaterThan(0)
      expect(w.location.length).toBeGreaterThan(0)
      expect(w.remediation.length).toBeGreaterThan(0)
    }
  })

  it('the real registry warns once its dates pass (boot observability)', () => {
    // Far future: every currently-registered window must surface, proving the
    // boot call cannot silently outlive an expiry.
    const expired = warnExpiredCompatWindows(new Date('2099-12-31T00:00:00Z'))
    expect(expired.length).toBe(DATED_COMPAT_WINDOWS.length)
    expect(warnSpy).toHaveBeenCalledTimes(DATED_COMPAT_WINDOWS.length)
  })
})
