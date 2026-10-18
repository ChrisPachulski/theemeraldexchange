// Writes tmdb-goldens.json from the untouched TS app (server/app.ts): the
// /api/tmdb and /api/ratings routes, scenario by scenario, against one local
// fake that stands in for TMDB (/tmdb/3), OMDb (/omdb/), Wikidata
// (/wikidata/sparql), Rotten Tomatoes (/rt/) and googlevideo (/gv/), and
// recording every request it gets. eex-ytresolve, yt-dlp and ffmpeg are the
// /bin/sh stubs in ./stubs, reached through symlinks in a temp dir (PATH and
// EEX_YTRESOLVE_BIN); each scenario seeds their per-video answers. Per step it
// keeps the status, Content-Type, Content-Range, the body (binary bodies as
// length + byte sum), the fake's requests and the stubs' argv lines.
// src/tmdb/goldens.rs replays the same scenarios through gateway::router.
//
// Per-run values are normalized on both sides: the fake's origin becomes
// {GV}, the mux directory <mux>, a stream token <token>.
//
// No network: globalThis.fetch rewrites the four third-party bases to the
// fake on 127.0.0.1 and throws for every other host.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-tmdb-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

const ENV: Record<string, string> = {
  SESSION_SECRET: 'tmdb-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'tmdb-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'tmdb-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'tmdb-goldens-internal-principal-placeholder-zzz',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  TMDB_API_KEY: 'placeholder-tmdb-key',
  OMDB_API_KEY: 'placeholder-omdb-key',
}
const MEMBERS = {
  alice: { sub: 'apple:000001.0123456789abcdef0123456789abcdef.0001', username: 'alice', role: 'user' },
  admin: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'admin', role: 'admin' },
} as const
type Who = keyof typeof MEMBERS

// --- scenarios -------------------------------------------------------------------------

type Route = {
  method: string
  path: string
  query?: Record<string, string>
  status: number
  text: string
  ct: string
  delay_ms?: number
  /** googlevideo: serve byte i = (i + seed) & 0xff of a `bytes`-long stream per range= window. */
  bytes?: number
  seed?: number
}
const route = (p: string, status: number, body: unknown, opts: Partial<Route> = {}): Route => ({
  method: 'GET',
  path: p,
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  ct: typeof body === 'string' ? 'text/html' : 'application/json',
  ...opts,
})
const tmdb = (p: string, status: number, body: unknown, opts: Partial<Route> = {}) => route(`/tmdb/3${p}`, status, body, opts)
const gv = (p: string, bytes: number, seed: number, status = 200): Route => ({ method: 'GET', path: `/gv/${p}`, status, text: '', ct: 'video/mp4', bytes, seed })

type Step = {
  name: string
  as?: Who
  path?: string
  range?: string
  /** GET the previous step's {url} (origin stripped), optionally for another id or without its token. */
  from_url?: { id?: string; token?: string }
  /** Sleep this long before sending (background fills land). */
  wait_ms?: number
}
type Seed = { imdb_id: string; imdb: number | null; rt: number | null; rt_audience: number | null; metacritic: number | null; age_ms: number }
type Scenario = {
  name: string
  env?: Record<string, string>
  /** Keys removed from ENV for this scenario. */
  unset?: string[]
  upstream: Route[]
  /** eex-ytresolve answers per video id ({GV} is the fake's origin). */
  resolve?: Record<string, unknown>
  /** yt-dlp -g output per video id. */
  ytdlp?: Record<string, string>
  seed?: Seed[]
  steps: Step[]
}
const get = (as: Who | undefined, p: string, name = `${as ?? 'anon'} GET ${p}`): Step => ({ name, as, path: p })

const RT_HTML = (critics: string, audience: string) =>
  `<script>{"audienceScore":{"bandedRatingCount":"25,000+ Ratings","score":"${audience}","title":"Avg. Popcornmeter"},"criticsScore":{"averageRating":"9.20","score":"${critics}","title":"Avg. Tomatometer"}}</script>`
const omdb = (id: string, body: unknown, status = 200, opts: Partial<Route> = {}) => route('/omdb/', status, body, { query: { i: id }, ...opts })
const wikidata = (bindings: Array<[string, string]>, status = 200) =>
  route('/wikidata/sparql', status, { results: { bindings: bindings.map(([imdb, rt]) => ({ imdb: { type: 'literal', value: imdb }, rt: { type: 'literal', value: rt } })) } })
const BB_OMDB = { Response: 'True', imdbRating: '9.5', Metascore: '87', Ratings: [{ Source: 'Internet Movie Database', Value: '9.5/10' }, { Source: 'Rotten Tomatoes', Value: '90%' }] }
const MISSING_OMDB = { Response: 'False', Error: 'Incorrect IMDb ID.' }

const TRAILER = { key: 'dQw4w9WgXcQ', name: 'Official Trailer', site: 'YouTube', type: 'Trailer', official: true }
const MB = 1_048_576
const pair = (video: string, audio: string, extra: Record<string, unknown> = {}) => ({
  video_id: 'x',
  hls: null,
  progressive: null,
  video: { url: `{GV}/gv/${video}`, mime: 'video/mp4; codecs="avc1.640028"', height: 1080, bitrate: 4500000 },
  audio: { url: `{GV}/gv/${audio}`, mime: 'audio/mp4; codecs="mp4a.40.2"', height: null, bitrate: 128000 },
  duration_secs: 212,
  ...extra,
})
const bare = (extra: Record<string, unknown>) => ({ video_id: 'x', hls: null, progressive: null, video: null, audio: null, duration_secs: null, ...extra })
const stream = (id: string) => `/api/tmdb/trailer/${id}/stream.mp4`

const SCENARIOS: Scenario[] = [
  // --- auth and configuration ---
  {
    name: 'tmdb unauthenticated',
    upstream: [],
    steps: [
      get(undefined, '/api/tmdb/credits?type=movie&tmdbId=550'),
      get(undefined, '/api/tmdb/trending/movie'),
      get(undefined, '/api/tmdb/videos?type=movie&tmdbId=550'),
      get(undefined, '/api/tmdb/related?type=movie&tmdbId=550'),
      get(undefined, '/api/tmdb/person/287'),
      get(undefined, '/api/tmdb/person/287/credits'),
      get(undefined, '/api/tmdb/trailer?key=dQw4w9WgXcQ'),
      get(undefined, stream('dQw4w9WgXcQ')),
      get(undefined, '/api/ratings?ids=tt0903747'),
    ],
  },
  {
    name: 'tmdb not configured',
    unset: ['TMDB_API_KEY'],
    upstream: [],
    steps: [
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/credits'),
      get('alice', '/api/tmdb/trending/movie'),
      get('alice', '/api/tmdb/trending/anime'),
      get('alice', '/api/tmdb/videos?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/related?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/person/287'),
      get('alice', '/api/tmdb/person/abc/credits'),
    ],
  },

  // --- credits ---
  {
    name: 'credits movie with an api key',
    upstream: [tmdb('/movie/550/credits', 200, { id: 550, cast: [{ name: 'Edward Norton', character: 'Narrator' }], crew: [] })],
    steps: [get('alice', '/api/tmdb/credits?type=movie&tmdbId=550'), get('admin', '/api/tmdb/credits?type=movie&tmdbId=%20550%20&tmdbId=7')],
  },
  {
    name: 'credits movie with a read token',
    env: { TMDB_READ_ACCESS_TOKEN: 'placeholder-tmdb-read-token', TMDB_API_KEY: 'placeholder-fallback-key' },
    upstream: [tmdb('/movie/550/credits', 200, { cast: [], crew: [] })],
    steps: [get('alice', '/api/tmdb/credits?type=movie&tmdbId=550')],
  },
  {
    name: 'credits failures',
    upstream: [
      tmdb('/movie/550/credits', 500, { status_message: 'boom' }),
      tmdb('/movie/551/credits', 200, 'not json'),
      tmdb('/find/8511', 502, { status_message: 'gone' }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/find/8512', 200, { tv_results: [{ id: 12345 }] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/tv/12345/aggregate_credits', 500, { status_message: 'nope' }),
    ],
    steps: [
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=551'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=8511'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=8512'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=4040'),
    ],
  },
  {
    name: 'credits tv',
    upstream: [
      tmdb('/find/8511', 200, { movie_results: [], tv_results: [{ id: 12345, name: 'Shogun' }] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/tv/12345/aggregate_credits', 200, { cast: [{ name: 'Anna Sawai', roles: [{ character: 'Mariko' }] }], crew: [], id: 12345 }),
      tmdb('/find/99999', 200, { tv_results: [] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/find/99998', 200, { tv_results: [{ id: 0 }] }, { query: { external_source: 'tvdb_id' } }),
    ],
    steps: [
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=8511'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=99999'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=99998'),
    ],
  },
  {
    name: 'credits malformed queries',
    upstream: [],
    steps: [
      get('alice', '/api/tmdb/credits'),
      get('alice', '/api/tmdb/credits?type=tv'),
      get('alice', '/api/tmdb/credits?type=movie'),
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=abc'),
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=-5'),
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=1.5'),
      get('alice', '/api/tmdb/credits?type=movie&tmdbId=9007199254740993'),
      get('alice', '/api/tmdb/credits?type=tv&tvdbId=0'),
      get('alice', '/api/tmdb/credits?type=TV&tvdbId=1'),
    ],
  },

  // --- person ---
  {
    name: 'person',
    upstream: [
      tmdb('/person/287', 200, { id: 287, name: 'Brad Pitt', profile_path: '/bp.jpg', biography: 'Actor.', known_for_department: 'Acting', birthday: '1963-12-18' }),
      tmdb('/person/287/combined_credits', 200, {
        id: 287,
        cast: [
          { id: 1877, media_type: 'tv', name: 'True Detective', poster_path: '/td.jpg', first_air_date: '2014-01-12', character: 'Self', vote_average: 6.1, popularity: 9 },
          { id: 550, media_type: 'movie', title: 'Fight Club', poster_path: '/fc.jpg', release_date: '1999-10-15', character: 'Tyler Durden', vote_average: 8.4, popularity: 42 },
          { id: 999, media_type: 'movie', poster_path: '/x.jpg', character: 'no-title-dropped' },
          { id: 5, media_type: 'person', name: 'Not a title', popularity: 99 },
          { id: 6, media_type: 'movie', title: 'Tie A', vote_average: 5, popularity: 9 },
          { id: 7, media_type: 'movie', title: 'Tie B', vote_average: 7, popularity: 9 },
          { id: 8, media_type: 'movie', title: '', name: 'Named', popularity: 1 },
          { media_type: 'tv', name: 'No id' },
        ],
        crew: [],
      }),
      tmdb('/person/288', 200, { name: 'Sparse' }),
      tmdb('/person/288/combined_credits', 200, {}),
      tmdb('/person/289', 500, { status_message: 'boom' }),
      tmdb('/person/290', 200, { id: 290, name: 'X' }),
      tmdb('/person/290/combined_credits', 500, { status_message: 'nope' }),
    ],
    steps: [
      get('alice', '/api/tmdb/person/287'),
      get('alice', '/api/tmdb/person/287/credits'),
      get('alice', '/api/tmdb/person/288'),
      get('alice', '/api/tmdb/person/289'),
      get('alice', '/api/tmdb/person/290'),
      get('alice', '/api/tmdb/person/290/credits'),
      get('alice', '/api/tmdb/person/abc'),
      get('alice', '/api/tmdb/person/0'),
    ],
  },
  {
    name: 'person filmography cap',
    upstream: [
      tmdb('/person/287', 200, { id: 287, name: 'Brad Pitt' }),
      tmdb('/person/287/combined_credits', 200, {
        cast: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, media_type: 'movie', title: `M${i + 1}`, poster_path: `/p${i}.jpg`, popularity: i + 1 })),
      }),
    ],
    steps: [get('alice', '/api/tmdb/person/287')],
  },

  // --- trending ---
  {
    name: 'trending',
    upstream: [
      tmdb('/trending/movie/week', 200, { page: 1, results: [{ id: 1, title: 'Foo' }], total_pages: 1 }),
      tmdb('/trending/tv/week', 500, { status_message: 'boom' }),
    ],
    steps: [
      get('alice', '/api/tmdb/trending/movie'),
      get('admin', '/api/tmdb/trending/tv'),
      get('alice', '/api/tmdb/trending/anime'),
    ],
  },

  // --- videos ---
  {
    name: 'videos ranking',
    upstream: [
      tmdb('/movie/550/videos', 200, {
        id: 550,
        results: [
          { key: '9bZkp7q19f0', name: 'Featurette', site: 'YouTube', type: 'Featurette' },
          { key: 'kJQP7kiw5Fk', name: 'Teaser', site: 'YouTube', type: 'Teaser' },
          { key: 'abc123ABC_-', name: 'Fan Trailer', site: 'YouTube', type: 'Trailer', official: false },
          TRAILER,
          { key: '12345678901', name: 'Vimeo clip', site: 'Vimeo', type: 'Trailer' },
          { key: 'short', name: 'Bad id', site: 'YouTube', type: 'Trailer' },
          { key: 'zzzzzzzzzzz', name: 'Clip', site: 'YouTube', type: 'Clip', official: true },
          { key: 'yyyyyyyyyyy', site: 'YouTube', type: 'Trailer', official: 1 },
        ],
      }),
      tmdb('/movie/551/videos', 200, {}),
      tmdb('/movie/552/videos', 500, { error: 'boom' }),
    ],
    steps: [
      get('alice', '/api/tmdb/videos?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/videos?type=movie&tmdbId=551'),
      get('alice', '/api/tmdb/videos?type=movie&tmdbId=552'),
    ],
  },
  {
    name: 'videos tv and find failures',
    upstream: [
      tmdb('/find/77777', 200, { tv_results: [{ id: 1396 }] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/tv/1396/videos', 200, { results: [TRAILER] }),
      tmdb('/find/77778', 200, { tv_results: [] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/find/77779', 500, { status_message: 'down' }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/find/77780', 200, { tv_results: [{ id: 0 }] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/tv/0/videos', 200, { results: [] }),
    ],
    steps: [
      get('alice', '/api/tmdb/videos?type=tv&tvdbId=77777'),
      get('alice', '/api/tmdb/videos?type=tv&tvdbId=77778'),
      get('alice', '/api/tmdb/videos?type=tv&tvdbId=77779'),
      get('alice', '/api/tmdb/videos?type=tv&tvdbId=77780'),
      get('alice', '/api/tmdb/videos?tmdbId=550'),
      get('alice', '/api/tmdb/videos?type=movie'),
      get('alice', '/api/tmdb/videos?type=tv'),
      get('alice', '/api/tmdb/videos?type=tv&tmdbId=550'),
    ],
  },

  // --- related ---
  {
    name: 'related',
    upstream: [
      tmdb('/movie/550/recommendations', 200, {
        page: 1,
        results: [
          ...Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `Movie ${i + 1}`, poster_path: `/p${i + 1}.jpg`, release_date: '2021-05-04' })),
          { id: 999, title: 'No poster', poster_path: null, release_date: '2020-01-01' },
        ],
      }),
      tmdb('/movie/551/recommendations', 200, { results: [] }),
      tmdb('/movie/551/similar', 200, { results: [{ id: 12, title: 'Similar', poster_path: '/s.jpg', release_date: '2019-01-01' }] }),
      tmdb('/movie/552/recommendations', 500, { status_message: 'boom' }),
      tmdb('/movie/552/similar', 404, { status_message: 'gone' }),
      tmdb('/find/81189', 200, { tv_results: [{ id: 1396 }] }, { query: { external_source: 'tvdb_id' } }),
      tmdb('/tv/1396/recommendations', 200, {
        results: [
          { id: 60059, name: 'Better Call Saul', poster_path: '/bcs.jpg', first_air_date: '2015-02-08' },
          { id: 2, name: 'No date', poster_path: '/nd.jpg', first_air_date: '' },
          { id: 3, title: '', name: 'Empty title', poster_path: '/et.jpg', release_date: 'abcd' },
          { id: 4, poster_path: '/nt.jpg' },
        ],
      }),
      tmdb('/find/81190', 200, { tv_results: [] }, { query: { external_source: 'tvdb_id' } }),
    ],
    steps: [
      get('alice', '/api/tmdb/related?type=movie&tmdbId=550'),
      get('alice', '/api/tmdb/related?type=movie&tmdbId=551'),
      get('alice', '/api/tmdb/related?type=movie&tmdbId=552'),
      get('alice', '/api/tmdb/related?type=tv&tvdbId=81189'),
      get('alice', '/api/tmdb/related?type=tv&tvdbId=81190'),
      get('alice', '/api/tmdb/related?tmdbId=550'),
    ],
  },

  // --- trailer resolution: hls, muxed + token, progressive, yt-dlp, 502 ---
  {
    name: 'trailer resolution order',
    upstream: [gv('video?id=1', MB + 524_288, 0), gv('audio', 1000, 7), gv('v403', 10, 0, 403), gv('a-ok', 10, 1)],
    resolve: {
      hlsAAAAAAAA: bare({ hls: '{GV}/hls/master.m3u8', progressive: '{GV}/p.mp4', video: { url: '{GV}/gv/x', mime: 'v', height: null, bitrate: null }, audio: { url: '{GV}/gv/y', mime: 'a', height: null, bitrate: null } }),
      muxAAAAAAAA: pair('video?id=1', 'audio', { progressive: '{GV}/p360.mp4' }),
      mfpAAAAAAAA: pair('v403', 'a-ok', { progressive: '{GV}/p360.mp4' }),
      ffxAAAAAAAA: pair('a-ok', 'a-ok'),
      proAAAAAAAA: bare({ progressive: '{GV}/only.mp4', video: { url: '{GV}/gv/x', mime: 'v', height: null, bitrate: null } }),
      nulAAAAAAAA: bare({}),
    },
    ytdlp: {
      ffxAAAAAAAA: 'https://rr1.googlevideo.example/videoplayback?itag=18&id=ffx\n',
      ydlAAAAAAAA: 'WARNING: something\nhttps://rr2.googlevideo.example/videoplayback?itag=18\nhttps://second.example/\n',
    },
    steps: [
      get('alice', '/api/tmdb/trailer?key=hlsAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=muxAAAAAAAA'),
      { name: 'stream full', from_url: {} },
      { name: 'stream range', from_url: {}, range: 'bytes=1048570-1048579' },
      { name: 'stream suffix', from_url: {}, range: 'bytes=-10' },
      { name: 'stream open-ended', from_url: {}, range: 'bytes=1572800-' },
      { name: 'stream past the end', from_url: {}, range: 'bytes=99999999-' },
      { name: 'stream token for another id', from_url: { id: 'proAAAAAAAA' } },
      { name: 'stream bad token', from_url: { token: 'garbage' } },
      get('alice', '/api/tmdb/trailer?key=muxAAAAAAAA', 'alice re-taps the muxed trailer'),
      get('alice', '/api/tmdb/trailer?key=mfpAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=ffxAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=proAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=ydlAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=ydlAAAAAAAA', 'alice re-taps the yt-dlp trailer'),
      get('alice', '/api/tmdb/trailer?key=nulAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=badAAAAAAAA'),
      get('alice', '/api/tmdb/trailer?key=short'),
      get('alice', '/api/tmdb/trailer'),
      get('alice', stream('notMuxedYet')),
      get('alice', stream('bad')),
      get(undefined, `${stream('muxAAAAAAAA')}?t=`),
    ],
  },

  // --- ratings ---
  {
    name: 'ratings merge and cache',
    upstream: [
      wikidata([['tt0903747', 'tv/breaking_bad'], ['tt0903747', 'tv/duplicate'], ['tt0000001', 'Not A Slug']]),
      route('/rt/tv/breaking_bad', 200, RT_HTML('96', '97')),
      omdb('tt0903747', BB_OMDB),
      omdb('tt0000001', MISSING_OMDB),
    ],
    steps: [
      get('alice', '/api/ratings?ids=tt0903747,tt0000001'),
      get('alice', '/api/ratings?ids=tt0903747,tt0000001', 'repeat is served from server.db'),
      get('admin', '/api/ratings?ids=%20tt0903747%20,tt0903747,,'),
    ],
  },
  {
    name: 'ratings invalid ids',
    upstream: [],
    steps: [
      get('alice', '/api/ratings'),
      get('alice', '/api/ratings?ids='),
      get('alice', '/api/ratings?ids=breaking-bad'),
      get('alice', '/api/ratings?ids=tt0903747,tt12'),
      get('alice', `/api/ratings?ids=${Array.from({ length: 61 }, (_, i) => `tt${String(1000000 + i)}`).join(',')}`),
    ],
  },
  {
    name: 'ratings upstream failures',
    upstream: [
      wikidata([['tt0000002', 'm/rt_down'], ['tt0000003', 'm/rt_gone'], ['tt0000004', 'm/rt_null']]),
      route('/rt/m/rt_down', 500, 'down'),
      route('/rt/m/rt_gone', 404, 'gone'),
      route('/rt/m/rt_null', 200, '<html>no scores</html>'),
      omdb('tt0000001', 'oops', 500),
      omdb('tt0000002', BB_OMDB),
      omdb('tt0000003', { Response: 'True', imdbRating: 'N/A', Metascore: '61', Ratings: [{ Source: 'Rotten Tomatoes', Value: '77%' }] }),
      omdb('tt0000004', { Response: 'True', imdbRating: '7.0', Metascore: 'N/A', Ratings: [] }),
    ],
    steps: [
      get('alice', '/api/ratings?ids=tt0000001,tt0000002,tt0000003,tt0000004'),
      get('alice', '/api/ratings?ids=tt0000001,tt0000002,tt0000003,tt0000004', 'failures are retried, answers are not'),
    ],
  },
  {
    name: 'ratings without wikidata or an omdb key',
    unset: ['OMDB_API_KEY'],
    upstream: [wikidata([], 503), omdb('tt0000005', BB_OMDB)],
    steps: [get('alice', '/api/ratings?ids=tt0000005')],
  },
  {
    name: 'ratings ttl',
    upstream: [wikidata([]), omdb('tt0000006', BB_OMDB), omdb('tt0000007', BB_OMDB)],
    seed: [
      { imdb_id: 'tt0000006', imdb: 1.5, rt: 10, rt_audience: 20, metacritic: 30, age_ms: 60_000 },
      { imdb_id: 'tt0000007', imdb: 1.5, rt: 10, rt_audience: null, metacritic: 30, age_ms: 8 * 24 * 3600 * 1000 },
    ],
    steps: [get('alice', '/api/ratings?ids=tt0000006,tt0000007')],
  },
  {
    name: 'ratings pending past the sync wait',
    upstream: [
      wikidata([['tt0000008', 'm/slow']]),
      route('/rt/m/slow', 200, RT_HTML('55', ''), { delay_ms: 1500 }),
      omdb('tt0000008', BB_OMDB),
    ],
    steps: [
      get('alice', '/api/ratings?ids=tt0000008'),
      get('alice', '/api/ratings?ids=tt0000008', 'in flight: no second fill'),
      { ...get('alice', '/api/ratings?ids=tt0000008', 'after the fill lands'), wait_ms: 2000 },
    ],
  },
]

// --- the fake upstream ----------------------------------------------------------------

type Call = { method: string; path: string; query: string; authorization: string | null; user_agent: string | null; accept: string | null }
const calls: Call[] = []
let routes: Route[] = []
const fake = http.createServer((req, res) => {
  req.resume()
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const method = req.method ?? ''
    const ua = (req.headers['user-agent'] as string | undefined) ?? null
    const accept = (req.headers.accept as string | undefined) ?? null
    calls.push({
      method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      authorization: (req.headers.authorization as string | undefined) ?? null,
      // The runtime's own defaults (node's fetch, reqwest) are not ours.
      user_agent: ua === 'node' || ua === 'undici' ? null : ua,
      accept: accept === '*/*' ? null : accept,
    })
    const hit = routes.find((rt) => {
      const [rp, rq] = rt.path.split('?')
      const want = new URLSearchParams(rq ?? '')
      return (
        rt.method === method &&
        rp === url.pathname &&
        [...want].every(([k, v]) => url.searchParams.get(k) === v) &&
        Object.entries(rt.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v)
      )
    })
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"no fixture"}')
    }
    if (hit.delay_ms) await new Promise((ok) => setTimeout(ok, hit.delay_ms))
    if (hit.bytes !== undefined && hit.status === 200) {
      const m = /^(\d+)-(\d+)$/.exec(url.searchParams.get('range') ?? '')
      const start = m ? Number(m[1]) : 0
      const end = Math.min(m ? Number(m[2]) + 1 : hit.bytes, hit.bytes)
      const body = Buffer.alloc(Math.max(0, end - start))
      for (let i = 0; i < body.length; i++) body[i] = (start + i + (hit.seed ?? 0)) & 0xff
      res.writeHead(200, { 'content-type': hit.ct })
      return res.end(body)
    }
    res.writeHead(hit.status, { 'content-type': hit.ct })
    res.end(hit.text)
  })
})
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

/** Wait out requests still in flight (no new call for 100 ms). */
async function quiet(): Promise<void> {
  let seen = -1
  while (calls.length !== seen) {
    seen = calls.length
    await new Promise((ok) => setTimeout(ok, 100))
  }
}

// --- stubs, env, the TS app -----------------------------------------------------------

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-goldens-')))
const bin = path.join(dir, 'bin')
const tmp = path.join(dir, 'tmp')
fs.mkdirSync(path.join(bin, 'resolve'), { recursive: true })
fs.mkdirSync(path.join(bin, 'ytdlp'), { recursive: true })
fs.mkdirSync(tmp)
for (const stub of ['eex-ytresolve', 'yt-dlp', 'ffmpeg']) fs.symlinkSync(path.join(here, 'stubs', stub), path.join(bin, stub))
const muxDir = path.join(tmp, 'eex-ytmux')

Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  USER_POLICIES_PATH: path.join(dir, 'policies.json'),
  USER_FEEDBACK_PATH: path.join(dir, 'feedback.json'),
  REJECTIONS_PATH: path.join(dir, 'rejections.json'),
  USER_WATCHLIST_PATH: path.join(dir, 'watchlist.json'),
  EEX_YTRESOLVE_BIN: path.join(bin, 'eex-ytresolve'),
  PATH: `${bin}:${process.env.PATH}`,
  TMPDIR: tmp,
})
delete process.env.NODE_ENV
process.chdir(dir)

const BASES: Array<[string, string]> = [
  ['https://api.themoviedb.org/3', `${fakeUrl}/tmdb/3`],
  ['https://www.omdbapi.com/', `${fakeUrl}/omdb/`],
  ['https://query.wikidata.org/sparql', `${fakeUrl}/wikidata/sparql`],
  ['https://www.rottentomatoes.com/', `${fakeUrl}/rt/`],
]
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  let url = String(input instanceof Request ? input.url : input)
  for (const [from, to] of BASES) if (url.startsWith(from)) url = to + url.slice(from.length)
  if (!url.startsWith(fakeUrl)) throw new Error(`gen-tmdb-goldens: no network (${url})`)
  return realFetch(url, init)
}) as typeof fetch
// The ratings route's 6 s synchronous wait runs as 400 ms (the replay's Timings).
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) =>
  realSetTimeout(fn, ms === 6_000 ? 400 : ms, ...args)) as typeof setTimeout
const log = console.log
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const { app } = await import(path.join(server, 'app.js'))
const { createMemberSession } = await import(path.join(server, 'test/authFixture.js'))
const { serverDb } = await import(path.join(server, 'services/serverDb.js'))
const { env } = await import(path.join(server, 'env.js'))
const cookies: Record<string, string> = {}
for (const [who, m] of Object.entries(MEMBERS)) {
  cookies[who] = `eex.session=${await createMemberSession({ sub: m.sub, username: m.username, role: m.role })}`
}

const ENV_KEYS: Record<string, string> = Object.fromEntries([
  ['TMDB_API_KEY', 'tmdbApiKey'],
  ['TMDB_READ_ACCESS_TOKEN', 'tmdbReadAccessToken'],
  ['OMDB_API_KEY', 'omdbApiKey'],
])
const norm = (s: string) =>
  s.split(fakeUrl).join('{GV}').split(muxDir).join('<mux>').replace(/([?&]t=)[A-Za-z0-9_.-]+/g, '$1<token>')
const takeLines = (file: string) => {
  const p = path.join(bin, file)
  if (!fs.existsSync(p)) return []
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(norm)
  fs.rmSync(p)
  return lines
}
const isText = (ct: string | null) => ct === null || /json|text/.test(ct)

const out = []
for (const sc of SCENARIOS) {
  serverDb().raw.prepare('DELETE FROM title_ratings').run()
  for (const s of sc.seed ?? []) {
    serverDb()
      .raw.prepare('INSERT INTO title_ratings (imdb_id, imdb, rt, rt_audience, metacritic, rt_slug, fetched_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(s.imdb_id, s.imdb, s.rt, s.rt_audience, s.metacritic, Date.now() - s.age_ms)
  }
  for (const [id, body] of Object.entries(sc.resolve ?? {})) {
    fs.writeFileSync(path.join(bin, 'resolve', `${id}.json`), JSON.stringify(body).split('{GV}').join(fakeUrl) + '\n')
  }
  for (const [id, text] of Object.entries(sc.ytdlp ?? {})) fs.writeFileSync(path.join(bin, 'ytdlp', id), text)
  const saved: Record<string, unknown> = {}
  const overrides: Array<[string, string | null]> = [
    ...Object.entries(sc.env ?? {}),
    ...(sc.unset ?? []).map((k): [string, null] => [k, null]),
  ]
  for (const [k, v] of overrides) {
    const key = ENV_KEYS[k]
    if (!key) throw new Error(`unmapped env ${k}`)
    saved[key] = env[key]
    env[key] = v
  }
  routes = sc.upstream
  const steps = []
  let lastUrl: string | null = null
  for (const st of sc.steps) {
    if (st.wait_ms) await new Promise((ok) => realSetTimeout(ok, st.wait_ms))
    let p = st.path
    if (st.from_url) {
      if (!lastUrl) throw new Error(`${st.name}: no previous url`)
      const u = new URL(lastUrl)
      if (st.from_url.id) u.pathname = u.pathname.replace(/\/trailer\/[^/]+\//, `/trailer/${st.from_url.id}/`)
      if (st.from_url.token !== undefined) u.searchParams.set('t', st.from_url.token)
      p = u.pathname + u.search
    }
    const headers: Record<string, string> = {}
    if (st.as) headers.Cookie = cookies[st.as]
    if (st.range) headers.Range = st.range
    const res: Response = await app.request(new Request(`http://localhost${p}`, { headers }))
    const buf = Buffer.from(await res.arrayBuffer())
    await quiet()
    const ct = res.headers.get('content-type')
    const text = isText(ct) ? buf.toString('utf8') : null
    if (text && res.status === 200) {
      try {
        const parsed = JSON.parse(text) as { url?: unknown }
        if (typeof parsed.url === 'string' && parsed.url.includes('/stream.mp4?t=')) lastUrl = parsed.url
      } catch {
        // not JSON
      }
    }
    steps.push({
      name: st.name,
      ...(st.as ? { as: st.as } : {}),
      ...(st.path ? { path: st.path } : {}),
      ...(st.from_url ? { from_url: st.from_url } : {}),
      ...(st.range ? { range: st.range } : {}),
      ...(st.wait_ms ? { wait_ms: st.wait_ms } : {}),
      status: res.status,
      content_type: ct,
      content_range: res.headers.get('content-range'),
      body: text === null ? null : norm(text),
      body_len: buf.length,
      body_sum: buf.reduce((a, b) => (a + b) % 4294967296, 0),
      calls: calls.splice(0, calls.length).map((c) => ({ ...c, query: norm(c.query) })),
      ytresolve: takeLines('ytresolve.calls'),
      ytdlp: takeLines('ytdlp.calls'),
      ffmpeg: takeLines('ffmpeg.calls'),
    })
  }
  for (const [k, v] of Object.entries(saved)) env[k] = v
  out.push({ name: sc.name, env: sc.env ?? {}, unset: sc.unset ?? [], upstream: sc.upstream, resolve: sc.resolve ?? {}, ytdlp: sc.ytdlp ?? {}, seed: sc.seed ?? [], steps })
}

console.log = log
fake.close()
fs.writeFileSync(
  path.join(here, 'tmdb-goldens.json'),
  JSON.stringify({ env: ENV, members: MEMBERS, scenarios: out }, null, 2) + '\n',
)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
