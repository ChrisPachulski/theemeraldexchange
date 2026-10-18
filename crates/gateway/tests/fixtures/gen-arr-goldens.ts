// Writes arr-goldens.json from the untouched TS app (server/app.ts): the
// /api/radarr, /api/sab and /api/grabs routes, scenario by scenario, against
// one local fake that serves Radarr (/radarr), SAB (/sab) and the
// recommender (/rec) from each scenario's fixture routes and records every
// request it gets. Per step it keeps the status, Content-Type, Retry-After,
// the body, the ordered upstream requests (method, path, raw query, body,
// X-Api-Key, recommender secret, Bearer presence) and the grabs.jsonl lines
// the step appended. src/arr/goldens.rs replays the same scenarios through
// gateway::router against the Rust copy of the fake.
//
// Each scenario starts clean: rate-limit buckets reset, a fresh grabs.jsonl
// (optionally seeded), its env overrides applied. Per-run values are
// normalized on both sides: a grab-log "ts" becomes <ts>, a 429's
// retry_after_ms becomes <ms>.
//
// No network: globalThis.fetch reaches only the fake on 127.0.0.1.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-arr-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

const ENV: Record<string, string> = {
  SESSION_SECRET: 'arr-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'arr-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'arr-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'arr-goldens-internal-principal-placeholder-zzz',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  RADARR_API_KEY: 'placeholder-radarr-key',
  SAB_API_KEY: 'placeholder-sab-key',
  MIN_FREE_GB: '100',
  MAX_MOVIE_SIZE_GB: '10',
  USE_LOCAL_RECOMMENDER: '1',
  RECOMMENDER_EVENT_SECRET: 'arr-goldens-recommender-secret',
}
const MEMBERS = {
  admin: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'admin', role: 'admin' },
  alice: { sub: 'apple:000001.0123456789abcdef0123456789abcdef.0001', username: 'alice', role: 'user' },
  kid: { sub: 'google:1234567890', username: 'kid', role: 'user' },
} as const
type Who = keyof typeof MEMBERS
// The kid may browse but neither manage the *arrs nor see downloads.
const POLICIES = JSON.stringify(
  { [MEMBERS.kid.sub]: { allowedSections: { live: true, downloads: false, arr: false } } },
  null,
  2,
) + '\n'

const GB = 1024 ** 3
type Route = { method: string; path: string; query?: Record<string, string>; status: number; text: string; ct: string }
const at = (prefix: string) => (method: string, p: string, status: number, body: unknown, opts: { query?: Record<string, string>; ct?: string } = {}): Route => ({
  method,
  path: prefix + p,
  ...(opts.query ? { query: opts.query } : {}),
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  ct: opts.ct ?? (typeof body === 'string' ? 'text/plain' : 'application/json'),
})
const r = at('/radarr')
const s = at('/sab')

type Step = {
  name: string
  as?: Who
  method?: string
  path: string
  body?: unknown
  /** Sent verbatim instead of JSON.stringify(body). */
  raw?: string
  /** Send this many times; the last response is kept, every status listed. */
  repeat?: number
}
type Scenario = {
  name: string
  env?: Record<string, string>
  upstream: Route[]
  grabs_seed?: string
  steps: Step[]
}

const rootfolder = (free: number, p = '/data/movies') => r('GET', '/api/v3/rootfolder', 200, [{ id: 1, path: p, freeSpace: free }])
const profiles = (list: unknown[]) => r('GET', '/api/v3/qualityprofile', 200, list)
const created = (body: unknown, status = 201) => r('POST', '/api/v3/movie', status, body)
const releases = (id: number, list: unknown, status = 200) => r('GET', '/api/v3/release', status, list, { query: { movieId: String(id) } })
const grabPost = (status = 200, body: unknown = { ok: true }) => r('POST', '/api/v3/release', status, body)
const rel = (guid: string, size: number, qualityWeight: number, title: string, extra: Record<string, unknown> = {}) => ({ guid, indexerId: 1, size, qualityWeight, title, ...extra })
const add = (as: Who, body: unknown, name = `${as} add`): Step => ({ name, as, method: 'POST', path: '/api/radarr/api/v3/movie', body })
const adminAdd = (title: string, tmdbId: number, extra: Record<string, unknown> = {}) =>
  add('admin', { title, tmdbId, rootFolderPath: '/data/movies', qualityProfileId: 7, monitored: true, addOptions: { searchForMovie: true }, ...extra }, `admin add ${title}`)
const get = (as: Who | undefined, p: string, name = `${as ?? 'anon'} GET ${p}`): Step => ({ name, as, path: p })
const send = (as: Who | undefined, method: string, p: string, body?: unknown, name = `${as ?? 'anon'} ${method} ${p}`): Step => ({ name, as, method, path: p, body })
const FREE = 500 * GB
const CHOOSE = [{ id: 7, name: 'Choose Me' }]

const SCENARIOS: Scenario[] = [
  // --- forwarded reads ---
  {
    name: 'radarr reads',
    upstream: [
      r('GET', '/api/v3/movie', 200, [{ id: 1, title: 'Test Movie' }]),
      r('GET', '/api/v3/queue', 200, { page: 1, pageSize: 200, totalRecords: 0, records: [] }),
      r('GET', '/api/v3/system/status', 200, { version: '5.0.0' }),
      profiles(CHOOSE),
      rootfolder(FREE),
      r('GET', '/api/v3/movie/lookup', 200, [{ title: 'Heat', tmdbId: 949 }]),
    ],
    steps: [
      get(undefined, '/api/radarr/api/v3/movie'),
      get('alice', '/api/radarr/api/v3/movie?tmdbId=5&x=a%20b+c'),
      get('alice', '/api/radarr/api/v3/queue?pageSize=200'),
      get('alice', '/api/radarr/api/v3/system/status'),
      get('admin', '/api/radarr/api/v3/qualityprofile'),
      get('alice', '/api/radarr/api/v3/rootfolder'),
      get('alice', '/api/radarr/api/v3/movie/lookup?term=the%20matrix&term=heat'),
      get('admin', '/api/radarr/api/v3/some-undeclared-path'),
      get('kid', '/api/radarr/api/v3/movie'),
    ],
  },
  {
    name: 'radarr read errors',
    upstream: [r('GET', '/api/v3/movie', 500, 'boom'), r('GET', '/api/v3/queue', 401, { error: 'bad key' })],
    steps: [get('alice', '/api/radarr/api/v3/movie'), get('alice', '/api/radarr/api/v3/queue')],
  },
  {
    name: 'radarr not configured',
    env: { 'RADARR_API_KEY': '' },
    upstream: [],
    steps: [
      get('alice', '/api/radarr/api/v3/movie'),
      add('admin', { rootFolderPath: '/data/movies', title: 'Foo' }, 'admin add with policy'),
      add('alice', { title: 'X', tmdbId: 1 }, 'alice slim add'),
    ],
  },

  // --- delete ---
  {
    name: 'radarr delete',
    upstream: [r('DELETE', '/api/v3/movie/42', 200, '')],
    steps: [
      send('alice', 'DELETE', '/api/radarr/api/v3/movie/42'),
      send('admin', 'DELETE', '/api/radarr/api/v3/movie/42?deleteFiles=true&addImportExclusion=false'),
      send('admin', 'DELETE', '/api/radarr/api/v3/movie/..%2Frootfolder%2F1'),
      send('admin', 'DELETE', '/api/radarr/api/v3/movie/abc'),
      send('kid', 'DELETE', '/api/radarr/api/v3/movie/42'),
    ],
  },
  {
    name: 'radarr delete rate limit',
    upstream: [r('DELETE', '/api/v3/movie/42', 200, '')],
    steps: [{ ...send('admin', 'DELETE', '/api/radarr/api/v3/movie/42'), repeat: 13 }],
  },

  // --- the add: gates and policy ---
  {
    name: 'add 507 below the floor',
    upstream: [rootfolder(25 * GB)],
    steps: [add('admin', { rootFolderPath: '/data/movies', title: 'Foo' })],
  },
  {
    name: 'add grab_succeeded',
    upstream: [rootfolder(FREE), created({ id: 99, title: 'Foo' }), releases(99, [rel('g-99', 2 * GB, 100, 'Foo 1080p')]), grabPost()],
    steps: [add('admin', { rootFolderPath: '/data/movies', title: 'Foo', tmdbId: 99 })],
  },
  {
    name: 'admin slim body, upstream unreachable',
    upstream: [],
    steps: [add('admin', { title: 'No root folder' })],
  },
  {
    name: 'admin add unknown root folder',
    upstream: [rootfolder(FREE)],
    steps: [add('admin', { title: 'X', rootFolderPath: '/data/different' })],
  },
  {
    name: 'admin add free space unknown',
    upstream: [r('GET', '/api/v3/rootfolder', 200, [{ id: 1, path: '/data/movies' }])],
    steps: [add('admin', { title: 'X', rootFolderPath: '/data/movies' })],
  },
  {
    name: 'admin add rootfolder unreachable',
    upstream: [r('GET', '/api/v3/rootfolder', 500, 'down')],
    steps: [add('admin', { title: 'X', rootFolderPath: '/data/movies' })],
  },
  {
    name: 'honoured member picks',
    upstream: [
      r('GET', '/api/v3/rootfolder', 200, [
        { id: 1, path: '/data/movies', freeSpace: FREE },
        { id: 2, path: '/data/movies-mirror', freeSpace: FREE },
      ]),
      profiles([{ id: 7, name: 'Choose Me' }, { id: 8, name: 'Any' }]),
      created({ id: 999, title: 'Hostile' }),
      releases(999, [rel('release-999', 2 * GB, 100, 'Hostile 1080p')]),
      grabPost(),
    ],
    steps: [
      add('alice', {
        title: 'Hostile',
        tmdbId: 42,
        rootFolderPath: '/data/movies-mirror',
        qualityProfileId: 8,
        monitored: false,
        tags: [99],
        minimumAvailability: 'tba',
        addOptions: { searchForMovie: true, monitor: 'movieOnly' },
      }),
      add('alice', { title: 'X', tmdbId: 7, rootFolderPath: '/etc/passwd', qualityProfileId: 7 }, 'unknown folder'),
      add('alice', { title: 'X', tmdbId: 7, rootFolderPath: '/data/movies', qualityProfileId: 3 }, 'unknown profile'),
      add('alice', { title: 'Hostile', tmdbId: 42, rootFolderPath: '', addOptions: { searchForMovie: false } }, 'blank folder takes the default'),
    ],
  },
  {
    name: 'member slim body prefers Choose Me',
    upstream: [
      rootfolder(FREE),
      profiles([{ id: 1, name: 'Any' }, { id: 7, name: 'Choose Me' }, { id: 8, name: 'HD - 1080p' }]),
      created({ id: 999, title: 'X' }),
      releases(999, [rel('g-999', 2 * GB, 100, 'X 1080p')]),
      grabPost(),
    ],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'admin must configure upstream',
    upstream: [r('GET', '/api/v3/rootfolder', 200, []), profiles([])],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'default root folder missing',
    env: { DEFAULT_RADARR_ROOT_FOLDER_PATH: '/data/configured' },
    upstream: [rootfolder(FREE, '/data/other'), profiles(CHOOSE)],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'default quality profile missing',
    upstream: [rootfolder(FREE), profiles([])],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'quality profile unreachable',
    upstream: [rootfolder(FREE), r('GET', '/api/v3/qualityprofile', 500, 'down')],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'admin slim body materializes',
    upstream: [
      rootfolder(FREE),
      profiles(CHOOSE),
      created({ id: 1234, title: 'Jurassic World' }),
      releases(1234, [rel('rel-1234', 2 * GB, 100, 'Jurassic World 1080p')]),
      grabPost(),
    ],
    steps: [add('admin', { tmdbId: 135397, title: 'Jurassic World', year: 2015 })],
  },
  {
    name: 'just monitor keeps monitored, no grab',
    upstream: [rootfolder(FREE), created({ id: 5, title: 'Foo' })],
    steps: [add('admin', { rootFolderPath: '/data/movies', title: 'Foo', tmdbId: 5, monitored: true, addOptions: { searchForMovie: false } })],
  },
  {
    name: 'search adds rewrite the body (add_unverified after)',
    upstream: [rootfolder(FREE), created({ id: 0, title: 'Foo' })],
    steps: [
      add('admin', { rootFolderPath: '/data/movies', title: 'Foo', monitored: true, addOptions: { searchForMovie: true } }, 'start search now'),
      add('admin', { rootFolderPath: '/data/movies', title: 'Foo' }, 'no addOptions'),
    ],
  },

  // --- the add: capped-grab outcomes ---
  {
    name: 'no_releases keeps the movie monitored',
    upstream: [
      rootfolder(FREE),
      created({ id: 803, title: 'Pressure', monitored: false }),
      releases(803, []),
      r('PUT', '/api/v3/movie/803', 200, { id: 803, monitored: true }),
      r('DELETE', '/api/v3/movie/803', 200, ''),
    ],
    steps: [adminAdd('Pressure', 803)],
  },
  {
    name: 'no_matching_releases keeps the movie monitored',
    upstream: [
      rootfolder(FREE),
      created({ id: 830, title: 'Far Far Away Idol', monitored: false }),
      releases(830, [
        rel('g1', Math.round(0.12 * GB), 100, 'Far.Far.Away.Idol.NF.WEB-DL.1080p', { rejected: true }),
        rel('g2', Math.round(0.12 * GB), 90, 'Far.Far.Away.Idol', { rejected: true }),
        rel('g3', Math.round(0.12 * GB), 80, 'Far.Far.Away.Idol', { temporarilyRejected: true }),
      ]),
      r('PUT', '/api/v3/movie/830', 200, { id: 830, monitored: true }),
    ],
    steps: [adminAdd('Far Far Away Idol', 58508)],
  },
  {
    name: 'monitor_enable_failed',
    upstream: [
      rootfolder(FREE),
      created({ id: 831, title: 'Needs Monitor', monitored: false }),
      releases(831, [rel('g1', Math.round(0.12 * GB), 100, 'Needs.Monitor.1080p', { rejected: true })]),
      r('PUT', '/api/v3/movie/831', 500, { error: 'upstream failed' }),
    ],
    steps: [adminAdd('Needs Monitor', 58509)],
  },
  {
    name: 'all_rejected_by_cap rolls back',
    upstream: [
      rootfolder(5000 * GB),
      created({ id: 901, title: 'Over Cap', monitored: false }),
      releases(901, [rel('g', 999 * GB, 100, '4K')]),
      r('DELETE', '/api/v3/movie/901', 200, ''),
    ],
    steps: [adminAdd('Over Cap', 901)],
  },
  {
    name: 'all_rejected_by_cap with a failed rollback',
    upstream: [
      rootfolder(FREE),
      created({ id: 902, title: 'Over Cap 2' }),
      releases(902, [rel('g', 50 * GB, 100, '4K'), rel('h', 11 * GB, 90, '1080p remux')]),
      r('DELETE', '/api/v3/movie/902', 500, { error: 'nope' }),
    ],
    steps: [adminAdd('Over Cap 2', 902)],
  },
  {
    name: 'search_failed rolls back',
    upstream: [rootfolder(FREE), created({ id: 903, title: 'Search Down' }), releases(903, { error: 'indexers down' }, 503), r('DELETE', '/api/v3/movie/903', 200, '')],
    steps: [adminAdd('Search Down', 903)],
  },
  {
    name: 'grab_failed rolls back',
    upstream: [
      rootfolder(FREE),
      created({ id: 904, title: 'Grab Down' }),
      releases(904, [rel('a', 3 * GB, 80, 'okay'), rel('b', 4 * GB, 120, 'best'), rel('c', 1 * GB, 120, 'tie later')]),
      grabPost(500, { error: 'grab failed' }),
      r('DELETE', '/api/v3/movie/904', 404, { error: 'gone' }),
    ],
    steps: [adminAdd('Grab Down', 904)],
  },
  {
    name: 'grab_unconfirmed keeps the movie monitored',
    upstream: [
      rootfolder(FREE),
      created({ id: 905, title: 'Slow Grab' }),
      releases(905, [rel('a', 3 * GB, 80, 'okay')]),
      grabPost(504, { error: 'upstream_timeout' }),
      r('PUT', '/api/v3/movie/905', 200, { id: 905, monitored: true }),
    ],
    steps: [adminAdd('Slow Grab', 905)],
  },
  {
    name: 'unusable 201 recovered by tmdbId',
    upstream: [
      rootfolder(FREE),
      created('<html>gateway said ok</html>', 201),
      r('GET', '/api/v3/movie', 200, [{ id: 777, title: 'Recovered Movie', monitored: false }], { query: { tmdbId: '777' } }),
      releases(777, [rel('g-777', 2 * GB, 100, 'Recovered 1080p')]),
      grabPost(),
    ],
    steps: [adminAdd('Recovered Movie', 777)],
  },
  {
    name: 'add_unverified when recovery finds nothing',
    upstream: [rootfolder(FREE), created('not-json', 201), r('GET', '/api/v3/movie', 200, [], { query: { tmdbId: '778' } }), grabPost()],
    steps: [adminAdd('Ghost Movie', 778)],
  },
  {
    name: 'add_unverified rolls back an untitled movie',
    upstream: [
      rootfolder(FREE),
      created({ id: 779 }),
      r('GET', '/api/v3/movie', 500, '{}', { query: { tmdbId: '779' } }),
      r('DELETE', '/api/v3/movie/779', 200, ''),
    ],
    steps: [adminAdd('Untitled Echo', 779)],
  },
  {
    name: 'add_unverified with a failed rollback',
    upstream: [rootfolder(FREE), created({ id: 780, title: '  ' }), r('GET', '/api/v3/movie', 200, [], { query: { tmdbId: '780' } }), r('DELETE', '/api/v3/movie/780', 500, 'no')],
    steps: [adminAdd('Blank Title', 780)],
  },
  {
    name: 'add_unverified when the recovered record is untitled',
    upstream: [rootfolder(FREE), created('x', 201), r('GET', '/api/v3/movie', 200, [{ id: 781 }], { query: { tmdbId: '781' } }), r('DELETE', '/api/v3/movie/781', 200, '')],
    steps: [adminAdd('Untitled Refetch', 781)],
  },
  {
    name: 'add refused upstream is relayed',
    upstream: [rootfolder(FREE), created([{ errorMessage: 'This movie has already been added' }], 400)],
    steps: [adminAdd('Dupe', 950)],
  },
  {
    name: 'add with an unusable body',
    upstream: [],
    steps: [
      { name: 'array body', as: 'admin', method: 'POST', path: '/api/radarr/api/v3/movie', raw: '[1,2]' },
      { name: 'non-json body', as: 'admin', method: 'POST', path: '/api/radarr/api/v3/movie', raw: 'nope' },
    ],
  },
  {
    name: 'admin path tolerance forwards the canonical path',
    upstream: [rootfolder(FREE, '/data/media/movies'), created({ id: 4242, title: 'Admin Add' })],
    steps: [
      adminAdd('Admin Add', 4242, { rootFolderPath: '/data/media/movies/', addOptions: { searchForMovie: false } }),
      adminAdd('Admin Add', 4242, { rootFolderPath: '/DATA/MEDIA/MOVIES', addOptions: { searchForMovie: false } }),
      adminAdd('Admin Add', 4242, { rootFolderPath: '/data/media/nope', addOptions: { searchForMovie: false } }),
    ],
  },
  {
    name: 'member path and profile-name tolerance',
    upstream: [
      rootfolder(FREE, '/data/media/movies/'),
      profiles([{ id: 7, name: 'Choose Me ' }]),
      created({ id: 999, title: 'X' }),
      releases(999, [rel('g-999', 2 * GB, 100, 'X 1080p')]),
      grabPost(),
    ],
    steps: [add('alice', { title: 'X', tmdbId: 1 })],
  },
  {
    name: 'section and admin gates',
    upstream: [],
    steps: [
      add('kid', { title: 'X', tmdbId: 1 }, 'kid add is section-blocked'),
      send('kid', 'PUT', '/api/radarr/api/v3/movie/5', { monitored: false }),
      get('kid', '/api/radarr/api/v3/release?movieId=1'),
      send('alice', 'POST', '/api/radarr/api/v3/movie/42/upgrade'),
      send(undefined, 'POST', '/api/radarr/api/v3/movie/42/upgrade'),
      send('admin', 'POST', '/api/radarr/api/v3/movie/not-a-number/upgrade'),
    ],
  },

  // --- upgrade ---
  {
    name: 'upgrade release search failed',
    upstream: [r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }), rootfolder(FREE), releases(42, { error: 'down' }, 502)],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade below the floor',
    upstream: [r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }), rootfolder(25 * GB)],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade no releases',
    upstream: [r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }), rootfolder(FREE), releases(42, [])],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade over the cap',
    upstream: [
      r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }),
      rootfolder(FREE),
      releases(42, [rel('g1', 50 * GB, 100, '4K HDR'), rel('g2', 50 * GB, 90, '4K HDR alt')]),
    ],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade all rejected',
    upstream: [
      r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }),
      rootfolder(FREE),
      releases(42, [rel('g1', 2 * GB, 100, '1080p', { rejected: true }), rel('g2', 2 * GB, 90, '720p', { rejected: true })]),
    ],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade grab failed',
    upstream: [
      r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }),
      rootfolder(FREE),
      releases(42, [rel('g1', 2 * GB, 100, '1080p good')]),
      grabPost(502, { error: 'indexer 502' }),
    ],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade grabs the best release',
    upstream: [
      r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }),
      rootfolder(FREE),
      releases(42, [rel('a', 3 * GB, 80, '1080p okay'), rel('b', 3 * GB, 120, '1080p best')]),
      grabPost(201, { id: 1 }),
    ],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    // 0.125 GiB: toFixed(2) breaks the exact tie upward (0.13).
    name: 'upgrade sizeGb rounds a tie up',
    upstream: [
      r('GET', '/api/v3/movie/42', 200, { id: 42, rootFolderPath: '/data/movies' }),
      rootfolder(FREE),
      releases(42, [rel('c', 134217728, 10, 'tiny')]),
      grabPost(201, { id: 1 }),
    ],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },
  {
    name: 'upgrade movie lookup failed',
    upstream: [r('GET', '/api/v3/movie/42', 404, { error: 'no' })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/movie/42/upgrade')],
  },

  // --- clear stuck ---
  {
    name: 'clear-stuck removes import-jammed records',
    upstream: [
      r('GET', '/api/v3/queue', 200, {
        records: [
          { id: 1, trackedDownloadState: 'importBlocked' },
          { id: 2, trackedDownloadState: 'downloading' },
          { id: 3, trackedDownloadState: 'importPending' },
        ],
      }),
      r('DELETE', '/api/v3/queue/bulk', 200, {}),
    ],
    steps: [send('alice', 'POST', '/api/radarr/api/v3/queue/clear-stuck', {}), send('admin', 'POST', '/api/radarr/api/v3/queue/clear-stuck', {})],
  },
  {
    name: 'clear-stuck with nothing jammed',
    upstream: [r('GET', '/api/v3/queue', 200, { records: [{ id: 1, trackedDownloadState: 'downloading' }] })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/queue/clear-stuck', {})],
  },
  {
    name: 'clear-stuck queue unreachable',
    upstream: [r('GET', '/api/v3/queue', 502, { error: 'boom' })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/queue/clear-stuck', {})],
  },
  {
    name: 'clear-stuck bulk delete failed',
    upstream: [r('GET', '/api/v3/queue', 200, { records: [{ id: 7, trackedDownloadState: 'importBlocked' }] }), r('DELETE', '/api/v3/queue/bulk', 500, { error: 'nope' })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/queue/clear-stuck', {})],
  },

  // --- R1 command ---
  {
    name: 'R1 command',
    upstream: [r('POST', '/api/v3/command', 201, { id: 3, name: 'MoviesSearch', status: 'started', extra: 'x' })],
    steps: [
      send('alice', 'POST', '/api/radarr/api/v3/command', { name: 'RefreshMovie', movieIds: [1] }),
      send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'Backup' }),
      send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'RefreshMovie' }),
      send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'RefreshMovie', movieIds: [] }),
      send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'MoviesSearch', movieIds: [42], evil: 'x' }),
      send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'RenameMovie', movieIds: [42], files: [1, 2], other: true }),
      { name: 'non-json command', as: 'admin', method: 'POST', path: '/api/radarr/api/v3/command', raw: '{not valid json' },
    ],
  },
  {
    name: 'R1 command failed',
    upstream: [r('POST', '/api/v3/command', 500, { error: 'nope' })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'RefreshMovie', movieIds: [1] })],
  },
  {
    name: 'R1 non-json ack',
    upstream: [r('POST', '/api/v3/command', 200, 'not json')],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/command', { name: 'RefreshMovie', movieIds: [1] })],
  },

  // --- R2 interactive search ---
  {
    name: 'R2 interactive search',
    upstream: [
      releases(5, [
        {
          guid: 'big', indexerId: 1, title: 'Big', size: 30 * GB, qualityWeight: 80, protocol: 'torrent',
          seeders: 50, indexer: 'IPT', quality: { quality: { name: 'Bluray-2160p' } },
          languages: [{ name: 'English' }, { name: 5 }, null], rejected: false, rejections: [], ageHours: 3.5,
        },
        {
          guid: 'small', indexerId: 1, title: 'Small', size: 4 * GB, qualityWeight: 40, protocol: 'usenet',
          quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }],
          rejected: true, rejections: ['Not an upgrade', 7], age: 2,
        },
        { guid: 'bare', indexerId: 2, title: 'Bare', size: 'huge', temporarilyRejected: true, languages: 'en', fullSeason: null },
      ]),
    ],
    steps: [
      get('alice', '/api/radarr/api/v3/release?movieId=1'),
      get('admin', '/api/radarr/api/v3/release?movieId=0'),
      get('admin', '/api/radarr/api/v3/release'),
      get('admin', '/api/radarr/api/v3/release?movieId=5'),
    ],
  },
  { name: 'R2 search failed', upstream: [releases(5, { error: 'boom' }, 500)], steps: [get('admin', '/api/radarr/api/v3/release?movieId=5')] },
  { name: 'R2 non-json releases', upstream: [releases(7, '<<garbage not json>>')], steps: [get('admin', '/api/radarr/api/v3/release?movieId=7')] },

  // --- R3 interactive grab ---
  {
    name: 'R3 interactive grab',
    upstream: [
      releases(5, [
        { guid: 'pick', indexerId: 9, title: 'Picked Movie', size: 4 * GB, qualityWeight: 50, protocol: 'usenet' },
        { guid: 'huge', indexerId: 9, title: 'Huge', size: 30 * GB, qualityWeight: 50 },
        { guid: 'noweight', indexerId: 9, size: 1 * GB },
      ]),
      grabPost(),
    ],
    steps: [
      send('alice', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'pick', indexerId: 9 }),
      { name: 'non-json grab', as: 'admin', method: 'POST', path: '/api/radarr/api/v3/release?movieId=5', raw: 'definitely-not-json' },
      send('admin', 'POST', '/api/radarr/api/v3/release', { guid: 'pick', indexerId: 9 }, 'no movieId'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'pick', indexerId: 9 }, 'within cap'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'huge', indexerId: 9 }, 'over cap'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'huge', indexerId: 9, allowOverCap: true }, 'over cap allowed'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'noweight', indexerId: 9 }, 'untitled release'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'ghost', indexerId: 9 }, 'not found'),
      send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'pick', indexerId: '9' }, 'string indexer'),
    ],
  },
  {
    name: 'R3 grab failed',
    upstream: [releases(5, [{ guid: 'pick', indexerId: 9, title: 'Picked Movie', size: 4 * GB, qualityWeight: 50 }]), grabPost(500, { error: 'x' })],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'pick', indexerId: 9 })],
  },
  {
    name: 'R3 release list failed',
    upstream: [releases(5, { error: 'x' }, 500)],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/release?movieId=5', { guid: 'pick', indexerId: 9 })],
  },
  {
    name: 'R3 non-json release list',
    upstream: [releases(7, '<<garbage>>')],
    steps: [send('admin', 'POST', '/api/radarr/api/v3/release?movieId=7', { guid: 'g', indexerId: 1 })],
  },

  // --- R4 rename, R5 history ---
  {
    name: 'R4 rename preview',
    upstream: [r('GET', '/api/v3/rename', 200, [{ movieFileId: 1, existingPath: '/old/m.mkv', newPath: '/new/m.mkv', extra: 'drop' }, {}], { query: { movieId: '5' } })],
    steps: [
      get('alice', '/api/radarr/api/v3/rename?movieId=1'),
      get('admin', '/api/radarr/api/v3/rename?movieId=0'),
      get('admin', '/api/radarr/api/v3/rename?movieId=5'),
    ],
  },
  { name: 'R4 rename failed', upstream: [r('GET', '/api/v3/rename', 500, { error: 'boom' })], steps: [get('admin', '/api/radarr/api/v3/rename?movieId=5')] },
  { name: 'R4 non-json rename', upstream: [r('GET', '/api/v3/rename', 200, '<<garbage>>')], steps: [get('admin', '/api/radarr/api/v3/rename?movieId=7')] },
  {
    name: 'R5 history',
    upstream: [
      r('GET', '/api/v3/history/movie', 200, [
        { date: '2026-06-01T00:00:00Z', eventType: 'grabbed', sourceTitle: 'old', quality: { quality: { name: 'WEBDL-1080p' } } },
        { date: 'not-a-date', eventType: 'grabbed', sourceTitle: 'bad' },
        { date: '2026-06-22T10:11:12.345Z', eventType: 'downloadFolderImported', sourceTitle: 'new', quality: { quality: { name: 'Bluray-1080p' } }, seasonNumber: 'x', episodeId: 9 },
        { eventType: 5 },
        { date: '2026-06-10', sourceTitle: 'dated' },
      ], { query: { movieId: '5' } }),
    ],
    steps: [
      get('alice', '/api/radarr/api/v3/history/movie?movieId=1'),
      get('admin', '/api/radarr/api/v3/history/movie?movieId=x'),
      get('admin', '/api/radarr/api/v3/history/movie?movieId=5'),
    ],
  },
  {
    name: 'R5 paged history',
    upstream: [r('GET', '/api/v3/history/movie', 200, { records: [{ date: '2026-06-20T00:00:00Z', eventType: 'grabbed', sourceTitle: 'X' }] })],
    steps: [get('admin', '/api/radarr/api/v3/history/movie?movieId=5')],
  },
  { name: 'R5 history failed', upstream: [r('GET', '/api/v3/history/movie', 503, { error: 'boom' })], steps: [get('admin', '/api/radarr/api/v3/history/movie?movieId=5')] },
  { name: 'R5 non-json history', upstream: [r('GET', '/api/v3/history/movie', 200, '<<garbage>>')], steps: [get('admin', '/api/radarr/api/v3/history/movie?movieId=7')] },

  // --- R6 edit ---
  {
    name: 'R6 edit overlays only the allowlist',
    upstream: [
      r('GET', '/api/v3/movie/5', 200, {
        id: 5, title: 'Existing Movie', monitored: true, qualityProfileId: 1,
        rootFolderPath: '/data/movies', path: '/data/movies/Existing', tmdbId: 999,
      }),
      r('PUT', '/api/v3/movie/5', 202, { id: 5, accepted: true }),
    ],
    steps: [
      send('alice', 'PUT', '/api/radarr/api/v3/movie/5', { monitored: false }),
      send('admin', 'PUT', '/api/radarr/api/v3/movie/5', {
        monitored: false, qualityProfileId: 7, rootFolderPath: '/data/movies2', title: 'HACKED', tmdbId: 1, path: '/etc/passwd',
      }),
      send('admin', 'PUT', '/api/radarr/api/v3/movie/5', { monitored: 'yes', qualityProfileId: '7', rootFolderPath: '' }, 'wrong types dropped'),
      { name: 'non-json patch', as: 'admin', method: 'PUT', path: '/api/radarr/api/v3/movie/5', raw: 'not-json-at-all' },
      send('admin', 'PUT', '/api/radarr/api/v3/movie/0', { monitored: false }),
    ],
  },
  { name: 'R6 lookup failed', upstream: [r('GET', '/api/v3/movie/9', 404, { error: 'no' })], steps: [send('admin', 'PUT', '/api/radarr/api/v3/movie/9', { monitored: false })] },
  {
    name: 'R6 update failed',
    upstream: [r('GET', '/api/v3/movie/9', 200, { id: 9, title: 'X', monitored: true }), r('PUT', '/api/v3/movie/9', 400, '{"error":"validation"}', { ct: 'application/json' })],
    steps: [send('admin', 'PUT', '/api/radarr/api/v3/movie/9', { monitored: false })],
  },

  // --- SAB ---
  {
    name: 'sab reads',
    upstream: [
      s('GET', '/api', 200, { queue: { slots: [] } }, { query: { mode: 'queue' } }),
      s('GET', '/api', 200, { history: { slots: [] } }, { query: { mode: 'history' } }),
    ],
    steps: [
      get('alice', '/api/sab/api?mode=queue'),
      get('alice', '/api/sab/api?mode=history&limit=5'),
      get('alice', '/api/sab/api?mode=history'),
      get('alice', '/api/sab/api?mode=history&limit=500'),
      get('alice', '/api/sab/api?mode=history&limit=abc'),
      get('alice', '/api/sab/api?mode=history&limit=0'),
      get('alice', '/api/sab/api?mode=history&limit=2.5'),
      get('alice', '/api/sab/api?mode=history&limit=1e1'),
      get(undefined, '/api/sab/api?mode=queue'),
      get('admin', '/api/sab/api?mode=shutdown'),
      get('admin', '/api/sab/api'),
      get('admin', '/api/sab/api?mode=queue&name=pause&value=x'),
      get('admin', '/api/sab/something-else'),
      get('admin', '/api/sab/api/queue/foo/pause'),
      get('kid', '/api/sab/api?mode=queue'),
    ],
  },
  {
    name: 'sab mutations',
    upstream: [
      s('GET', '/api', 200, { status: true, nzo_ids: ['foo'] }, { query: { mode: 'queue', name: 'pause' } }),
      s('GET', '/api', 200, { status: true }, { query: { mode: 'queue', name: 'resume' } }),
      s('GET', '/api', 200, { status: true }, { query: { mode: 'queue', name: 'delete' } }),
    ],
    steps: [
      send('alice', 'POST', '/api/sab/api/queue/foo/pause'),
      send('alice', 'POST', '/api/sab/api/queue/foo/resume'),
      send('alice', 'DELETE', '/api/sab/api/queue/foo'),
      send('admin', 'POST', '/api/sab/api/queue/foo/pause'),
      send('admin', 'POST', '/api/sab/api/queue/SABnzbd_nzo_a%20b%26c/resume'),
      send('admin', 'DELETE', '/api/sab/api/queue/foo'),
      send('kid', 'POST', '/api/sab/api/queue/foo/pause'),
    ],
  },
  {
    name: 'sab non-json answers',
    upstream: [
      s('GET', '/api', 200, '<html>API Key Incorrect</html>', { query: { mode: 'queue' }, ct: 'text/html' }),
      s('GET', '/api', 200, '{"history":{"slots":[]}}', { query: { mode: 'history' } }),
    ],
    steps: [get('alice', '/api/sab/api?mode=queue'), get('alice', '/api/sab/api?mode=history')],
  },
  {
    name: 'sab upstream error relayed',
    upstream: [s('GET', '/api', 500, 'oops', { query: { mode: 'queue' } })],
    steps: [get('alice', '/api/sab/api?mode=queue'), send('admin', 'POST', '/api/sab/api/queue/foo/pause')],
  },
  {
    name: 'sab rate limit spends before the admin check',
    upstream: [],
    steps: [{ ...send('alice', 'POST', '/api/sab/api/queue/foo/pause'), repeat: 13 }],
  },
  {
    name: 'sab not configured',
    env: { 'SAB_API_KEY': '' },
    upstream: [],
    steps: [get('alice', '/api/sab/api?mode=queue')],
  },

  // --- grabs ---
  {
    name: 'grab log reads',
    upstream: [],
    grabs_seed: [
      '{"ts":"2026-01-01T00:00:00.000Z","app":"sonarr","itemId":1,"type":"grab_started"}',
      `{"ts":"2026-01-01T00:00:01.000Z","app":"radarr","itemId":9,"sub":"${MEMBERS.admin.sub}","type":"grab_started"}`,
      'not json',
      `{"ts":"2026-01-01T00:00:02.000Z","app":"radarr","itemId":9,"title":"Café 🎬","capGb":10,"sub":"${MEMBERS.admin.sub}","type":"grab_succeeded","status":200,"scanned":2,"eligible":1,"release":{"title":"Cafe 1080p","sizeBytes":2147483648,"qualityWeight":100}}`,
      `{"ts":"2026-01-01T00:00:03.000Z","app":"radarr","itemId":9,"sub":"${MEMBERS.alice.sub}","type":"grab_started"}`,
      '{"ts":"2026-01-01T00:00:04.000Z","app":"radarr","itemId":9,"type":"no_releases"}',
      '{"ts":"2026-01-01T00:00:05.000Z","app":"sonarr","itemId":1,"type":"grab_succeeded"}',
      '{"ts":"2026-01-01T00:00:06.000Z","app":"radarr","itemId":1,"type":"grab_started"}',
      '{"ts":"2026-01-01T00:00:07.000Z","app":"sonarr","itemId":2,"type":"grab_started"}',
      '',
    ].join('\n'),
    steps: [
      get(undefined, '/api/grabs/recent'),
      get('alice', '/api/grabs/recent'),
      get('admin', '/api/grabs/recent'),
      get('admin', '/api/grabs/recent?limit=2'),
      get('admin', '/api/grabs/recent?limit=99999'),
      get('admin', '/api/grabs/recent?limit=abc'),
      get('admin', '/api/grabs/recent?limit=0.5'),
      get(undefined, '/api/grabs/by-item?app=sonarr&itemId=1'),
      get('alice', '/api/grabs/by-item?itemId=1'),
      get('alice', '/api/grabs/by-item?app=plex&itemId=1'),
      get('alice', '/api/grabs/by-item?app=sonarr&itemId=NaN'),
      get('alice', '/api/grabs/by-item?app=sonarr&itemId=1.5'),
      get('admin', '/api/grabs/by-item?app=radarr&itemId=9'),
      get('alice', '/api/grabs/by-item?app=radarr&itemId=9'),
      get('alice', '/api/grabs/by-item?app=sonarr&itemId=1'),
      get('alice', '/api/grabs/by-item?app=sonarr&itemId=1&limit=1'),
      get('kid', '/api/grabs/by-item?app=radarr&itemId=1'),
    ],
  },
]

// --- the fake upstream ----------------------------------------------------------------

type Call = { method: string; path: string; query: string; body: unknown; key_header: string | null; secret: string | null; bearer: boolean }
const calls: Call[] = []
let routes: Route[] = []
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const url = new URL(req.url ?? '/', 'http://fake')
    const method = req.method ?? ''
    calls.push({
      method,
      path: url.pathname,
      query: url.search.replace(/^\?/, ''),
      body,
      key_header: (req.headers['x-api-key'] as string | undefined) ?? null,
      secret: (req.headers['x-recommender-secret'] as string | undefined) ?? null,
      bearer: typeof req.headers.authorization === 'string',
    })
    const hit = routes.find(
      (rt) =>
        rt.method === method &&
        rt.path === url.pathname &&
        Object.entries(rt.query ?? {}).every(([k, v]) => url.searchParams.get(k) === v),
    )
    if (hit) {
      res.writeHead(hit.status, { 'content-type': hit.ct })
      return res.end(hit.text)
    }
    res.writeHead(url.pathname.startsWith('/rec/') ? 200 : 404, { 'content-type': 'application/json' })
    res.end(url.pathname.startsWith('/rec/') ? '{}' : '{"error":"no fixture"}')
  })
})
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

/** Wait out fire-and-forget mirrors (no new call for 100 ms). */
async function quiet(): Promise<void> {
  let seen = -1
  while (calls.length !== seen) {
    seen = calls.length
    await new Promise((ok) => setTimeout(ok, 100))
  }
}

// --- the TS app ------------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arr-goldens-'))
fs.writeFileSync(path.join(dir, 'policies.json'), POLICIES)
Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  RADARR_URL: `${fakeUrl}/radarr`,
  SAB_URL: `${fakeUrl}/sab`,
  RECOMMENDER_URL: `${fakeUrl}/rec`,
  USER_POLICIES_PATH: path.join(dir, 'policies.json'),
  USER_FEEDBACK_PATH: path.join(dir, 'feedback.json'),
  REJECTIONS_PATH: path.join(dir, 'rejections.json'),
  USER_WATCHLIST_PATH: path.join(dir, 'watchlist.json'),
  GRAB_LOG_PATH: path.join(dir, 'grabs.jsonl'),
})
delete process.env.NODE_ENV
process.chdir(dir)

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(fakeUrl)) throw new Error(`gen-arr-goldens: no network (${url})`)
  return realFetch(input, init)
}) as typeof fetch
const log = console.log
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const { app } = await import(path.join(server, 'app.js'))
const { createMemberSession } = await import(path.join(server, 'test/authFixture.js'))
const { __resetRateLimitsForTests } = await import(path.join(server, 'middleware/rateLimit.js'))
const { _setGrabLogPathForTests } = await import(path.join(server, 'services/grabLog.js'))
const { env } = await import(path.join(server, 'env.js'))
const cookies: Record<string, string> = {}
for (const [who, m] of Object.entries(MEMBERS)) {
  cookies[who] = `eex.session=${await createMemberSession({ sub: m.sub, username: m.username, role: m.role })}`
}

// Scenario env overrides onto the live env object (read per call).
const ENV_KEYS: Record<string, string> = Object.fromEntries([
  ['RADARR_API_KEY', 'radarrApiKey'],
  ['SAB_API_KEY', 'sabApiKey'],
  ['DEFAULT_RADARR_ROOT_FOLDER_PATH', 'defaultRadarrRootFolderPath'],
])
const normTs = (line: string) => line.replace(/"ts":"[^"]*"/, '"ts":"<ts>"')
const normBody = (text: string) => text.replace(/"retry_after_ms":\d+/g, '"retry_after_ms":"<ms>"')

const out = []
let n = 0
for (const sc of SCENARIOS) {
  __resetRateLimitsForTests()
  const grabPath = path.join(dir, `grabs-${n++}.jsonl`)
  if (sc.grabs_seed !== undefined) fs.writeFileSync(grabPath, sc.grabs_seed)
  _setGrabLogPathForTests(grabPath)
  const saved: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(sc.env ?? {})) {
    const key = ENV_KEYS[k]
    if (!key) throw new Error(`unmapped env ${k}`)
    saved[key] = env[key]
    env[key] = v === '' ? null : v
  }
  routes = sc.upstream
  const steps = []
  for (const st of sc.steps) {
    const method = st.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (st.as) headers.Cookie = cookies[st.as]
    if (method !== 'GET') headers.Origin = 'https://app.example'
    let body: string | undefined
    if (st.raw !== undefined) body = st.raw
    else if (st.body !== undefined) body = JSON.stringify(st.body)
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const before = fs.existsSync(grabPath) ? fs.readFileSync(grabPath, 'utf8') : ''
    const statuses: number[] = []
    let res!: Response
    for (let i = 0; i < (st.repeat ?? 1); i++) {
      res = await app.request(new Request(`http://localhost${st.path}`, { method, headers, body }))
      statuses.push(res.status)
      if (i + 1 < (st.repeat ?? 1)) await res.text()
    }
    const text = await res.text()
    if (method === 'POST' && st.path === '/api/radarr/api/v3/movie') await quiet()
    const after = fs.existsSync(grabPath) ? fs.readFileSync(grabPath, 'utf8') : ''
    const { body: _b, raw: _r, ...rest } = st
    steps.push({
      ...rest,
      request_body: body ?? null,
      ...(st.repeat ? { statuses } : {}),
      status: res.status,
      content_type: res.headers.get('content-type'),
      retry_after: res.headers.get('retry-after'),
      body: normBody(text),
      calls: calls.splice(0, calls.length),
      grabs: after.slice(before.length).split('\n').filter(Boolean).map(normTs),
    })
  }
  for (const [k, v] of Object.entries(saved)) env[k] = v
  out.push({ name: sc.name, env: sc.env ?? {}, upstream: sc.upstream, grabs_seed: sc.grabs_seed ?? null, steps })
}

console.log = log
fake.close()
fs.writeFileSync(
  path.join(here, 'arr-goldens.json'),
  JSON.stringify({ env: ENV, members: MEMBERS, policies: POLICIES, scenarios: out }, null, 2) + '\n',
)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
