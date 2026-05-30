import { describe, it, expect } from 'vitest'
import {
  buildPlayerApiUrl,
  parseAccountInfo,
  parseCategoriesPayload,
  parseLiveStreams,
  parseVodStreams,
  parseSeriesList,
  parseShortEpg,
  type XtreamCreds,
} from './xtream.js'

describe('xtream client primitives', () => {
  const creds: XtreamCreds = {
    host: 'https://panel.example',
    username: 'u',
    password: 'p',
  }

  it('builds a player_api URL with action+params', () => {
    expect(buildPlayerApiUrl(creds, 'get_live_categories')).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_live_categories',
    )
    expect(buildPlayerApiUrl(creds, 'get_vod_streams', { category_id: 12 })).toBe(
      'https://panel.example/player_api.php?username=u&password=p&action=get_vod_streams&category_id=12',
    )
  })

  it('parses account info, tolerating string vs number max_connections', () => {
    const a = parseAccountInfo({ user_info: { exp_date: '1893456000', max_connections: '4', status: 'Active' } })
    expect(a.expiresAt instanceof Date).toBe(true)
    expect(a.maxConnections).toBe(4)
    expect(a.status).toBe('Active')

    const b = parseAccountInfo({ user_info: { exp_date: 1893456000, max_connections: 2 } })
    expect(b.maxConnections).toBe(2)
  })
})

describe('xtream list parsers', () => {
  it('parses categories', () => {
    const list = parseCategoriesPayload([
      { category_id: '1', category_name: 'News', parent_id: 0 },
      { category_id: 2, category_name: 'Sports', parent_id: '0' },
    ])
    expect(list).toEqual([
      { category_id: 1, name: 'News', parent_id: 0 },
      { category_id: 2, name: 'Sports', parent_id: 0 },
    ])
  })

  it('parses live streams with archive flags', () => {
    const channels = parseLiveStreams(
      [
        {
          stream_id: 100, num: 1, name: 'C1', stream_icon: 'http://x/y.png',
          epg_channel_id: 'epg.c1', category_id: '1', is_adult: '0',
          tv_archive: '1', tv_archive_duration: '7', added: '1716000000',
        },
      ],
      '2026-05-24T00:00:00Z',
    )
    expect(channels[0]).toMatchObject({
      stream_id: 100, num: 1, name: 'C1', epg_channel_id: 'epg.c1', category_id: 1,
      is_adult: 0, tv_archive: 1, tv_archive_duration: 7,
    })
    expect(channels[0].fetched_at).toBe('2026-05-24T00:00:00Z')
  })

  it('lowercases + trims epg_channel_id so it joins the (lowercase) XMLTV feed', () => {
    const channels = parseLiveStreams(
      [
        { stream_id: 1, name: 'CNBC', epg_channel_id: '  CNBC.us  ' },
        { stream_id: 2, name: 'No tvg', epg_channel_id: '' },
        { stream_id: 3, name: 'Missing tvg' },
      ],
      '2026-05-24T00:00:00Z',
    )
    expect(channels[0].epg_channel_id).toBe('cnbc.us')
    expect(channels[1].epg_channel_id).toBeNull()
    expect(channels[2].epg_channel_id).toBeNull()
  })

  it('parses get_short_epg (base64 titles, unix timestamps, stream_id key)', () => {
    const rows = parseShortEpg(
      {
        epg_listings: [
          {
            title: Buffer.from('SportsCenter').toString('base64'),
            description: Buffer.from('Highlights').toString('base64'),
            start_timestamp: 1780149600,
            stop_timestamp: 1780153200,
            channel_id: '200163456',
          },
          { title: 'x', start_timestamp: 5, stop_timestamp: 5 }, // zero-length → dropped
        ],
      },
      200163456,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      channel_id: '200163456',
      title: 'SportsCenter',
      description: 'Highlights',
      start_utc: new Date(1780149600 * 1000).toISOString(),
      stop_utc: new Date(1780153200 * 1000).toISOString(),
    })
  })

  it('parseShortEpg tolerates empty/missing listings', () => {
    expect(parseShortEpg({ epg_listings: [] }, 1)).toEqual([])
    expect(parseShortEpg(null, 1)).toEqual([])
    expect(parseShortEpg({}, 1)).toEqual([])
  })

  it('parses VOD streams with tmdb_id when present', () => {
    const v = parseVodStreams(
      [{ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb: '603', rating: '7.8' }],
      '2026-05-24T00:00:00Z',
    )
    expect(v[0]).toMatchObject({ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb_id: 603, rating: 7.8 })
  })

  it('parses series list', () => {
    const s = parseSeriesList(
      [{ series_id: 11, name: 'Show', cover: 'c.jpg', plot: 'p', rating: 8.1, category_id: 4, tmdb: 1399 }],
      '2026-05-24T00:00:00Z',
    )
    expect(s[0]).toMatchObject({ series_id: 11, name: 'Show', tmdb_id: 1399, category_id: 4 })
  })
})
