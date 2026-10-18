import { describe, expect, it } from 'vitest'
import type { WatchEntry } from '../../lib/api/media'
import type { EpgNowRow } from '../../lib/api/iptv'
import {
  airingNow,
  certsByTitle,
  continueWatching,
  episodeLabel,
  resumeTitle,
  timeLeft,
  titleAllowed,
  titleKey,
  watchlistIntent,
} from './shelves'

const row = (over: Partial<WatchEntry>): WatchEntry => ({
  mediaKind: 'movie',
  mediaId: 1,
  positionSecs: 60,
  durationSecs: 600,
  watchedAt: '2026-10-01T00:00:00Z',
  completed: false,
  title: null,
  showTitle: null,
  posterPath: null,
  posterBlurhash: null,
  season: null,
  episode: null,
  ...over,
})

describe('continueWatching', () => {
  it('skips YouTube and music rows that share the watch map', () => {
    const rows = [row({ mediaId: 1 }), row({ mediaId: 2, mediaKind: 'video' }), row({ mediaId: 3, mediaKind: 'track' })]
    expect(continueWatching(rows).map((r) => r.mediaId)).toEqual([1])
  })

  it('keeps in-progress rows only, newest first, capped', () => {
    const rows = [
      row({ mediaId: 1, watchedAt: '2026-10-01T00:00:00Z' }),
      row({ mediaId: 2, watchedAt: '2026-10-03T00:00:00Z' }),
      row({ mediaId: 3, completed: true }),
      row({ mediaId: 4, positionSecs: 0 }),
      row({ mediaId: 5, watchedAt: '2026-10-02T00:00:00Z' }),
    ]
    expect(continueWatching(rows).map((r) => r.mediaId)).toEqual([2, 5, 1])
    expect(continueWatching(rows, 2).map((r) => r.mediaId)).toEqual([2, 5])
  })
})

describe('resume card labels', () => {
  it('titles an episode by its show and labels S · E', () => {
    const ep = row({ mediaKind: 'episode', title: 'Pilot', showTitle: 'Severance', season: 1, episode: 2 })
    expect(resumeTitle(ep)).toBe('Severance')
    expect(episodeLabel(ep)).toBe('S1 · E2')
  })

  it('titles a movie by itself, with no episode label', () => {
    const mv = row({ title: 'Heat' })
    expect(resumeTitle(mv)).toBe('Heat')
    expect(episodeLabel(mv)).toBeNull()
    expect(resumeTitle(row({}))).toBe('Movie')
  })
})

describe('titleKey', () => {
  it('matches library titles across case, accents, punctuation, & and a trailing year', () => {
    expect(titleKey('Law & Order: SVU')).toBe(titleKey('law and order svu'))
    expect(titleKey('Amélie (2001)')).toBe('amelie')
    expect(titleKey('1917')).toBe('1917')
  })
})

describe('airingNow', () => {
  const at = (iso: string) => Date.parse(iso)
  const prog = (start: string, stop: string, title: string) => ({
    channel_id: 'x', start_utc: start, stop_utc: stop, title, description: null,
  })
  const rows: EpgNowRow[] = [
    { channel_stream_id: 1, name: 'BBC One', stream_icon: 'https://logos.example/bbc.png', current: prog('2026-10-10T20:00:00Z', '2026-10-10T21:00:00Z', 'News'), next: prog('2026-10-10T21:00:00Z', '2026-10-10T22:00:00Z', 'Movie') },
    { channel_stream_id: 2, current: null, next: null },
  ]

  it('picks the programme on air and rolls to next when current has ended', () => {
    expect(airingNow(rows, at('2026-10-10T20:30:00Z')).map((a) => a.programme.title)).toEqual(['News'])
    expect(airingNow(rows, at('2026-10-10T21:10:00Z')).map((a) => a.programme.title)).toEqual(['Movie'])
    expect(airingNow(rows, at('2026-10-10T23:00:00Z'))).toEqual([])
  })

  it('carries the channel name and logo, null when the backend omits them', () => {
    const [a] = airingNow(rows, at('2026-10-10T20:30:00Z'))
    expect([a.channelName, a.channelIcon]).toEqual(['BBC One', 'https://logos.example/bbc.png'])
    const bare: EpgNowRow[] = [{ channel_stream_id: 3, current: rows[0].current, next: null }]
    const [b] = airingNow(bare, at('2026-10-10T20:30:00Z'))
    expect([b.channelName, b.channelIcon]).toEqual([null, null])
  })

  it('formats time left', () => {
    expect(timeLeft(at('2026-10-10T21:00:00Z'), at('2026-10-10T20:48:00Z'))).toBe('12m')
    expect(timeLeft(at('2026-10-10T22:05:00Z'), at('2026-10-10T21:00:00Z'))).toBe('1h 5m')
    expect(timeLeft(at('2026-10-10T21:00:00Z'), at('2026-10-10T20:59:50Z'))).toBe('1m')
  })
})

describe('watchlist rows', () => {
  it('open movies by TMDB id and shows by TVDB id', () => {
    expect(watchlistIntent({ kind: 'movie', id: 603 })).toEqual(['movies', 'tmdb:603'])
    expect(watchlistIntent({ kind: 'tv', id: 81189 })).toEqual(['tv', 'tvdb:81189'])
  })
})

describe('titleAllowed', () => {
  const gCap = (c: string | null | undefined) => c === 'G'

  it('a same-title remake cannot vouch for another: every rating must pass', () => {
    const certs = certsByTitle([
      { title: 'The Jungle Book', certification: 'PG' },
      { title: 'The Jungle Book', certification: 'G' },
    ])
    expect(titleAllowed(certs, 'The Jungle Book', gCap)).toBe(false)
  })

  it('passes a lone allowed title and fails closed on no match', () => {
    const certs = certsByTitle([{ title: 'Bambi', certification: 'G' }])
    expect(titleAllowed(certs, 'bambi', gCap)).toBe(true)
    expect(titleAllowed(certs, 'Unknown', gCap)).toBe(false)
  })
})
