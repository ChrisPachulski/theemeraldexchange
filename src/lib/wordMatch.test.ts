import { describe, expect, it } from 'vitest'
import { matchesWords, rankWords, words } from './wordMatch'

describe('matchesWords', () => {
  it('ignores punctuation and spacing', () => {
    expect(matchesWords('Scooby-Doo, Where Are You!', 'scooby doo')).toBe(true)
    expect(matchesWords('Scooby-Doo!', 'scoobydoo')).toBe(true)
    expect(matchesWords('Spider-Man: Homecoming', 'spiderman')).toBe(true)
    expect(matchesWords("What's New, Scooby-Doo?", 'whats new')).toBe(true)
    expect(matchesWords('The Matrix', 'matr')).toBe(true)
    expect(matchesWords('24/7 SCOOBY DOO', 'scooby-doo')).toBe(true)
    expect(matchesWords('Law & Order', 'law and order')).toBe(true)
    expect(matchesWords('Law and Order', 'law & order')).toBe(true)
  })
  it('matches a short query at word starts only', () => {
    expect(matchesWords('US: CNN', 'us')).toBe(true)
    expect(matchesWords('Music Channel', 'us')).toBe(false)
    expect(matchesWords('X-Men', 'xmen')).toBe(true)
  })
  it('folds diacritics', () => {
    expect(matchesWords('Pokémon', 'pokemon')).toBe(true)
    expect(matchesWords('Pokemon', 'pokémon')).toBe(true)
  })
  it('ranks the exact title first, then titles that start with the query', () => {
    expect(rankWords('Scooby-Doo!', 'scooby-doo')).toBe(0)
    expect(rankWords('Scooby-Doo and the Alien Invaders', 'scooby-doo')).toBe(1)
    expect(rankWords('A Pup Named Scooby-Doo', 'scooby-doo')).toBe(2)
    expect(rankWords('Batman', 'scooby-doo')).toBeNull()
  })
  it('still refuses a title without the words', () => {
    expect(matchesWords('Scooby-Doo!', 'batman')).toBe(false)
    expect(words('What’s New')).toEqual(['whats', 'new'])
  })
})
