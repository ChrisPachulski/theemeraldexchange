import { describe, it, expect } from 'vitest'
import type { MediaEpisode, WatchEntry } from './api/media'
import { resumeLabel, seriesPlayback, watchBadge } from './watchState'

const row = (over: Partial<WatchEntry>): WatchEntry => ({
  mediaKind: 'episode',
  mediaId: 0,
  positionSecs: 0,
  durationSecs: null,
  watchedAt: '2026-01-01T00:00:00Z',
  completed: false,
  title: null,
  showTitle: null,
  posterPath: null,
  posterBlurhash: null,
  season: null,
  episode: null,
  ...over,
})

const ep = (id: number, season: number, episode: number): MediaEpisode => ({
  id, showId: 1, season, episode, title: null, airDate: null, fileId: id,
})

describe('watchBadge', () => {
  it('marks completed as watched and in-progress as a bar', () => {
    expect(watchBadge(row({ completed: true, positionSecs: 100, durationSecs: 100 }))).toEqual({ watched: true, progress: null })
    expect(watchBadge(row({ positionSecs: 25, durationSecs: 100 }))).toEqual({ watched: false, progress: 0.25 })
    expect(watchBadge(row({ positionSecs: 25 }))).toEqual({ watched: false, progress: null })
    expect(watchBadge(undefined)).toEqual({ watched: false, progress: null })
  })
})

describe('resumeLabel', () => {
  it('captions time left when the duration is known, else the position', () => {
    expect(resumeLabel(row({ positionSecs: 600, durationSecs: 3200 }))).toBe('Resume · 43 min left')
    expect(resumeLabel(row({ positionSecs: 754 }))).toBe('Resume 12:34')
    expect(resumeLabel(row({ positionSecs: 3190, durationSecs: 3200 }))).toBe('Resume 53:10')
  })

  it('is undefined with nothing to resume', () => {
    expect(resumeLabel(undefined)).toBeUndefined()
    expect(resumeLabel(row({ completed: true, positionSecs: 600 }))).toBeUndefined()
    expect(resumeLabel(row({ positionSecs: 0, durationSecs: 100 }))).toBeUndefined()
  })
})

describe('seriesPlayback', () => {
  const eps = [ep(4, 2, 1), ep(1, 1, 1), ep(3, 1, 3), ep(2, 1, 2), ep(9, 0, 1)]

  it('plays the first regular episode when nothing is in progress', () => {
    expect(seriesPlayback(eps, new Map())).toEqual({ target: eps[1], isResume: false, defaultSeason: 1 })
    expect(seriesPlayback([], undefined)).toEqual({ target: null, isResume: false, defaultSeason: null })
  })

  it('resumes the latest unfinished episode in (season, episode) order', () => {
    const watch = new Map([
      ['episode:2', row({ positionSecs: 30, watchedAt: '2026-05-01' })],
      ['episode:3', row({ positionSecs: 30, watchedAt: '2026-04-01' })],
      ['episode:4', row({ completed: true, positionSecs: 99, watchedAt: '2026-06-01' })],
    ])
    expect(seriesPlayback(eps, watch)).toEqual({ target: eps[2], isResume: true, defaultSeason: 1 })
  })

  it('opens on the last-watched season when nothing is unfinished', () => {
    const watch = new Map([
      ['episode:1', row({ completed: true, watchedAt: '2026-01-01' })],
      ['episode:4', row({ completed: true, watchedAt: '2026-03-01' })],
    ])
    expect(seriesPlayback(eps, watch)).toEqual({ target: eps[1], isResume: false, defaultSeason: 2 })
  })
})
