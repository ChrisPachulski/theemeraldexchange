import { describe, expect, it } from 'vitest'
import { matchesWords, words } from './wordMatch'

describe('matchesWords', () => {
  it('ignores punctuation and spacing', () => {
    expect(matchesWords('Scooby-Doo, Where Are You!', 'scooby doo')).toBe(true)
    expect(matchesWords('Scooby-Doo!', 'scoobydoo')).toBe(true)
    expect(matchesWords('Spider-Man: Homecoming', 'spiderman')).toBe(true)
    expect(matchesWords("What's New, Scooby-Doo?", 'whats new')).toBe(true)
    expect(matchesWords('The Matrix', 'matr')).toBe(true)
  })
  it('still refuses a title without the words', () => {
    expect(matchesWords('Scooby-Doo!', 'batman')).toBe(false)
    expect(words('What’s New')).toEqual(['whats', 'new'])
  })
})
