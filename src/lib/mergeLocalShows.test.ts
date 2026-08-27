import { describe, it, expect } from 'vitest'
import { mergeLocalShows } from './mergeLocalShows'
import type { Series } from './api/sonarr'
import type { MediaShow } from './api/media'

const sonarr = [{ id: 1, tvdbId: 100, tmdbId: 200, title: 'Tracked', year: 2020 }] as unknown as Series[]
const local = (over: Partial<MediaShow>): MediaShow => ({
  id: 9, tmdbId: null, tvdbId: null, title: 'Local', year: 2026, addedAt: '', imdbId: 'tt1', overview: null, posterPath: '/p.jpg', ...over,
})

describe('mergeLocalShows', () => {
  it('appends shows the scanner has but Sonarr does not, as search-shaped rows', () => {
    const rows = mergeLocalShows(sonarr, [local({ tmdbId: 313298, title: 'The Dinosaurs' })])
    expect(rows.map((r) => r.title)).toEqual(['Tracked', 'The Dinosaurs'])
    const dino = rows[1]!
    expect('id' in dino).toBe(false)
    expect(dino.remotePoster).toBe('https://image.tmdb.org/t/p/w342/p.jpg')
    expect(dino.imdbId).toBe('tt1')
  })
  it('skips local shows Sonarr already tracks by tvdb or tmdb id', () => {
    expect(mergeLocalShows(sonarr, [local({ tvdbId: 100 }), local({ tmdbId: 200 })])).toHaveLength(1)
  })
  it('returns Sonarr alone while local shows are still loading', () => {
    expect(mergeLocalShows(sonarr, undefined)).toHaveLength(1)
  })
})
