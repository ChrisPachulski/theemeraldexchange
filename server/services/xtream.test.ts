import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
import { __setSsrfLookupForTests } from './ssrfGuard.js'

// Derived from the mocked env rather than hand-written, so the expected URLs
// stay in lockstep with what the production builders emit.
const CREDS = credsFromEnv()
const ACCOUNT_URL =
  `${CREDS.host}/player_api.php?` +
  new URLSearchParams([
    ['username', CREDS.username],
    ['password', CREDS.password],
  ]).toString()
const catalogUrl = (action: string): string => buildPlayerApiUrl(CREDS, action)

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Stub global fetch so every request answers with `payload` as a JSON 200. */
function stubFetchJson(payload: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => jsonResponse(payload))
  vi.stubGlobal('fetch', fn)
  return fn
}

/**
 * Stub fetch as a panel that 302s to `target`, modelling REAL platform fetch
 * redirect semantics: with the WHATWG default `redirect: 'follow'` the runtime
 * follows the 30x itself and hands back the TARGET's response, so the caller
 * never sees the hop. Only `redirect: 'manual'` — which the SSRF egress loop
 * sets — surfaces the 302 for re-validation.
 *
 * So the un-guarded plain-fetch code path receives `payload` (the internal
 * target's body) as a clean 200 and parses it as a catalog/account payload; the
 * guarded path gets the 302 and must refuse before dialing the second hop. Any
 * request to a url OTHER than `origin` also answers with the payload, so a
 * guard that fails open surfaces as parsed rows rather than an error.
 */
function stubFetchRedirect(origin: string, target: string, payload: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== origin || init?.redirect !== 'manual') return jsonResponse(payload)
    return new Response(null, { status: 302, headers: { location: target } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

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
  afterEach(() => vi.unstubAllGlobals())

  it('getAccountInfo parses user_info and tolerates string active_connections', async () => {
    const fetchFn = stubFetchJson({
      user_info: {
        exp_date: '1893456000',
        max_connections: 3,
        active_connections: '2',
        status: 'Active',
      },
    })
    const a = await getAccountInfo()
    expect(a.maxConnections).toBe(3)
    expect(a.activeConnections).toBe(2)
    expect(a.status).toBe('Active')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0])).toBe(ACCOUNT_URL)
  })

  it('getAccountInfo throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    await expect(getAccountInfo()).rejects.toThrow('xtream_account_401')
  })

  it('getJson throws `${label}_${status}` on a non-ok catalog response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(fetchCategories('live')).rejects.toThrow('xtream.get_live_categories_503')
  })

  it('fetchCategories(live) parses payload and hits get_live_categories', async () => {
    const fetchFn = stubFetchJson([{ category_id: '1', category_name: 'News', parent_id: 0 }])
    const cats = await fetchCategories('live')
    expect(cats).toEqual([{ category_id: 1, name: 'News', parent_id: 0 }])
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_live_categories')
  })

  it('fetchCategories(vod) hits get_vod_categories', async () => {
    const fetchFn = stubFetchJson([])
    await fetchCategories('vod')
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_vod_categories')
  })

  it('fetchCategories(series) hits get_series_categories', async () => {
    const fetchFn = stubFetchJson([])
    await fetchCategories('series')
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_series_categories')
  })

  it('fetchLiveStreams parses + normalizes epg_channel_id', async () => {
    const fetchFn = stubFetchJson([{ stream_id: 5, name: 'C', epg_channel_id: 'X.us' }])
    const ch = await fetchLiveStreams('2026-05-24T00:00:00Z')
    expect(ch[0].stream_id).toBe(5)
    expect(ch[0].epg_channel_id).toBe('x.us')
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_live_streams')
  })

  it('fetchVodStreams parses payload and hits get_vod_streams', async () => {
    const fetchFn = stubFetchJson([{ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb: '603' }])
    const v = await fetchVodStreams('2026-05-24T00:00:00Z')
    expect(v[0]).toMatchObject({ stream_id: 9, name: 'Movie', container_extension: 'mp4', tmdb_id: 603 })
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_vod_streams')
  })

  it('fetchSeriesList parses payload and hits get_series', async () => {
    const fetchFn = stubFetchJson([{ series_id: 11, name: 'Show', tmdb: 1399, category_id: 4 }])
    const s = await fetchSeriesList('2026-05-24T00:00:00Z')
    expect(s[0]).toMatchObject({ series_id: 11, name: 'Show', tmdb_id: 1399, category_id: 4 })
    expect(String(fetchFn.mock.calls[0][0])).toContain('action=get_series')
  })

  it('fetchShortEpg parses base64 titles + unix timestamps keyed by stream_id', async () => {
    const fetchFn = stubFetchJson({
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
    const url = String(fetchFn.mock.calls[0][0])
    expect(url).toContain('action=get_short_epg')
    expect(url).toContain('stream_id=')
  })

  it('fetchSeriesInfo flattens episodes across seasons with info fallbacks', async () => {
    stubFetchJson({
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
    stubFetchJson({ episodes: { '1': 'not-an-array' } })
    await expect(fetchSeriesInfo(7)).resolves.toEqual([])
  })

  it('fetchSeriesInfo tolerates missing episodes key', async () => {
    stubFetchJson({})
    await expect(fetchSeriesInfo(7)).resolves.toEqual([])
  })
})

describe('xtream catalog sync — SSRF redirect guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    __setSsrfLookupForTests(null)
  })

  // The panel host is operator-configured (trusted initial hop), but the 30x it
  // answers with is provider-controlled: a compromised/hostile panel can bounce
  // catalog sync at the link-local cloud-metadata address (or any compose-
  // internal service) and have the server fetch + PARSE whatever comes back
  // into channels/VOD/series rows. Plain fetch() follows that redirect silently.
  it('fetchLiveStreams refuses a 302 into cloud metadata and never dials it', async () => {
    const liveUrl = catalogUrl('get_live_streams')
    const internalPayload = [{ stream_id: 666, name: 'LEAKED', epg_channel_id: 'leak.us' }]
    const fetchFn = stubFetchRedirect(
      liveUrl,
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      internalPayload,
    )

    await expect(fetchLiveStreams('2026-05-24T00:00:00Z')).rejects.toThrow(
      /blocked non-public upstream.*169\.254\.169\.254/,
    )
    // The decisive assertion: exactly ONE request left the box — the trusted
    // panel. The redirect target was never dialed, so nothing from the internal
    // payload could be parsed into the catalog.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(liveUrl)
  })

  it('fetchSeriesList refuses a 302 into a loopback/internal service host', async () => {
    const seriesUrl = catalogUrl('get_series')
    const fetchFn = stubFetchRedirect(seriesUrl, 'http://localhost:8000/admin', [
      { series_id: 1, name: 'LEAKED' },
    ])

    await expect(fetchSeriesList('2026-05-24T00:00:00Z')).rejects.toThrow(
      /blocked non-public upstream/,
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('getAccountInfo refuses a 302 into an RFC-1918 host and never parses its payload', async () => {
    const fetchFn = stubFetchRedirect(ACCOUNT_URL, 'http://10.0.0.7/internal', {
      user_info: { max_connections: 99, active_cons: 42, status: 'LEAKED' },
    })

    await expect(getAccountInfo()).rejects.toThrow(/blocked non-public upstream/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe(ACCOUNT_URL)
  })

  it('still follows a public->public redirect (the guard is not a blanket block)', async () => {
    // Resellers legitimately 30x the panel to a CDN/mirror host; that must keep
    // working. 8.8.8.8 is public, so resolve-and-validate passes deterministically
    // without touching real DNS.
    const liveUrl = catalogUrl('get_live_streams')
    __setSsrfLookupForTests(async () => [{ address: '8.8.8.8' }])
    const fetchFn = stubFetchRedirect(liveUrl, 'https://mirror.example.com/player_api.php', [
      { stream_id: 5, name: 'C', epg_channel_id: 'X.us' },
    ])

    const ch = await fetchLiveStreams('2026-05-24T00:00:00Z')

    expect(ch[0]).toMatchObject({ stream_id: 5, epg_channel_id: 'x.us' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[1][0]).toBe('https://mirror.example.com/player_api.php')
  })
})
