import { describe, it, expect } from 'vitest'
import { effectiveCap, ratingAllowed } from './parentalGate'

describe('ratingAllowed', () => {
  it('allows everything with no cap, including unrated', () => {
    expect(ratingAllowed('NC-17', null)).toBe(true)
    expect(ratingAllowed(undefined, null)).toBe(true)
  })

  it('compares movie and TV ladders on one scale', () => {
    expect(ratingAllowed('TV-14', 'PG-13')).toBe(true)
    expect(ratingAllowed('PG-13', 'PG-13')).toBe(true)
    expect(ratingAllowed('R', 'PG-13')).toBe(false)
    expect(ratingAllowed('TV-MA', 'PG-13')).toBe(false)
    expect(ratingAllowed('TV-Y7', 'PG')).toBe(true)
    expect(ratingAllowed('TV-PG', 'G')).toBe(false)
  })

  it('fails closed on unrated or unknown certifications under a cap', () => {
    expect(ratingAllowed(undefined, 'R')).toBe(false)
    expect(ratingAllowed('', 'R')).toBe(false)
    expect(ratingAllowed('NR', 'R')).toBe(false)
    expect(ratingAllowed('Not Rated', 'R')).toBe(false)
  })

  it('is case- and whitespace-insensitive', () => {
    expect(ratingAllowed(' tv-14 ', 'pg-13')).toBe(true)
  })

  it('cannot enforce a cap outside the ladder, so it allows', () => {
    expect(ratingAllowed('NC-17', 'X')).toBe(true)
  })
})

describe('effectiveCap', () => {
  it('is uncapped for an ordinary profile', () => {
    expect(effectiveCap({ maxContentRating: null, kid: false })).toBeNull()
  })

  it('defaults a kid profile with no cap to PG', () => {
    expect(effectiveCap({ maxContentRating: null, kid: true })).toBe('PG')
    expect(effectiveCap({ maxContentRating: '  ', kid: true })).toBe('PG')
  })

  it('lets an explicit cap win over the kid default, looser or stricter', () => {
    expect(effectiveCap({ maxContentRating: 'PG-13', kid: true })).toBe('PG-13')
    expect(effectiveCap({ maxContentRating: 'G', kid: true })).toBe('G')
    expect(effectiveCap({ maxContentRating: 'R', kid: false })).toBe('R')
  })
})
