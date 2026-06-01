import { describe, it, expect } from 'vitest'
import type { Context } from 'hono'
import { clientIp } from './iptv.js'
import type { Env } from '../middleware/auth.js'

function ctx(headers: Record<string, string>): Context<Env> {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as Context<Env>
}

describe('clientIp', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', () => {
    expect(
      clientIp(ctx({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })),
    ).toBe('203.0.113.7')
  })
  it('falls back to first x-forwarded-for entry, trimmed', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': ' 198.51.100.1 , 10.0.0.1 , 10.0.0.2 ' }))).toBe(
      '198.51.100.1',
    )
  })
  it('handles a single-value x-forwarded-for', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '198.51.100.1' }))).toBe('198.51.100.1')
  })
  it('returns null when no ip headers are present', () => {
    expect(clientIp(ctx({}))).toBeNull()
  })
  it('returns empty string (not null) for a leading-comma x-forwarded-for — documents current split[0].trim behavior', () => {
    // ',1.2.3.4' -> split[0] === '' -> ''.trim() === '' (falsy but returned as-is, not coerced to null)
    expect(clientIp(ctx({ 'x-forwarded-for': ',1.2.3.4' }))).toBe('')
  })
})
