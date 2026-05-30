import { describe, it, expect } from 'vitest'
import { ulid, newLocalSub } from './ulid.js'
import { parseSub } from './sub.js'

// The contract (§8.1) requires a `local:` id to be a 26-char uppercase
// Crockford Base32 ULID matching this exact class.
const CONTRACT_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('ulid', () => {
  it('is 26 chars and matches the contract Crockford Base32 class', () => {
    for (let i = 0; i < 200; i++) {
      const u = ulid()
      expect(u).toHaveLength(26)
      expect(u).toMatch(CONTRACT_ULID)
    }
  })

  it('never emits an excluded letter (I, L, O, U)', () => {
    const joined = Array.from({ length: 200 }, () => ulid()).join('')
    expect(joined).not.toMatch(/[ILOU]/)
  })

  it('is effectively unique across many draws', () => {
    const set = new Set(Array.from({ length: 5000 }, () => ulid()))
    expect(set.size).toBe(5000)
  })

  it('is lexicographically time-ordered by the timestamp prefix', () => {
    const early = ulid(1_000_000_000_000)
    const late = ulid(2_000_000_000_000)
    // Compare the 10-char time prefix only (random suffix can go either way).
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true)
  })

  it('newLocalSub produces a parseSub-valid local: sub', () => {
    for (let i = 0; i < 50; i++) {
      const sub = newLocalSub()
      expect(sub.startsWith('local:')).toBe(true)
      const parsed = parseSub(sub)
      expect(parsed.provider).toBe('local')
      expect(parsed.id).toMatch(CONTRACT_ULID)
    }
  })
})
