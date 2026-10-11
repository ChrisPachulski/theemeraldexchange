import { describe, expect, it, vi } from 'vitest'
import { creditIntent } from './PersonDialog'

const credit = (media_type: 'movie' | 'tv', id: number, name: string) => ({ id, media_type, name, title: null })

describe('creditIntent', () => {
  it('opens a movie by its TMDB id without a lookup', async () => {
    const lookup = vi.fn()
    await expect(creditIntent(credit('movie', 603, 'The Matrix'), lookup)).resolves.toEqual(['movies', 'tmdb:603'])
    expect(lookup).not.toHaveBeenCalled()
  })

  it('resolves a show through Sonarr by TMDB id', async () => {
    const lookup = vi.fn().mockResolvedValue([{ tvdbId: 81189 }])
    await expect(creditIntent(credit('tv', 1396, 'Breaking Bad'), lookup)).resolves.toEqual(['tv', 'tvdb:81189'])
    expect(lookup.mock.calls).toEqual([['tmdb:1396']])
  })

  it('falls back to the title when the TMDB lookup finds nothing', async () => {
    const lookup = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ tvdbId: 5 }])
    await expect(creditIntent(credit('tv', 1, 'Old Show'), lookup)).resolves.toEqual(['tv', 'tvdb:5'])
    expect(lookup.mock.calls).toEqual([['tmdb:1'], ['Old Show']])
  })

  it('is null when neither lookup matches', async () => {
    const lookup = vi.fn().mockResolvedValue([])
    await expect(creditIntent(credit('tv', 1, 'Gone'), lookup)).resolves.toBeNull()
  })
})
