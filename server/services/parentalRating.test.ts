import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ratingAllowed,
  ratingBlocked,
  capBlocksUnrated,
  _setCertificationResolverForTests,
} from './parentalRating.js'
import { setPolicy, _setUserPoliciesPathForTests } from './userPolicies.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'rating-'))
  _setUserPoliciesPathForTests(join(tmpRoot, 'user-policies.json'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  _setCertificationResolverForTests(null)
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const user = { sub: 'plex:9', role: 'user' }
const admin = { sub: 'plex:1', role: 'admin' }

const cap = (maxContentRating: string | null) =>
  setPolicy(user.sub, { maxContentRating, allowedSections: null, kid: maxContentRating !== null })

describe('ratingAllowed (pure)', () => {
  it('nil cap allows everything, including unrated', () => {
    expect(ratingAllowed('R', null)).toBe(true)
    expect(ratingAllowed(null, null)).toBe(true)
  })

  it('unrated / unknown certifications FAIL CLOSED under any cap', () => {
    expect(ratingAllowed(null, 'PG-13')).toBe(false)
    expect(ratingAllowed('', 'PG-13')).toBe(false)
    expect(ratingAllowed('Not Rated', 'PG-13')).toBe(false)
  })

  it('caps compare on the canonical severity scale, cross-ladder', () => {
    expect(ratingAllowed('PG-13', 'PG-13')).toBe(true)
    expect(ratingAllowed('R', 'PG-13')).toBe(false)
    expect(ratingAllowed('TV-14', 'PG-13')).toBe(true)   // same severity band
    expect(ratingAllowed('TV-MA', 'PG-13')).toBe(false)
    expect(ratingAllowed('G', 'TV-Y')).toBe(true)
    expect(ratingAllowed('NC-17', 'R')).toBe(false)
  })

  it('is case/whitespace-insensitive on the certification', () => {
    expect(ratingAllowed(' pg-13 ', 'R')).toBe(true)
  })
})

describe('ratingBlocked (grant gate)', () => {
  it('never blocks admins, regardless of cap or certification', async () => {
    await setPolicy(admin.sub, { maxContentRating: 'G', allowedSections: null, kid: false })
    _setCertificationResolverForTests(async () => 'NC-17')
    expect(await ratingBlocked(admin, 'movie', 7)).toBe(false)
  })

  it('passes an uncapped user without touching the resolver', async () => {
    const resolver = vi.fn(async () => 'R')
    _setCertificationResolverForTests(resolver)
    expect(await ratingBlocked(user, 'movie', 7)).toBe(false)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('blocks above the cap, allows at/below it', async () => {
    await cap('PG-13')
    _setCertificationResolverForTests(async () => 'R')
    expect(await ratingBlocked(user, 'movie', 7)).toBe(true)
    _setCertificationResolverForTests(async () => 'PG')
    expect(await ratingBlocked(user, 'movie', 7)).toBe(false)
  })

  it('blocks an unresolvable certification (fail closed)', async () => {
    await cap('R')
    _setCertificationResolverForTests(async () => null)
    expect(await ratingBlocked(user, 'episode', 3)).toBe(true)
  })

  it('blocks when resolution throws (fail closed)', async () => {
    await cap('R')
    _setCertificationResolverForTests(async () => {
      throw new Error('arr down')
    })
    expect(await ratingBlocked(user, 'movie', 7)).toBe(true)
  })

  it('exempts music tracks — audio has no certification system', async () => {
    await cap('G')
    _setCertificationResolverForTests(async () => {
      throw new Error('must not be called')
    })
    expect(await ratingBlocked(user, 'track', 5)).toBe(false)
  })
})

describe('capBlocksUnrated (IPTV VOD gate)', () => {
  it('false without a cap, true with one, never for admins', async () => {
    expect(await capBlocksUnrated(user)).toBe(false)
    await cap('TV-14')
    expect(await capBlocksUnrated(user)).toBe(true)
    await setPolicy(admin.sub, { maxContentRating: 'G', allowedSections: null, kid: false })
    expect(await capBlocksUnrated(admin)).toBe(false)
  })
})
