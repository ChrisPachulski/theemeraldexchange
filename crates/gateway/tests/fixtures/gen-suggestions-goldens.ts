// Writes suggestions-goldens.json from the untouched TS server:
//
//  * "prompts": the prompt builders (services/suggestionsPrompt.ts,
//    suggestionsRecentlyShown.ts) and the title/genre helpers
//    (suggestionsShared.ts, suggestionsTmdb.ts) run over fixed fixtures.
//    src/suggestions/goldens.rs requires the Rust text to match exactly.
//  * "scenarios": GET /api/suggestions/:type through server/app.ts against one
//    local fake standing in for Radarr (/radarr), Sonarr (/sonarr), TMDB
//    (/tmdb/3), Anthropic (/anthropic), the recommender (/rec) and the iptv
//    service (/iptv), answering from each scenario's routes and recording every
//    request. Per step it keeps the status, Content-Type, the Server-Timing
//    phase names, the body, the fake's requests (method, path, query, body,
//    key headers), the usage.jsonl lines the step appended and the
//    rejections/feedback store files.
//
// Per-run values are normalized on both sides: today's date in a TMDB query
// becomes <today>, the refresh salt <salt>, a principal Bearer <principal>,
// a usage line's ts is dropped, and the CANDIDATE POOL lines (shuffled per
// request) are compared sorted without their numbers.
//
// The Anthropic call goes through the real @anthropic-ai/sdk, whose fetch is
// the wrapped global below. The 20 s Claude deadline (and the SDK's own
// per-request timeout) run as 1.5 s, as in the replay. Stored keys only: the
// X-Anthropic-Api-Key header is not ported, so no scenario sends it.
//
// No network: globalThis.fetch rewrites the TMDB and Anthropic bases to the
// fake on 127.0.0.1 and throws for every other host.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-suggestions-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

const ENV: Record<string, string> = {
  SESSION_SECRET: 'suggest-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'suggest-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'suggest-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'suggest-goldens-internal-principal-placeholder-zzz',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  RADARR_API_KEY: 'placeholder-radarr-key',
  SONARR_API_KEY: 'placeholder-sonarr-key',
  RECOMMENDER_EVENT_SECRET: 'suggest-goldens-recommender-secret',
  USE_MEDIA_CORE: '1',
}
const TMDB_KEY = 'placeholder-tmdb-key'
const TMDB_TOKEN = 'placeholder-tmdb-read-token'
const ANTHROPIC = 'sk-ant-placeholder-stored-key-0001'
const MEMBERS = {
  alice: { sub: 'apple:000001.0123456789abcdef0123456789abcdef.0001', username: 'alice', role: 'user' },
  bob: { sub: 'google:1234567890', username: 'bob', role: 'user' },
  admin: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'admin', role: 'admin' },
} as const
type Who = keyof typeof MEMBERS

// --- fixtures ---------------------------------------------------------------------------

type Lib = { title?: string; year?: number; tmdbId?: number; genres?: string[] }
const lib = (titles: Array<[string, number, number, string[]]>): Lib[] =>
  titles.map(([title, year, tmdbId, genres]) => ({ title, year, tmdbId, genres }))
const tenOf = (prefix: string, id0: number, genres: (i: number) => string[]): Lib[] =>
  Array.from({ length: 10 }, (_, i) => ({ title: `${prefix} ${'ABCDEFGHIJ'[i]}`, year: 2010 + i, tmdbId: id0 + i + 1, genres: genres(i) }))
const MIXED = (i: number) => [['Drama'], ['Drama'], ['Crime'], ['Drama'], ['Crime'], ['Drama'], ['Thriller'], ['Drama'], ['Crime'], ['Drama']][i]!

// suggestions.test.ts "prompt shape" library.
const SONARR10 = lib([
  ['Sons of Anarchy', 2008, 1001, ['Crime', 'Drama']],
  ['House of the Dragon', 2022, 1002, ['Drama', 'Fantasy']],
  ['The Crown', 2016, 1003, ['Drama', 'History']],
  ['Succession', 2018, 1004, ['Drama']],
  ['Better Call Saul', 2015, 1005, ['Crime', 'Drama']],
  ['Mindhunter', 2017, 1006, ['Crime', 'Drama']],
  ['Halt and Catch Fire', 2014, 1007, ['Drama']],
  ['Ozark', 2017, 1008, ['Crime', 'Drama', 'Thriller']],
  ['The Wire', 2002, 1009, ['Crime', 'Drama']],
  ['The Americans', 2013, 1010, ['Crime', 'Drama', 'Thriller']],
])
const RADARR_NOLAN = lib([
  ['The Dark Knight', 2008, 2001, ['Action', 'Crime']],
  ['Inception', 2010, 2002, ['Action', 'Sci-Fi']],
  ['Interstellar', 2014, 2003, ['Sci-Fi', 'Drama']],
  ['No Country for Old Men', 2007, 2004, ['Crime', 'Drama']],
  ['There Will Be Blood', 2007, 2005, ['Drama']],
  ['The Departed', 2006, 2006, ['Crime', 'Drama']],
  ['Zodiac', 2007, 2007, ['Crime', 'Drama']],
  ['Prisoners', 2013, 2008, ['Crime', 'Drama']],
  ['Sicario', 2015, 2009, ['Crime', 'Drama']],
  ['Arrival', 2016, 2010, ['Sci-Fi', 'Drama']],
])
const RADARR_HEAT = lib([
  ['The Dark Knight', 2008, 2001, ['Action', 'Crime']],
  ['Inception', 2010, 2002, ['Action', 'Sci-Fi']],
  ['Interstellar', 2014, 2003, ['Sci-Fi', 'Drama']],
  ['Heat', 1995, 2004, ['Action', 'Crime', 'Drama']],
  ['No Country for Old Men', 2007, 2005, ['Crime', 'Drama', 'Thriller']],
  ['There Will Be Blood', 2007, 2006, ['Drama']],
  ['The Departed', 2006, 2007, ['Crime', 'Drama', 'Thriller']],
  ['Zodiac', 2007, 2008, ['Crime', 'Drama', 'Mystery']],
  ['Prisoners', 2013, 2009, ['Crime', 'Drama', 'Mystery', 'Thriller']],
  ['Sicario', 2015, 2010, ['Action', 'Crime', 'Drama', 'Thriller']],
])
const RADARR_FRANCHISE = lib([
  ['Star Wars: A New Hope', 1977, 11, ['Action', 'Adventure']],
  ['It: Chapter Two', 2019, 459151, ['Horror']],
  ['Heat', 1995, 949, ['Crime', 'Drama']],
  ['Zodiac', 2007, 1451, ['Crime', 'Drama']],
  ['Fargo', 1996, 275, ['Crime', 'Drama']],
  ['Prisoners', 2013, 146233, ['Crime', 'Drama']],
  ['Sicario', 2015, 274479, ['Crime', 'Drama']],
  ['No Country for Old Men', 2007, 6977, ['Crime', 'Drama']],
  ['There Will Be Blood', 2007, 4944, ['Drama']],
  ['The Big Short', 2015, 318846, ['Drama']],
])
const TV_CRIME = lib([
  ['Peaky Blinders', 2013, 3001, ['Crime', 'Drama']],
  ['The Sopranos', 1999, 3002, ['Crime', 'Drama']],
  ['Boardwalk Empire', 2010, 3003, ['Crime', 'Drama']],
  ['Ozark', 2017, 3004, ['Crime', 'Drama', 'Thriller']],
  ['The Wire', 2002, 3005, ['Crime', 'Drama']],
  ['Narcos', 2015, 3006, ['Crime', 'Drama']],
  ['Better Call Saul', 2015, 3007, ['Crime', 'Drama']],
  ['Mindhunter', 2017, 3008, ['Crime', 'Drama']],
  ['True Detective', 2014, 3009, ['Crime', 'Drama', 'Mystery']],
  ['Hannibal', 2013, 3010, ['Crime', 'Drama', 'Thriller']],
])

// --- the fake's routes ------------------------------------------------------------------

type Route = {
  method: string
  path: string
  /** Match any path starting with `path`. */
  prefix?: boolean
  query?: Record<string, string>
  status: number
  text: string
  ct: string
  headers?: Record<string, string>
  delay_ms?: number
  /** Answer this many times, then fall through to later routes. */
  times?: number
}
const json = (method: string, p: string, status: number, body: unknown, opts: Partial<Route> = {}): Route => ({
  method,
  path: p,
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  ct: 'application/json',
  ...opts,
})
const radarr = (body: unknown, opts: Partial<Route> = {}) => json('GET', '/radarr/api/v3/movie', 200, body, opts)
const sonarr = (body: unknown, opts: Partial<Route> = {}) => json('GET', '/sonarr/api/v3/series', 200, body, opts)
const tmdb = (p: string, body: unknown, opts: Partial<Route> = {}) => json('GET', `/tmdb/3${p}`, 200, body, opts)
type Row = { id: number; title?: string; name?: string; poster_path?: string | null; release_date?: string; first_air_date?: string; overview?: string }
const results = (rows: Row[]) => ({ results: rows.map((r) => ({ poster_path: null, ...r })) })
const tvRow = (id: number, name: string, first_air_date: string): Row => ({ id, name, first_air_date })
const movieRow = (id: number, title: string, release_date: string): Row => ({ id, title, release_date })

type Pick = { title?: unknown; year?: unknown; reason?: unknown }
const message = (picks: Pick[] | null, opts: { id?: string; stop?: string; usage?: Record<string, number>; text?: boolean } = {}) => ({
  id: 'msg_golden',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5',
  content: opts.text
    ? [{ type: 'text', text: 'whoops, no tool here' }]
    : [{ type: 'tool_use', id: opts.id ?? 'tu_golden', name: 'submit_recommendations', input: { picks } }],
  stop_reason: opts.stop ?? 'tool_use',
  stop_sequence: null,
  usage: opts.usage ?? { input_tokens: 1, output_tokens: 1 },
})
const claude = (msg: unknown, opts: Partial<Route> = {}) => json('POST', '/anthropic/v1/messages', 200, msg, opts)
const score = (body: unknown, status = 200) => json('POST', '/rec/score', status, body)
const iptvLinks = (ids: number[]) => json('POST', '/iptv/internal/availability', 200, { tmdb_ids: ids })

// Appended to every scenario: what the TS tests' catch-all stubs answered.
const DEFAULTS: Route[] = [
  json('GET', '/tmdb/3/', 200, { results: [] }, { prefix: true }),
  claude(message([])),
  iptvLinks([]),
  json('POST', '/rec/', 200, {}, { prefix: true }),
]

// --- scenarios --------------------------------------------------------------------------

type Step = {
  name: string
  as?: Who
  path: string
  /** Default https://app.example (the SPA's origin); null sends none. */
  origin?: string | null
  /** Drop the 30 s library TTL entry first (the TS tests' _resetLibraryCacheForTests). */
  reset_library_cache?: boolean
  /** Send this many identical requests at once. */
  concurrent?: number
}
type Entry = { id: number; title: string }
type Scenario = {
  name: string
  /** USE_LOCAL_RECOMMENDER=1. */
  recommender?: boolean
  /** TMDB credential: an API key (default), a read token, or none. */
  tmdb?: 'key' | 'token' | 'none'
  /** Members holding a stored Anthropic key (default: alice). */
  keys?: Who[]
  rejections?: { movie?: Entry[]; tv?: Entry[] }
  feedback?: Partial<Record<Who, { movie?: { liked?: Entry[]; disliked?: Entry[] }; tv?: { liked?: Entry[]; disliked?: Entry[] } }>>
  upstream: Route[]
  steps: Step[]
}
const get = (path: string, opts: Partial<Step> = {}): Step => ({ name: `GET ${path}`, as: 'alice', path, origin: 'https://app.example', ...opts })
const MOVIE = '/api/suggestions/movie'
const TV = '/api/suggestions/tv'

const SCENARIOS: Scenario[] = [
  // --- gating ---
  { name: 'unauthenticated', upstream: [], steps: [get(MOVIE, { as: undefined, name: 'anon' })] },
  {
    name: 'invalid type and the trusted-origin gate',
    upstream: [],
    steps: [
      get('/api/suggestions/books', { origin: null, name: 'no origin' }),
      get('/api/suggestions/books', { origin: 'https://evil.example', name: 'hostile origin' }),
      get('/api/suggestions/books', { name: 'allowed origin' }),
    ],
  },
  { name: 'tmdb not configured', tmdb: 'none', upstream: [radarr([])], steps: [get(MOVIE)] },
  {
    name: 'no tool_use reply but tmdb not configured',
    tmdb: 'none',
    upstream: [radarr([]), claude(message(null, { text: true }))],
    steps: [get(MOVIE)],
  },
  {
    name: 'diag counts',
    rejections: { movie: [{ id: 8801, title: 'Movie To Reject A' }, { id: 8802, title: 'Movie To Reject B' }] },
    upstream: [radarr([...tenOf('M', 6000, MIXED), { title: 'M11', year: 2020, tmdbId: 6011, genres: ['Drama'] }])],
    steps: [get(MOVIE)],
  },
  {
    name: 'force trending',
    upstream: [
      radarr([{ title: 'Force Trending Lib', year: 2020, tmdbId: 5001, genres: ['Drama'] }, ...tenOf('Drama Movie', 5001, () => ['Drama']).slice(1)]),
      tmdb('/trending/movie/week', results([movieRow(5001, 'Force Trending Lib', '2020-01-01'), movieRow(5999, 'Clean Trending Item', '2025-01-01')]), { query: { page: '1' } }),
    ],
    steps: [get(`${MOVIE}?force=trending`)],
  },
  {
    name: 'force trending with a read token, tagged by iptv',
    tmdb: 'token',
    upstream: [radarr([]), tmdb('/trending/movie/week', results([movieRow(5999, 'IPTV Linked Pick', '2025-01-01'), movieRow(5998, 'Not Linked', '2024-06-01')]), { query: { page: '1' } }), iptvLinks([5999, 4242])],
    steps: [get(`${MOVIE}?force=trending`)],
  },
  {
    name: 'force trending survives a failed page',
    upstream: [
      radarr(lib([['Lib Drama A', 2020, 7001, ['Drama']], ['Lib Drama B', 2019, 7002, ['Drama']], ['Lib Drama C', 2018, 7003, ['Drama']]])),
      ...[1, 2, 4, 5].map((p) => tmdb('/trending/movie/week', results([movieRow(8000 + p, `Trending Pick P${p}`, '2025-01-01')]), { query: { page: String(p) } })),
      json('GET', '/tmdb/3/trending/movie/week', 500, { status_message: 'boom' }, { query: { page: '3' } }),
    ],
    steps: [get(`${MOVIE}?force=trending`)],
  },
  {
    name: 'an empty trending result is not cached',
    upstream: [
      radarr(lib([['Lib A', 2020, 9001, ['Drama']], ['Lib B', 2019, 9002, ['Drama']], ['Lib C', 2018, 9003, ['Drama']]])),
      json('GET', '/tmdb/3/trending/movie/week', 503, 'Service Unavailable', { times: 5, ct: 'text/plain' }),
      tmdb('/trending/movie/week', results([movieRow(9999, 'Recovered Pick', '2025-01-01')]), { query: { page: '1' } }),
    ],
    steps: [get(`${MOVIE}?force=trending`, { name: 'all pages 503' }), get(`${MOVIE}?force=trending`, { name: 'recovered' })],
  },
  {
    name: 'library unavailable',
    upstream: [json('GET', '/radarr/api/v3/movie', 503, 'boom', { ct: 'text/plain' })],
    steps: [get(MOVIE)],
  },
  {
    name: 'stale library fallback',
    upstream: [
      radarr(lib([['Snapshot Lib', 2020, 4001, ['Drama']]]), { times: 1 }),
      json('GET', '/radarr/api/v3/movie', 502, 'boom', { ct: 'text/plain' }),
      tmdb('/trending/movie/week', results([movieRow(4001, 'Snapshot Lib', '2020-01-01'), movieRow(4999, 'Clean Trending', '2025-01-01')]), { query: { page: '1' } }),
    ],
    steps: [
      get(`${MOVIE}?force=trending`, { name: 'primes the snapshot' }),
      get(`${MOVIE}?force=trending`, { name: 'radarr down: stale snapshot filters', reset_library_cache: true }),
      get(`${MOVIE}?force=trending`, { name: 'inside the 15 s failure cache: no radarr call' }),
    ],
  },
  {
    name: 'cold start',
    upstream: [sonarr([]), radarr([])],
    steps: [get(TV), get(MOVIE, { name: '/movie asks Radarr only' })],
  },

  // --- the Claude path ---
  {
    name: 'malformed picks are filtered',
    upstream: [
      sonarr(tenOf('Series', 2999, () => ['Drama'])),
      claude(message([{ title: 'Good Pick', year: 2021 }, { title: null, year: 2020 }, { year: 2019 }, { title: 123, year: 2018 }, { title: '', year: 2017 }, { title: '  ', year: 2016 }], { id: 'tu_malformed' }), { times: 1 }),
    ],
    steps: [get(TV)],
  },
  {
    name: 'max_tokens truncation',
    upstream: [sonarr(tenOf('Series', 2999, () => ['Drama'])), claude(message([], { id: 'tu_truncated', stop: 'max_tokens' }))],
    steps: [get(TV)],
  },
  {
    name: 'anthropic 529 then 200',
    upstream: [
      sonarr(tenOf('Drama Show', 4000, () => ['Drama'])),
      json('POST', '/anthropic/v1/messages', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { times: 1, headers: { 'retry-after-ms': '0' } }),
      claude(message([], { id: 'tu_retry_ok', usage: { input_tokens: 50, output_tokens: 5 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'anthropic timeout',
    upstream: [sonarr(SONARR10), claude(message([]), { delay_ms: 3000 }), tmdb('/trending/tv/week', results([tvRow(42, 'Fallback Show', '2024-01-01')]), { query: { page: '1' } })],
    steps: [get(TV)],
  },
  {
    name: 'anthropic 401',
    upstream: [sonarr(SONARR10), json('POST', '/anthropic/v1/messages', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })],
    steps: [get(TV)],
  },
  {
    name: 'liked titles backfill',
    feedback: { alice: { tv: { liked: [{ id: 9501, title: '' }] } } },
    upstream: [sonarr(tenOf('Show', 8200, MIXED)), tmdb('/tv/9501', { name: 'The Loved Show', title: null })],
    steps: [get(TV)],
  },
  {
    name: 'retryAttempted true then false',
    upstream: [
      sonarr(tenOf('RA Show', 9500, MIXED)),
      claude(message(tenOf('RA Show', 9500, MIXED).map((r) => ({ title: r.title, year: r.year })), { id: 'tu_retry_true', usage: { input_tokens: 50, output_tokens: 30 } }), { times: 2 }),
      claude(message([{ title: 'Clean External Show', year: 2022, reason: 'crime cluster' }], { id: 'tu_retry_false', usage: { input_tokens: 50, output_tokens: 20 } }), { times: 1 }),
      tmdb('/search/tv', results([tvRow(5_600_001, 'Clean External Show', '2022-01-01')])),
    ],
    steps: [get(TV, { name: 'all library picks' }), get(TV, { name: 'clean pick', reset_library_cache: true })],
  },
  {
    name: 'personalized empty reports lastCounters',
    upstream: [
      radarr(tenOf('Empty Path', 9400, MIXED)),
      claude(message(tenOf('Empty Path', 9400, MIXED).map((r) => ({ title: r.title, year: r.year })), { id: 'tu_empty_path', usage: { input_tokens: 50, output_tokens: 30 } })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'retry fires for pre-validation drops',
    upstream: [
      sonarr(lib([
        ['Prestige Show', 2010, 9301, ['Drama']], ['Crime Show', 2011, 9302, ['Crime']], ['Drama Show C', 2012, 9303, ['Drama']], ['Drama Show D', 2013, 9304, ['Drama']],
        ['Drama Show E', 2014, 9305, ['Drama']], ['Drama Show F', 2015, 9306, ['Drama']], ['Drama Show G', 2016, 9307, ['Drama']], ['Drama Show H', 2017, 9308, ['Drama']],
        ['Drama Show I', 2018, 9309, ['Crime']], ['Drama Show J', 2019, 9310, ['Drama']],
      ])),
      claude(message([{ title: 'Prestige Show', year: 2010 }, { title: 'Crime Show', year: 2011 }], { id: 'tu_prevalidate', usage: { input_tokens: 50, output_tokens: 20 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'concurrent requests share one Sonarr fetch',
    keys: [],
    upstream: [sonarr(tenOf('Show', 8100, MIXED))],
    steps: [get(TV, { concurrent: 2 })],
  },
  {
    name: 'genre distribution',
    upstream: [
      sonarr([
        ['Show A', ['Drama', 'Crime']], ['Show B', ['Drama', 'Crime']], ['Show C', ['Drama', 'Fantasy']], ['Show D', ['Drama']], ['Show E', ['Drama']],
        ['Show F', ['Drama', 'Crime']], ['Show G', ['Drama']], ['Show H', ['Drama', 'Fantasy']], ['Show I', ['Crime']], ['Show J', ['Drama']],
      ].map(([title, genres], i) => ({ title, year: 2010 + i, tmdbId: 7001 + i, genres }))),
    ],
    steps: [get(TV)],
  },
  {
    // One request body pins max_tokens, temperature, tool_choice, the tool,
    // the salt + rotation quota + genre hint, the TARGET GENRE MIX line, no
    // priority-taste/likes/recently-shown/pool blocks, and (second step) a
    // byte-identical library block for identical inputs.
    name: 'prompt shape with titled rejections',
    rejections: { tv: [{ id: 8001, title: 'Pokémon' }, { id: 8002, title: 'Delicious in Dungeon' }] },
    upstream: [sonarr(SONARR10)],
    steps: [get(TV), get(TV, { name: 'same inputs again', reset_library_cache: true })],
  },
  {
    name: 'untitled rejection falls back to an id bullet',
    rejections: { tv: [{ id: 8003, title: '' }, { id: 8004, title: 'Severance' }] },
    upstream: [sonarr(SONARR10)],
    steps: [get(TV)],
  },
  {
    name: 'rejection title backfill persists',
    rejections: { tv: [{ id: 8005, title: '' }] },
    upstream: [sonarr(SONARR10), tmdb('/tv/8005', { name: 'Squid Game' })],
    steps: [get(TV)],
  },
  {
    name: 'rejection backfill advances past unresolved ids',
    rejections: { tv: Array.from({ length: 11 }, (_, i) => ({ id: 8100 + i, title: '' })) },
    upstream: [sonarr(SONARR10), tmdb('/tv/8110', { name: 'Later Resolvable Show' }), json('GET', '/tmdb/3/tv/81', 404, {}, { prefix: true })],
    steps: [get(TV, { name: 'first ten are dead' }), get(TV, { name: 'next refresh reaches the eleventh' })],
  },
  {
    name: 'every pick filtered after the retry',
    upstream: [sonarr(SONARR10), tmdb('/search/tv', results([tvRow(1001, 'Sons of Anarchy', '2008-09-03')])), claude(message([{ title: 'Sons of Anarchy', year: 2008 }], { id: 'tu_1' }))],
    steps: [get(TV)],
  },
  {
    name: 'no tool_use block',
    upstream: [sonarr(SONARR10), claude(message(null, { text: true }))],
    steps: [get(TV)],
  },
  {
    name: 'priority taste block for a large library',
    upstream: [
      sonarr(Array.from({ length: 70 }, (_, i) => ({
        title: `Show ${i}`,
        year: 2010 + (i % 14),
        tmdbId: 7000 + i,
        genres: i % 3 === 0 ? ['Drama', 'Crime'] : i % 3 === 1 ? ['Drama'] : ['Sci-Fi & Fantasy', 'Action & Adventure'],
      }))),
    ],
    steps: [get(TV)],
  },
  {
    name: 'callCount 1 and cacheHitRate',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([tvRow(5_500_001, 'Clean Pick', '2021-01-01')])),
      claude(message([{ title: 'Clean Pick', year: 2021 }], { id: 'tu_callcount', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'user likes block, newest first',
    feedback: { alice: { tv: { liked: [{ id: 9001, title: 'Show Alpha' }, { id: 9002, title: 'Show Beta' }, { id: 9003, title: 'Show Gamma' }] } } },
    upstream: [sonarr(SONARR10)],
    steps: [get(TV)],
  },
  {
    name: 'reasons pass through',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([tvRow(7_700_001, 'Rectify', '2013-04-22')])),
      claude(message(Array.from({ length: 20 }, () => ({ title: 'Rectify', year: 2013, reason: 'neighbor of Sons of Anarchy — same prestige crime tone' })), { id: 'tu_reason', usage: { input_tokens: 50, output_tokens: 30 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'costCents',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([tvRow(7_800_001, 'Rectify', '2013-04-22')])),
      claude(message([{ title: 'Rectify', year: 2013 }], { id: 'tu_cost', usage: { input_tokens: 100, output_tokens: 60, cache_creation_input_tokens: 400 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'candidate pool block',
    upstream: [sonarr(SONARR10), tmdb('/discover/tv', results(Array.from({ length: 5 }, (_, i) => tvRow(9_800_000 + i, `Pool Show ${i + 1}`, '2023-01-01'))))],
    steps: [get(TV)],
  },
  {
    name: 'pool picks skip the search',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([tvRow(9_900_001, 'Pool Pick A', '2022-01-01')])),
      claude(message(Array.from({ length: 20 }, () => ({ title: 'Pool Pick A', year: 2022, reason: 'matches crime cluster' })), { id: 'tu_pool', usage: { input_tokens: 50, output_tokens: 30 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'duplicate pool titles fall back to the search',
    upstream: [
      radarr(RADARR_NOLAN),
      tmdb('/discover/movie', results([movieRow(9_910_001, 'Duplicate Title', '1986-01-01'), movieRow(9_910_002, 'Duplicate Title', '2002-01-01')])),
      tmdb('/search/movie', results([movieRow(9_910_003, 'Duplicate Title', '1995-01-01')])),
      claude(message([{ title: 'Duplicate Title', year: 1995 }], { id: 'tu_duplicate_pool_title', usage: { input_tokens: 50, output_tokens: 30 } })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'poolHitRate',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([tvRow(8_100_001, 'Pool Show Alpha', '2022-01-01'), tvRow(8_100_002, 'Pool Show Beta', '2021-01-01')])),
      claude(message([{ title: 'Pool Show Alpha', year: 2022, reason: 'similar to Sons of Anarchy' }, { title: 'Pool Show Beta', year: 2021, reason: 'crime cluster match' }], { id: 'tu_poolhitrate', usage: { input_tokens: 50, output_tokens: 20 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'pool drops library and rejected titles',
    rejections: { tv: [{ id: 9_800_005, title: 'Filtered Reject Show' }] },
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([tvRow(9_800_000, 'Safe Pool Show', '2022-01-01'), tvRow(1001, 'Sons of Anarchy', '2008-09-03'), tvRow(9_800_005, 'Filtered Reject Show', '2021-01-01')])),
    ],
    steps: [get(TV)],
  },
  {
    name: 'pool hit diag',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([tvRow(6_100_001, 'Pool Hit Show', '2022-01-01')])),
      claude(message(Array.from({ length: 20 }, () => ({ title: 'Pool Hit Show', year: 2022 })), { id: 'tu_hitrate' })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'droppedPicks',
    upstream: [sonarr(SONARR10), claude(message([{ title: 'Sons of Anarchy', year: 2008 }, { title: 'The Wire', year: 2002 }], { id: 'tu_dropped' }))],
    steps: [get(TV)],
  },
  {
    name: 'recentlyShownCount',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([tvRow(6_600_001, 'Fresh Show', '2022-01-01')])),
      claude(message([{ title: 'Fresh Show', year: 2022, reason: 'crime cluster' }], { id: 'tu_recent_count', usage: { input_tokens: 50, output_tokens: 20 } })),
    ],
    steps: [get(TV), get(TV, { name: 'second request', reset_library_cache: true })],
  },
  {
    name: 'droppedPicks accumulate across passes',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([tvRow(1001, 'Sons of Anarchy', '2008-01-01')])),
      claude(message([{ title: 'Sons of Anarchy', year: 2008 }, { title: 'House of the Dragon', year: 2022 }, { title: 'The Crown', year: 2016 }], { id: 'tu_pass1', usage: { input_tokens: 50, output_tokens: 30 } }), { times: 1 }),
      claude(message([{ title: 'Succession', year: 2018 }, { title: 'Better Call Saul', year: 2015 }], { id: 'tu_pass2', usage: { input_tokens: 50, output_tokens: 20 } }), { times: 1 }),
    ],
    steps: [get(TV)],
  },
  {
    name: 'novelty lane',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([tvRow(7_800_001, 'Recent Novelty Show', '2025-01-01')]), { query: { sort_by: 'first_air_date.desc' } }),
      tmdb('/discover/tv', results([tvRow(7_800_002, 'Quality Acclaimed Show', '2019-01-01'), tvRow(7_800_003, 'Future Show', '2999-01-01')]), { query: { sort_by: 'vote_average.desc' } }),
    ],
    steps: [get(TV)],
  },
  {
    name: 'pool dedupes ids across pages',
    upstream: [sonarr(SONARR10), tmdb('/discover/tv', results([tvRow(9_700_001, 'Dedup Show', '2022-01-01')]))],
    steps: [get(TV)],
  },
  {
    name: 'at most two Claude calls',
    upstream: [
      sonarr(tenOf('Series', 2000, MIXED)),
      tmdb('/search/tv', results([tvRow(2001, 'Series A', '2010-01-01')])),
      tmdb('/discover/tv', results([tvRow(9_900_001, 'Discover Fill', '2022-01-01')])),
      claude(message([{ title: 'Series A', year: 2010 }, { title: 'Series B', year: 2011 }, { title: 'Series C', year: 2012 }], { id: 'tu_all_library', usage: { input_tokens: 50, output_tokens: 30 } })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'movie year guard',
    upstream: [
      radarr(RADARR_HEAT),
      tmdb('/search/movie', results([movieRow(7777, 'Different Movie With Same Words', '1990-01-01')])),
      claude(message([{ title: 'Brand New Movie', year: 2020 }], { id: 'tu_1' })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'library cached across calls',
    upstream: [sonarr(SONARR10), claude(message([], { id: 'tu_a' }))],
    steps: [get(TV), get(TV, { name: 'second call, no Sonarr fetch' })],
  },
  {
    name: 'recently shown on the second call',
    upstream: [
      sonarr(SONARR10),
      tmdb('/search/tv', results([{ id: 9001, name: 'Severance', poster_path: '/p.jpg', first_air_date: '2022-02-18' }])),
      claude(message([{ title: 'Severance', year: 2022 }], { id: 'tu_first' })),
    ],
    steps: [get(TV), get(TV, { name: 'second call' })],
  },
  {
    name: 'recently shown capped to the pool',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results(Array.from({ length: 5 }, (_, i) => tvRow(8_800_000 + i, `Pool Item ${i + 1}`, '2022-01-01')))),
      ...[0, 1, 2].flatMap((b) =>
        Array.from({ length: 20 }, (_, i) => tmdb('/search/tv', results([tvRow(8_900_000 + b * 100 + i, `Show Batch${b} Item${i}`, '2022-01-01')]), { query: { query: `Show Batch${b} Item${i}` } })),
      ),
      ...[0, 1, 2].map((b) => claude(message(Array.from({ length: 20 }, (_, i) => ({ title: `Show Batch${b} Item${i}`, year: 2020 + b })), { id: `tu_${b}`, usage: { input_tokens: 50, output_tokens: 30 } }), { times: 1 })),
    ],
    steps: [0, 1, 2, 3].map((n) => get(TV, { name: `request ${n + 1}`, reset_library_cache: n > 0 })),
  },
  {
    name: 'discover fill before trending',
    upstream: [
      sonarr(SONARR10),
      tmdb('/discover/tv', results([{ id: 5555, name: 'Discover Drama Pick', poster_path: '/p.jpg', first_air_date: '2021-05-01' }])),
      tmdb('/trending/tv/week', results([tvRow(6666, 'Trending Tail', '2024-01-01')]), { query: { page: '1' } }),
      claude(message([{ title: 'Some Title That Won’t Resolve', year: 2024 }], { id: 'tu_zero' })),
    ],
    steps: [get(TV)],
  },
  {
    name: 'tmdb 429 retried once',
    upstream: [
      radarr(lib([
        ['Movie A', 2020, 901, ['Drama']], ['Movie B', 2019, 902, ['Drama']], ['Movie C', 2018, 903, ['Crime']], ['Movie D', 2021, 904, ['Drama']], ['Movie E', 2017, 905, ['Crime']],
        ['Movie F', 2016, 906, ['Drama']], ['Movie G', 2015, 907, ['Thriller']], ['Movie H', 2014, 908, ['Drama']], ['Movie I', 2013, 909, ['Crime']], ['Movie J', 2012, 910, ['Drama']],
      ])),
      json('GET', '/tmdb/3/discover/movie', 429, '', { times: 1, ct: 'text/plain', headers: { 'retry-after': '0' } }),
      tmdb('/discover/movie', results([movieRow(8001, 'Pool Pick', '2022-01-01')])),
      claude(message([], { id: 'tu_429retry' })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'franchise base form blocks a sequel',
    upstream: [
      radarr(RADARR_FRANCHISE),
      tmdb('/search/movie', results([movieRow(181808, 'Star Wars: The Force Awakens', '2015-12-14')])),
      claude(message([{ title: 'Star Wars: The Force Awakens', year: 2015 }], { id: 'tu_franchise' })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'a short base form does not block',
    upstream: [
      radarr(RADARR_FRANCHISE),
      tmdb('/search/movie', results([movieRow(406997, 'It Comes at Night', '2017-06-09')])),
      claude(message(Array.from({ length: 20 }, (_, i) => (i === 0 ? { title: 'It Comes at Night', year: 2017 } : { title: `Filler ${i}`, year: 2010 + i })), { id: 'tu_shortbase' })),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'recently shown records the final items',
    upstream: [
      sonarr(TV_CRIME),
      tmdb('/search/tv', results([tvRow(7_700_001, 'Clean Show A', '2021-01-01')]), { query: { query: 'Clean Show A' } }),
      tmdb('/search/tv', results([tvRow(7_700_002, 'Clean Show B', '2022-01-01')]), { query: { query: 'Clean Show B' } }),
      claude(message([{ title: 'Clean Show A', year: 2021, reason: 'neighbor of Peaky Blinders' }], { id: 'tu_req1', usage: { input_tokens: 50, output_tokens: 20 } }), { times: 1 }),
      claude(message([{ title: 'Clean Show B', year: 2022, reason: 'neighbor of Ozark' }], { id: 'tu_req2', usage: { input_tokens: 50, output_tokens: 20 } })),
    ],
    steps: [get(TV), get(TV, { name: 'second request', reset_library_cache: true })],
  },
  {
    // The named cold/warm pair: the second request is served from the
    // library, pool and lookup caches and carries a RECENTLY SHOWN block.
    name: 'claude path cold then warm',
    keys: ['alice', 'bob'],
    rejections: { movie: [{ id: 2999, title: 'Vetoed Film' }] },
    feedback: { alice: { movie: { liked: [{ id: 2002, title: 'Inception' }, { id: 3100, title: '' }] } } },
    upstream: [
      radarr(RADARR_NOLAN),
      tmdb('/movie/3100', { title: 'Memento' }),
      tmdb('/discover/movie', results([movieRow(3001, 'Blade Runner 2049', '2017-10-06'), movieRow(3002, 'Gone Girl', '2014-10-03'), movieRow(2999, 'Vetoed Film', '2012-01-01'), movieRow(3003, 'Mystic River', '2003-10-15')])),
      tmdb('/search/movie', results([movieRow(3004, 'Enemy', '2013-09-08')]), { query: { query: 'Enemy' } }),
      tmdb('/search/movie', results([movieRow(3005, 'The Prestige', '2006-10-20')]), { query: { query: 'The Prestige' } }),
      claude(message([
        { title: 'Blade Runner 2049', year: 2017, reason: 'neighbor of Arrival' },
        { title: 'Enemy', year: 2013, reason: 'same director as Prisoners' },
        { title: 'Zodiac', year: 2007 },
        { title: 'The Prestige', year: 2006, reason: '   for fans of Inception   ' },
        { title: 'Gone Girl', reason: 'neighbor of Zodiac' },
      ], { id: 'tu_cold', usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 1200 } }), { times: 1 }),
      claude(message([{ title: 'Mystic River', year: 2003 }], { id: 'tu_cold_retry', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1200 } }), { times: 1 }),
      claude(message([{ title: 'Gone Girl', year: 2014 }, { title: 'Enemy', year: 2013 }], { id: 'tu_warm', usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 1200 } })),
      iptvLinks([3002]),
    ],
    steps: [get(MOVIE, { name: 'cold' }), get(MOVIE, { name: 'warm' }), get(MOVIE, { name: "bob's own key", as: 'bob' })],
  },
  {
    name: 'stored keys only',
    keys: ['bob'],
    upstream: [radarr(Array.from({ length: 11 }, (_, i) => ({ title: `Stored Key Lib ${i}`, year: 2010 + i, tmdbId: 7100 + i, genres: ['Drama'] })))],
    steps: [get(MOVIE, { name: "alice has none: bob's is never used" }), get(MOVIE, { name: 'bob uses his stored key', as: 'bob' })],
  },

  // --- the recommender path ---
  {
    name: 'recommender honours force=trending',
    recommender: true,
    upstream: [radarr([]), tmdb('/trending/movie/week', results([{ id: 1001, title: 'Movie A', poster_path: '/a.jpg', overview: 'oA', release_date: '2024-01-01' }]), { query: { page: '1' } })],
    steps: [get(`${MOVIE}?force=trending`)],
  },
  {
    name: 'recommender down falls back to trending without postShown',
    recommender: true,
    upstream: [
      radarr([]),
      score('boom', 500),
      tmdb('/trending/movie/week', results([1, 2, 3].map((i) => ({ id: 1000 + i, title: `Movie ${'ABC'[i - 1]}`, poster_path: `/${'abc'[i - 1]}.jpg`, overview: `o${'ABC'[i - 1]}`, release_date: `2024-01-0${i}` }))), { query: { page: '1' } }),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'recommender empty falls back to trending with postShown',
    recommender: true,
    upstream: [sonarr([]), score({ items: [], model_version: 'mv-1', recipe: 'fused', diag: { pool: 0 } }), tmdb('/trending/tv/week', results([tvRow(51, 'Trend One', '2024-01-01'), tvRow(52, 'Trend Two', '2024-02-01')]), { query: { page: '1' } }), iptvLinks([52])],
    steps: [get(TV)],
  },
  {
    name: 'recommender empty without tmdb',
    recommender: true,
    tmdb: 'none',
    upstream: [sonarr([]), score({ items: [], model_version: 'mv-1', recipe: 'fused', diag: {} })],
    steps: [get(TV)],
  },
  {
    name: 'recommender franchise filter and payload',
    recommender: true,
    rejections: { movie: [{ id: 5005, title: 'Vetoed' }] },
    feedback: { alice: { movie: { liked: [{ id: 6006, title: 'Loved' }], disliked: [{ id: 5005, title: 'Vetoed' }] } } },
    upstream: [
      radarr([
        { tmdbId: 9001, title: 'Batman: The Killing Joke', year: 2016 },
        { tmdbId: 9100, title: 'Inception', year: 2010 },
        { tmdbId: 0, title: 'Zero Id Film', year: 2001 },
        { tmdbId: 9200 },
      ]),
      score({
        items: [
          { tmdb_id: 9002, title: 'Batman: Bad Blood', year: 2016, provenance: 'personalized', score: 0.71, reason: 'because you own Batman', poster_path: '/bb.jpg', overview: 'o' },
          { tmdb_id: 9003, title: 'Inception', year: 2010, provenance: 'personalized', score: 0.7 },
          { tmdb_id: 9001, title: 'Batman: The Killing Joke', year: 2016, provenance: 'personalized', score: 0.69 },
          { tmdb_id: 9005, title: 'A Completely Fresh Film', year: 2024, provenance: 'exploration', score: 0.68, overview: null, poster_path: null },
          { tmdb_id: 9006, title: null, provenance: 'personalized', score: 0.5 },
        ],
        model_version: 'test-mv',
        recipe: 'fused',
        diag: { candidates: 800 },
      }),
    ],
    steps: [get(MOVIE)],
  },
  {
    name: 'recommender local and iptv availability',
    recommender: true,
    upstream: [
      radarr([]),
      score({
        items: [
          { tmdb_id: 7001, title: 'Owned On Disk', year: 2020, provenance: 'personalized', score: 0.9 },
          { tmdb_id: 7002, title: 'Streaming Only', year: 2023, provenance: 'personalized', score: 0.8 },
          { tmdb_id: 7003, title: 'The Title Match', year: 1999, provenance: 'personalized', score: 0.7 },
          { tmdb_id: 7004, title: 'Title Match', year: 2000, provenance: 'personalized', score: 0.6 },
          { tmdb_id: 7005, title: 'Up', year: 2009, provenance: 'personalized', score: 0.5 },
        ],
        model_version: 'test-mv',
        recipe: 'fused',
        diag: {},
      }),
      iptvLinks([7001, 7002]),
    ],
    steps: [get(MOVIE)],
  },
]

// media.db rows for the local-availability scenario (media-core's schema).
const MEDIA_DB = {
  movies: [
    { tmdb_id: 7001, title: 'Owned On Disk', year: 2020 },
    { tmdb_id: null, title: 'Title Match', year: 1999 },
    { tmdb_id: null, title: 'Up', year: 2009 },
  ],
  shows: [{ tmdb_id: 52, title: 'Trend Two', year: 2024 }],
}
const MEDIA_SCHEMA = `
  CREATE TABLE movies (id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, title TEXT NOT NULL, year INTEGER);
  CREATE TABLE shows (id INTEGER PRIMARY KEY AUTOINCREMENT, tmdb_id INTEGER UNIQUE, title TEXT NOT NULL, year INTEGER);
`

// --- the fake ---------------------------------------------------------------------------

type Call = { method: string; path: string; query: string; body: unknown; key: string | null; authorization: string | null; secret: string | null }
const calls: Call[] = []
let routes: Route[] = []
let left: Array<number | undefined> = []
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const method = req.method ?? ''
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const h = (k: string) => (req.headers[k] as string | undefined) ?? null
    calls.push({ method, path: url.pathname, query: url.search.replace(/^\?/, ''), body, key: h('x-api-key'), authorization: h('authorization'), secret: h('x-recommender-secret') })
    const i = routes.findIndex(
      (rt, n) =>
        left[n] !== 0 &&
        rt.method === method &&
        (rt.prefix ? url.pathname.startsWith(rt.path) : rt.path === url.pathname) &&
        Object.entries(rt.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v),
    )
    if (i < 0) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end('{"error":"no fixture"}')
    }
    if (left[i] !== undefined) left[i]! -= 1
    const hit = routes[i]!
    if (hit.delay_ms) await new Promise((ok) => realSetTimeout(ok, hit.delay_ms))
    res.writeHead(hit.status, { 'content-type': hit.ct, ...(hit.headers ?? {}) })
    res.end(hit.text)
  })
})
const realSetTimeout = globalThis.setTimeout
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

/** Wait out requests still in flight (no new call for 150 ms). */
async function quiet(): Promise<void> {
  let seen = -1
  while (calls.length !== seen) {
    seen = calls.length
    await new Promise((ok) => realSetTimeout(ok, 150))
  }
}

// --- env, the TS app --------------------------------------------------------------------

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-goldens-')))
const mediaDb = path.join(dir, 'media.db')
{
  const db = new Database(mediaDb)
  db.exec(MEDIA_SCHEMA)
  for (const t of ['movies', 'shows'] as const) {
    for (const r of MEDIA_DB[t]) db.prepare(`INSERT INTO ${t} (tmdb_id, title, year) VALUES (?, ?, ?)`).run(r.tmdb_id, r.title, r.year)
  }
  db.close()
}
Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  USER_POLICIES_PATH: path.join(dir, 'policies.json'),
  USER_WATCHLIST_PATH: path.join(dir, 'watchlist.json'),
  SONARR_URL: `${fakeUrl}/sonarr`,
  RADARR_URL: `${fakeUrl}/radarr`,
  RECOMMENDER_URL: `${fakeUrl}/rec`,
  IPTV_SERVICE_URL: `${fakeUrl}/iptv`,
  MEDIA_DB_PATH: mediaDb,
})
delete process.env.NODE_ENV
delete process.env.TMDB_API_KEY
delete process.env.TMDB_READ_ACCESS_TOKEN
process.chdir(dir)

const BASES: Array<[string, string]> = [
  ['https://api.themoviedb.org/3', `${fakeUrl}/tmdb/3`],
  ['https://api.anthropic.com', `${fakeUrl}/anthropic`],
]
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : null
  let url = String(req ? req.url : input)
  for (const [from, to] of BASES) if (url.startsWith(from)) url = to + url.slice(from.length)
  if (!url.startsWith(fakeUrl)) throw new Error(`gen-suggestions-goldens: no network (${url})`)
  return req ? realFetch(new Request(url, req), init) : realFetch(url, init)
}) as typeof fetch
// The 20 s Claude deadline and the SDK timeout run as 1.5 s (the replay's
// Timings): long enough for the SDK's own ~0.5 s 529 backoff.
globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) =>
  realSetTimeout(fn, ms === 20_000 ? 1_500 : ms, ...args)) as typeof setTimeout
const log = console.log
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const prompt = await import(path.join(server, 'services/suggestionsPrompt.js'))
const shown = await import(path.join(server, 'services/suggestionsRecentlyShown.js'))
const shared = await import(path.join(server, 'services/suggestionsShared.js'))
const stmdb = await import(path.join(server, 'services/suggestionsTmdb.js'))
const { app } = await import(path.join(server, 'app.js'))
const { createMemberSession } = await import(path.join(server, 'test/authFixture.js'))
const { serverDb } = await import(path.join(server, 'services/serverDb.js'))
const { env } = await import(path.join(server, 'env.js'))
const { setUserApiKey } = await import(path.join(server, 'services/userApiKeys.js'))
const sugg = await import(path.join(server, 'routes/suggestions.js'))
const { _setRejectionsPathForTests } = await import(path.join(server, 'services/rejections.js'))
const { _setUserFeedbackPathForTests } = await import(path.join(server, 'services/userFeedback.js'))
const { _setUsageLogPathForTests } = await import(path.join(server, 'services/usageLog.js'))
const cookies: Record<string, string> = {}
for (const [who, m] of Object.entries(MEMBERS)) {
  cookies[who] = `eex.session=${await createMemberSession({ sub: m.sub, username: m.username, role: m.role })}`
}

// --- prompt goldens ---------------------------------------------------------------------

const P_LIB: Lib[] = [
  { title: 'Sons of Anarchy', year: 2008, genres: ['Crime', 'Drama'] },
  { title: 'Bad\u0000Title\nWith  \t breaks ', year: 0, genres: ['Drama', '', 'Ac\u0007tion', 'Thriller', 'Comedy'] },
  { title: 'Pokémon: Indigo — League', genres: [] },
  { title: 'x'.repeat(230), year: 1999 },
  { title: 'Emoji 🎬 Title', year: 2024, genres: ['Animation'] },
  { title: 'The Wire', year: 2002, genres: ['Crime', 'Drama'] },
]
const BIG = (n: number): Lib[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `Show ${i}`,
    year: 2000 + (i % 25),
    genres: i % 4 === 0 ? ['Drama', 'Crime'] : i % 4 === 1 ? ['Drama'] : i % 4 === 2 ? ['Comedy', 'Family', 'Animation'] : ['Crime'],
  }))
const REJ: Entry[] = [{ id: 1, title: 'Pokémon' }, { id: 2, title: '' }, { id: 3, title: 'Delicious in Dungeon' }, { id: 4, title: '' }]
const LIKES = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ id: 100 + i, title: i % 7 === 3 ? '' : `Liked ${i}` }))
const TITLES = [
  'The Dark Knight', 'A Knight of the Seven Kingdoms: The Hedge Knight', 'A Knight of the Seven Kingdoms', 'It: Chapter Two', 'Up: Special Edition',
  'Star Wars — The Force Awakens', 'Mission: Impossible – Fallout', 'Spider-Man - No Way Home', 'An American Werewolf in London', 'the  OFFICE',
  'Pokémon', 'Amélie', '', ':', 'Batman: Bad Blood', 'Thea', 'A', 'The',
]
const prompts = {
  genre_distribution: [P_LIB, BIG(70), [], [{ genres: ['', ''] }]].flatMap((l) => [5, 6].map((n) => ({ library: l, n, out: prompt.computeGenreDistribution(l, n) }))),
  library_block: [
    { kind: 'tv', library: P_LIB, rejections: [] },
    { kind: 'movie', library: P_LIB, rejections: REJ },
    { kind: 'tv', library: [], rejections: [{ id: 9, title: '' }] },
    { kind: 'movie', library: BIG(12), rejections: REJ.slice(0, 1) },
  ].map((c) => ({ ...c, out: prompt.buildLibraryBlock(c.kind, c.library, c.rejections) })),
  likes_block: [[], LIKES(4), LIKES(505)].map((liked) => ({ liked, out: prompt.buildUserLikesBlock(liked) })),
  priority_block: [P_LIB, BIG(59), BIG(60), BIG(83)].map((library) => ({ library, out: prompt.buildPriorityTasteBlock(library) })),
  pool_block: [[], [{ id: 1, title: 'Pool A', year: 2020 }, { id: 2, title: 'Pool B' }, { id: 3, title: 'Pool: C', year: 0 }]].map((candidates) => ({
    candidates: candidates.map((c) => ({ posterPath: null, ...c })),
    out: prompt.buildCandidatePoolBlock(candidates.map((c) => ({ posterPath: null, ...c }))),
  })),
  recently_shown_block: [[], [{ id: 1, title: 'Seen A' }, { id: 2, title: 'Seen — B' }]].map((items) => ({ items, out: shown.buildRecentlyShownBlock(items) })),
  titles: TITLES.map((t) => ({ title: t, normalized: shared.normalizeTitle(t), base: shared.normalizeTitleBase(t) })),
  title_matches: [
    { set: ['Star Wars: A New Hope', 'It: Chapter Two', 'Heat'], base: true },
    { set: ['Avatar: The Last Airbender', 'Heat'], base: false },
  ].flatMap((s) => {
    const set = shared.titleSetFrom(s.set.map((title) => ({ title })), { includeBase: s.base })
    return TITLES.concat(['Star Wars: The Force Awakens', 'It Comes at Night', 'Avatar: The Way of Water', 'heat']).map((pick) => ({
      set: s.set,
      include_base: s.base,
      pick,
      out: shared.titleMatches(pick, set),
    }))
  }),
  top_genres: [P_LIB, BIG(70), [{ genres: ['B', 'A', 'B', 'A', 'C'] }, { genres: ['C'] }]].map((l) => ({ library: l, out: stmdb.topGenreNames(l, 5) })),
  genre_ids: (['movie', 'tv'] as const).flatMap((kind) =>
    [['Drama', 'crime', ' Sci-Fi ', 'Sci-Fi & Fantasy', 'Unknown', 'Action', 'Action & Adventure', 'Kids', 'Biography', 'Sport', 'Reality']].map((names) => ({ kind, names, out: stmdb.genreNamesToTmdbIds(kind, names) })),
  ),
}

// --- route goldens ----------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10)
const SALT = /\[Request salt: [0-9a-f]{16}\]/g
const normText = (s: string) => s.split(fakeUrl).join('{FAKE}').split(today).join('<today>')
function normAnthropic(body: unknown): unknown {
  const b = JSON.parse(JSON.stringify(body)) as { system?: Array<{ text: string }>; messages?: Array<{ content: unknown }> }
  for (const block of b.system ?? []) {
    if (block.text.startsWith('CANDIDATE POOL')) {
      const [head, list] = block.text.split('\n\n')
      block.text = `${head}\n\n${(list ?? '').split('\n').map((l) => l.replace(/^\d+\. /, '')).sort().join('\n')}`
    }
  }
  for (const m of b.messages ?? []) if (typeof m.content === 'string') m.content = m.content.replace(SALT, '[Request salt: <salt>]')
  return b
}
const normCall = (c: Call) => ({
  ...c,
  query: normText(c.query),
  body: c.path.startsWith('/anthropic') ? normAnthropic(c.body) : c.body,
  authorization: c.authorization?.startsWith('Bearer ey') ? 'Bearer <principal>' : c.authorization,
})
const usagePath = () => path.join(dir, 'usage.jsonl')
let usageSeen = 0
const takeUsage = () => {
  const lines = fs.existsSync(usagePath()) ? fs.readFileSync(usagePath(), 'utf8').split('\n').filter(Boolean) : []
  const fresh = lines.slice(usageSeen)
  usageSeen = lines.length
  return fresh.map((l) => {
    const { ts, ...rest } = JSON.parse(l) as { ts: string }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts)) throw new Error(`bad usage ts ${ts}`)
    return rest
  })
}
const readStore = (f: string) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null)
const timingNames = (h: string | null) => (h ? h.split(', ').map((e) => e.split(';')[0]) : null)

const out = []
for (const sc of SCENARIOS) {
  for (const f of ['rejections.json', 'feedback.json', 'usage.jsonl']) fs.rmSync(path.join(dir, f), { force: true })
  usageSeen = 0
  if (sc.rejections) fs.writeFileSync(path.join(dir, 'rejections.json'), JSON.stringify({ movie: sc.rejections.movie ?? [], tv: sc.rejections.tv ?? [] }, null, 2) + '\n')
  if (sc.feedback) {
    const file = Object.fromEntries(Object.entries(sc.feedback).map(([who, f]) => [MEMBERS[who as Who].sub, f]))
    fs.writeFileSync(path.join(dir, 'feedback.json'), JSON.stringify(file, null, 2) + '\n')
  }
  _setRejectionsPathForTests(path.join(dir, 'rejections.json'))
  _setUserFeedbackPathForTests(path.join(dir, 'feedback.json'))
  _setUsageLogPathForTests(usagePath())
  serverDb().raw.exec('DELETE FROM user_api_keys')
  for (const who of sc.keys ?? ['alice']) setUserApiKey(MEMBERS[who].sub, ANTHROPIC.replace('0001', who))
  const tmdbMode = sc.tmdb ?? 'key'
  stmdb._setTmdbApiKeyForTests(tmdbMode === 'none' ? null : tmdbMode === 'token' ? TMDB_TOKEN : TMDB_KEY, tmdbMode === 'token' ? 'bearer' : 'query')
  sugg._resetLibraryCacheForTests()
  sugg._resetLibraryStaleFallbackForTests()
  sugg._resetRecentlyShownForTests()
  sugg._resetTmdbInFlightForTests()
  env.useLocalRecommender = sc.recommender === true
  routes = [...sc.upstream, ...DEFAULTS]
  left = routes.map((r) => r.times)
  calls.length = 0

  const steps = []
  for (const st of sc.steps) {
    if (st.reset_library_cache) sugg._resetLibraryCacheForTests()
    const headers: Record<string, string> = {}
    if (st.as) headers.Cookie = cookies[st.as]!
    if (st.origin) headers.Origin = st.origin
    const n = st.concurrent ?? 1
    const ress: Response[] = await Promise.all(Array.from({ length: n }, () => app.request(new Request(`http://localhost${st.path}`, { headers }))))
    const replies = []
    for (const res of ress) replies.push({ status: res.status, content_type: res.headers.get('content-type'), server_timing: timingNames(res.headers.get('server-timing')), body: normText(await res.text()) })
    await quiet()
    steps.push({
      ...st,
      replies,
      calls: calls.splice(0, calls.length).map(normCall),
      usage: takeUsage(),
      stores: { rejections: readStore('rejections.json'), feedback: readStore('feedback.json') },
    })
  }
  out.push({ ...sc, upstream: routes, steps })
}

console.log = log
fake.close()
fs.writeFileSync(
  path.join(here, 'suggestions-goldens.json'),
  JSON.stringify(
    { env: ENV, tmdb_key: TMDB_KEY, tmdb_token: TMDB_TOKEN, anthropic_key: ANTHROPIC, members: MEMBERS, media_db: MEDIA_DB, prompts, scenarios: out },
    null,
    1,
  ) + '\n',
)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
