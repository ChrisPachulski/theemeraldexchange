import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./upstream.js', () => ({
  fetchJsonWithTimeout: vi.fn(),
  fetchWithTimeout: vi.fn(),
}))
vi.mock('../env.js', () => ({
  env: {
    XTREAM_HOST: 'https://panel.example/',
    XTREAM_USERNAME: 'u',
    XTREAM_PASSWORD: 'p',
    IPTV_LIST_TIMEOUT_MS: 30000,
  },
}))

import {
  buildPlayerApiUrl,
  parseAccountInfo,
  parseCategoriesPayload,
  parseLiveStreams,
  parseVodStreams,
  parseSeriesList,
  parseShortEpg,
  credsFromEnv,
  getAccountInfo,
  fetchCategories,
  fetchLiveStreams,
  fetchVodStreams,
  fetchSeriesList,
  fetchSeriesInfo,
  fetchShortEpg,
  type XtreamCreds,
} from './xtream.js'
import { fetchJsonWithTimeout, fetchWithTimeout } from './upstream.js'

const mockJson = vi.mocked(fetchJsonWithTimeout)
const mockFetch = vi.mocked(fetchWithTimeout)

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

describe('xtream credsFromEnv', () => {
  it('reads creds from env and strips trailing slashes from host', () => {
    const c = credsFromEnv()
    expect(c.host).toBe('https://panel.example')
    expect(c.username).toBe('u')
    expect(c.password).toBe('p')
  })
})

describe('xtream network fetchers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getAccountInfo parses user_info and tolerates string active_connections', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        user_info: {
          exp_date: '1893456000',
          max_connections: 3,
          active_connections: '2',
          status: 'Active',
        },
      }),
    } as unknown as Response)
    const a = await getAccountInfo()
    expect(a.maxConnections).toBe(3)
    expect(a.activeConnections).toBe(2)
    expect(a.status).toBe('Active')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(String(mockFetch.mock.calls[0][0])).toContain('player_api.php?username=u&password=p')
  })

  it('getAccountInfo throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 } as unknown as Response)
    await expect(getAccountInfo()).rejects.toThrow('xtream_account_401')
  })

  it('fetchCategories(live) parses payload and hits get_live_categories', async () => {
    mockJson.mockResolvedValue([{ category_id: '1', category_name: 'News', parent_id: 0 }])
    const cats = await fetchCategories('live')
    expect(cats).toEqual([{ category_id: 1, name: 'News', parent_id: 0 }])
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_live_categories')
  })

  it('fetchCategories(vod) hits get_vod_categories', async () => {
    mockJson.mockResolvedValue([])
    await fetchCategories('vod')
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_vod_categories')
  })

  it('fetchCategories(series) hits get_series_categories', async () => {
    mockJson.mockResolvedValue([])
    await fetchCategories('series')
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_series_categories')
  })

  it('fetchLiveStreams parses + normalizes epg_channel_id', async () => {
    mockJson.mockResolvedValue([{ stream_id: 5, name: 'C', epg_channel_id: 'X.us' }])
    const ch = await fetchLiveStreams('2026-05-24T00:00:00Z')
    expect(ch[0].stream_id).toBe(5)
    expect(ch[0].epg_channel_id).toBe('x.us')
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_live_streams')
  })

  it('fetchVodStreams parses payload and hits get_vod_streams', async () => {
    mockJson.mockResolvedValue([{ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb: '603' }])
    const v = await fetchVodStreams('2026-05-24T00:00:00Z')
    expect(v[0]).toMatchObject({ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb_id: 603 })
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_vod_streams')
  })

  it('fetchSeriesList parses payload and hits get_series', async () => {
    mockJson.mockResolvedValue([{ series_id: 11, name: 'Show', tmdb: 1399, category_id: 4 }])
    const s = await fetchSeriesList('2026-05-24T00:00:00Z')
    expect(s[0]).toMatchObject({ series_id: 11, name: 'Show', tmdb_id: 1399, category_id: 4 })
    expect(String(mockJson.mock.calls[0][0])).toContain('action=get_series')
  })

  it('fetchShortEpg parses base64 titles + unix timestamps keyed by stream_id', async () => {
    mockJson.mockResolvedValue({
      epg_listings: [
        {
          title: Buffer.from('T').toString('base64'),
          start_timestamp: 1780149600,
          stop_timestamp: 1780153200,
        },
      ],
    })
    const rows = await fetchShortEpg(200163456)
    expect(rows).toHaveLength(1)
    expect(rows[0].channel_id).toBe('200163456')
    expect(rows[0].title).toBe('T')
    const url = String(mockJson.mock.calls[0][0])
    expect(url).toContain('action=get_short_epg')
    expect(url).toContain('stream_id=')
  })

  it('fetchSeriesInfo flattens episodes across seasons with info fallbacks', async () => {
    mockJson.mockResolvedValue({
      episodes: {
        '1': [
          {
            id: 'e1',
            episode_num: '1',
            title: 'Pilot',
            container_extension: 'mp4',
            added: '1716000000',
            info: { plot: 'desc', duration_secs: '1320' },
          },
        ],
        '2': [{ id: 'e2', episode_num: 2, info: { description: 'fallback-desc' } }],
      },
    })
    const eps = await fetchSeriesInfo(11)
    expect(eps).toHaveLength(2)
    expect(eps[0]).toMatchObject({
      episode_id: 'e1',
      series_id: 11,
      season: 1,
      episode_num: 1,
      title: 'Pilot',
      plot: 'desc',
      duration_secs: 1320,
    })
    expect(typeof eps[0].added_ts).toBe('string')
    expect(eps[0].added_ts).not.toBeNull()
    expect(eps[1]).toMatchObject({
      season: 2,
      episode_num: 2,
      plot: 'fallback-desc',
      duration_secs: null,
    })
  })

  it('fetchSeriesInfo skips non-array season values', async () => {
    mockJson.mockResolvedValue({ episodes: { '1': 'not-an-array' } })
    await expect(fetchSeriesInfo(7)).resolves.toEqual([])
  })

  it('fetchSeriesInfo tolerates missing episodes key', async () => {
    mockJson.mockResolvedValue({})
    await expect(fetchSeriesInfo(7)).resolves.toEqual([])
  })
})
