// Writes sonarr-goldens.json from the untouched TS app (server/app.ts): the
// /api/sonarr and /api/notifications routes, scenario by scenario, against
// one local fake that serves Sonarr (/sonarr), Radarr (/radarr) and the
// recommender (/rec) from each scenario's fixture routes and records every
// request it gets. Per step it keeps the status, Content-Type, Retry-After,
// the body, the ordered upstream requests and the grabs.jsonl lines the step
// appended, background TV grab included. src/arr/goldens.rs replays the
// same scenarios through gateway::router against the Rust copy of the fake.
//
// The background grab: the TS waits 2 s before it and 1.5 s between episode
// polls; setTimeout is patched to run exactly those two delays at once
// (the upstream timeouts are 15/50/180 s, the recommender's 3 s, untouched).
// A step with `settle` waits until the grab is done: no request open at the
// fake, none for 100 ms, and grabs.jsonl unchanged. The Rust side awaits
// ArrState::idle. A step with `wait_for` waits until the fake has seen that
// request before the step is recorded (a grab POST held open by delay_ms
// keeps its reservation on the books for the next steps).
//
// Each scenario starts clean: rate-limit buckets reset, a fresh grabs.jsonl,
// its env overrides applied. Per-run values are normalized on both sides: a
// grab-log "ts" becomes <ts>, a 429's retry_after_ms becomes <ms>.
//
// No network: globalThis.fetch reaches only the fake on 127.0.0.1.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-sonarr-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

const ENV: Record<string, string> = {
  SESSION_SECRET: 'sonarr-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'sonarr-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'sonarr-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'sonarr-goldens-internal-principal-placeholder-zzz',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  SONARR_API_KEY: 'placeholder-sonarr-key',
  RADARR_API_KEY: 'placeholder-radarr-key',
  MIN_FREE_GB: '100',
  MAX_TV_GB_PER_EPISODE: '5',
  USE_LOCAL_RECOMMENDER: '1',
  RECOMMENDER_EVENT_SECRET: 'sonarr-goldens-recommender-secret',
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
type Route = {
  method: string
  path: string
  query?: Record<string, string>
  status: number
  text: string
  ct: string
  delay_ms?: number
}
type RouteOpts = { query?: Record<string, string>; ct?: string; delay_ms?: number }
const at = (prefix: string) => (method: string, p: string, status: number, body: unknown, opts: RouteOpts = {}): Route => ({
  method,
  path: prefix + p,
  ...(opts.query ? { query: opts.query } : {}),
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  ct: opts.ct ?? (typeof body === 'string' ? 'text/plain' : 'application/json'),
  ...(opts.delay_ms ? { delay_ms: opts.delay_ms } : {}),
})
const t = at('/sonarr')
const r = at('/radarr')

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
  /** Wait for the background TV grab to finish (default: on for adds and season monitors). */
  settle?: boolean
  /** Wait until the fake has seen this request before recording the step. */
  wait_for?: { method: string; path: string }
}
type Scenario = {
  name: string
  env?: Record<string, string>
  upstream: Route[]
  steps: Step[]
}

// --- fixture helpers --------------------------------------------------------------------

const FREE = 500 * GB
const rootfolder = (free: number, p = '/data/tv') => t('GET', '/api/v3/rootfolder', 200, [{ id: 1, path: p, freeSpace: free }])
const profiles = (list: unknown[]) => t('GET', '/api/v3/qualityprofile', 200, list)
const created = (body: unknown, status = 201) => t('POST', '/api/v3/series', status, body)
const seriesGet = (id: number, body: unknown, status = 200) => t('GET', `/api/v3/series/${id}`, status, body)
const seriesPut = (id: number, status = 200, body: unknown = { id }) => t('PUT', `/api/v3/series/${id}`, status, body)
/** `count` episodes per season. */
const episodes = (id: number, perSeason: Record<number, number>) =>
  t('GET', '/api/v3/episode', 200, Object.entries(perSeason).flatMap(([s, n]) =>
    Array.from({ length: n }, (_, i) => ({ seasonNumber: Number(s), episodeNumber: i + 1, hasFile: false }))), { query: { seriesId: String(id) } })
const releases = (id: number, season: number, list: unknown, status = 200) =>
  t('GET', '/api/v3/release', status, list, { query: { seriesId: String(id), seasonNumber: String(season) } })
const grabPost = (status = 200, body: unknown = { ok: true }, delay_ms = 0) => t('POST', '/api/v3/release', status, body, { delay_ms })
const rel = (guid: string, size: number, qualityWeight: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ guid, indexerId: 1, size, qualityWeight, title, ...extra })
const ep = (season: number, eps: number[]) => ({ seasonNumber: season, episodeNumbers: eps })
const pack = (season: number) => ({ seasonNumber: season, fullSeason: true })

const add = (as: Who, body: unknown, name = `${as} add`): Step => ({ name, as, method: 'POST', path: '/api/sonarr/api/v3/series', body })
const adminAdd = (body: Record<string, unknown>, name: string) =>
  add('admin', { rootFolderPath: '/data/tv', qualityProfileId: 7, monitored: true, ...body }, name)
const get = (as: Who | undefined, p: string, name = `${as ?? 'anon'} GET ${p}`): Step => ({ name, as, path: p })
const send = (as: Who | undefined, method: string, p: string, body?: unknown, name = `${as ?? 'anon'} ${method} ${p}`): Step =>
  ({ name, as, method, path: p, body })
const monitor = (as: Who, id: number | string, n: number | string, extra: Partial<Step> = {}): Step =>
  ({ name: `${as} monitor ${id}/${n}`, as, method: 'POST', path: `/api/sonarr/api/v3/series/${id}/seasons/${n}/monitor`, ...extra })
const SEARCH_OFF = { searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
const CHOOSE = [{ id: 7, name: 'Choose Me' }]
// One 4 GB reservation fits above the 100 GB floor; a second does not.
const TIGHT_FREE = 107 * GB
// A show monitored by the season route: series 7, season 1.
const show7 = (folder = '/data/tv') => seriesGet(7, { id: 7, title: 'Show Seven', rootFolderPath: folder, seasons: [{ seasonNumber: 1, monitored: false }] })

// Notifications.
const EMERALD = 'Emerald Exchange Discord'
const GOOD_WEBHOOK = 'https://discord.com/api/webhooks/123/abc'
const conn = (id: number, extra: Record<string, unknown> = {}) => ({ id, name: EMERALD, implementation: 'Discord', ...extra })
const list = (at_: typeof t, items: unknown, status = 200) => at_('GET', '/api/v3/notification', status, items)
const notify = (as: Who | undefined, method: string, body?: unknown, p = '/api/notifications/discord'): Step => send(as, method, p, body)
const configure = (url: unknown = GOOD_WEBHOOK, name?: string): Step => ({ ...notify('admin', 'POST', { webhookUrl: url }), ...(name ? { name } : {}) })

const SCENARIOS: Scenario[] = [
  // --- forwarded reads, allowlist, auth ---
  {
    name: 'sonarr reads',
    upstream: [
      t('GET', '/api/v3/series', 200, [{ id: 1, title: 'Test Show' }]),
      t('GET', '/api/v3/series/lookup', 200, [{ title: 'Severance', tvdbId: 371980 }]),
      t('GET', '/api/v3/episode', 200, [{ seasonNumber: 1, episodeNumber: 1, airDate: '2022-02-18' }], { query: { seriesId: '5' } }),
      t('GET', '/api/v3/queue', 200, { page: 1, pageSize: 200, totalRecords: 0, records: [] }),
      t('GET', '/api/v3/system/status', 200, { version: '4.0.0' }),
      profiles(CHOOSE),
      rootfolder(FREE),
    ],
    steps: [
      get(undefined, '/api/sonarr/api/v3/series'),
      get('alice', '/api/sonarr/api/v3/series'),
      get('alice', '/api/sonarr/api/v3/series/lookup?term=severance'),
      get('alice', '/api/sonarr/api/v3/series/lookup?term=the%20matrix&term=heat'),
      get('alice', '/api/sonarr/api/v3/episode?seriesId=5'),
      get('alice', '/api/sonarr/api/v3/queue?pageSize=200'),
      get('alice', '/api/sonarr/api/v3/system/status'),
      get('admin', '/api/sonarr/api/v3/qualityprofile'),
      get('alice', '/api/sonarr/api/v3/rootfolder'),
      get('admin', '/api/sonarr/api/v3/some-undeclared-path'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series-but-different-suffix'),
      get('admin', '/api/sonarr/api/v3/series/5'),
      // Reads stay open when the arr section is denied.
      get('kid', '/api/sonarr/api/v3/series'),
    ],
  },
  {
    name: 'sonarr read errors',
    upstream: [t('GET', '/api/v3/series', 500, 'boom'), t('GET', '/api/v3/queue', 401, { error: 'bad key' })],
    steps: [get('alice', '/api/sonarr/api/v3/series'), get('alice', '/api/sonarr/api/v3/queue')],
  },
  {
    name: 'sonarr not configured',
    env: { SONARR_API_KEY: '' },
    upstream: [],
    steps: [
      get('alice', '/api/sonarr/api/v3/series'),
      add('admin', { rootFolderPath: '/data/tv', title: 'Foo' }, 'admin add with policy'),
      add('alice', { title: 'X', tvdbId: 1 }, 'alice slim add'),
      monitor('admin', 1, 1),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5'),
    ],
  },

  // --- delete ---
  {
    name: 'sonarr delete',
    upstream: [t('DELETE', '/api/v3/series/42', 200, '')],
    steps: [
      send('alice', 'DELETE', '/api/sonarr/api/v3/series/42'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series/42'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series/42?deleteFiles=true&addImportExclusion=false'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series/..%2Frootfolder%2F1'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series/abc'),
      send('admin', 'DELETE', '/api/sonarr/api/v3/series/0'),
      send('kid', 'DELETE', '/api/sonarr/api/v3/series/42'),
    ],
  },
  {
    name: 'sonarr delete rate limit',
    upstream: [t('DELETE', '/api/v3/series/42', 200, '')],
    steps: [{ ...send('admin', 'DELETE', '/api/sonarr/api/v3/series/42'), repeat: 13 }],
  },

  // --- the add: gates and policy ---
  {
    name: 'add 507 below the floor',
    upstream: [rootfolder(50 * GB)],
    steps: [add('admin', { rootFolderPath: '/data/tv', title: 'Foo' }), add('admin', { rootFolderPath: '/data/tv', title: 'Bar' }, 'admin add again')],
  },
  {
    name: 'add 507 for admins too',
    upstream: [rootfolder(1 * GB)],
    steps: [add('admin', { rootFolderPath: '/data/tv', title: 'Foo' })],
  },
  {
    name: 'add forwards when there is room',
    upstream: [rootfolder(FREE), created({ id: 99, title: 'Foo' })],
    steps: [add('admin', { rootFolderPath: '/data/tv', title: 'Foo' })],
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
    upstream: [t('GET', '/api/v3/rootfolder', 200, [{ id: 1, path: '/data/tv' }])],
    steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })],
  },
  {
    name: 'admin add blank root folder',
    upstream: [rootfolder(FREE)],
    steps: [add('admin', { title: 'X', rootFolderPath: '' })],
  },
  { name: 'rootfolder 500 is 502', upstream: [t('GET', '/api/v3/rootfolder', 500, 'down')], steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })] },
  { name: 'rootfolder 503 is 503', upstream: [t('GET', '/api/v3/rootfolder', 503, 'busy')], steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })] },
  { name: 'rootfolder 504 is 503', upstream: [t('GET', '/api/v3/rootfolder', 504, { error: 'gateway' })], steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })] },
  { name: 'rootfolder 401 is 502', upstream: [t('GET', '/api/v3/rootfolder', 401, 'nope')], steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })] },
  { name: 'rootfolder not a list', upstream: [t('GET', '/api/v3/rootfolder', 200, '<html>')], steps: [add('admin', { title: 'X', rootFolderPath: '/data/tv' })] },
  {
    name: 'honoured member picks',
    upstream: [
      t('GET', '/api/v3/rootfolder', 200, [
        { id: 1, path: '/data/tv', freeSpace: FREE },
        { id: 2, path: '/data/tv-mirror', freeSpace: FREE },
      ]),
      profiles([{ id: 11, name: 'Choose Me' }, { id: 22, name: 'Any' }]),
      created({ id: 999, title: 'Hostile', seasons: [] }),
      episodes(999, { 1: 2 }),
      releases(999, 1, [rel('h1', 2 * GB, 100, 'Hostile S01E01', ep(1, [1]))]),
      grabPost(),
    ],
    steps: [
      add('alice', {
        title: 'Hostile',
        tvdbId: 42,
        rootFolderPath: '/data/tv-mirror',
        qualityProfileId: 22,
        monitored: false,
        seasonFolder: false,
        languageProfileId: 9,
        tags: [99],
        addOptions: { monitor: 'all', searchForCutoffUnmetEpisodes: true },
        seasons: [{ seasonNumber: 1, monitored: true }],
      }),
      add('alice', { title: 'X', tvdbId: 7, rootFolderPath: '/etc/passwd', qualityProfileId: 11 }, 'unknown folder'),
      add('alice', { title: 'X', tvdbId: 7, rootFolderPath: '/data/tv', qualityProfileId: 3 }, 'unknown profile'),
      add('alice', { title: 'Hostile', tvdbId: 42, rootFolderPath: '', addOptions: SEARCH_OFF }, 'blank folder takes the default'),
    ],
  },
  {
    name: 'member slim body: Choose Me, firstSeason, re-read',
    upstream: [
      rootfolder(FREE),
      profiles([{ id: 1, name: 'Any' }, { id: 5, name: 'Choose Me' }, { id: 8, name: 'HD - 1080p' }]),
      created({ id: 42, title: 'X', monitored: true, seasons: [] }),
      seriesGet(42, { id: 42, title: 'X', seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }] }),
      episodes(42, { 0: 1, 1: 3, 2: 3 }),
      releases(42, 1, []),
    ],
    steps: [add('alice', { title: 'X', tvdbId: 1, tmdbId: 12345 })],
  },
  {
    name: 'member happy path skips the re-read',
    upstream: [
      rootfolder(FREE),
      profiles(CHOOSE),
      created({ id: 42, title: 'X', monitored: true, seasons: [{ seasonNumber: 1, monitored: true }] }),
      episodes(42, { 1: 2 }),
      releases(42, 1, [rel('x1', 3 * GB, 100, 'X S01E01', ep(1, [1]))]),
      grabPost(),
    ],
    steps: [add('alice', { title: 'X', tvdbId: 1 })],
  },
  {
    name: 'admin must configure upstream',
    upstream: [t('GET', '/api/v3/rootfolder', 200, []), profiles([])],
    steps: [add('alice', { title: 'X', tvdbId: 1 })],
  },
  {
    name: 'default root folder missing',
    env: { DEFAULT_SONARR_ROOT_FOLDER_PATH: '/data/configured' },
    upstream: [rootfolder(FREE, '/data/other'), profiles(CHOOSE)],
    steps: [add('alice', { title: 'X', tvdbId: 1 })],
  },
  { name: 'default quality profile missing', upstream: [rootfolder(FREE), profiles([])], steps: [add('alice', { title: 'X', tvdbId: 1 })] },
  {
    name: 'quality profile unreachable',
    upstream: [rootfolder(FREE), t('GET', '/api/v3/qualityprofile', 500, 'down')],
    steps: [add('alice', { title: 'X', tvdbId: 1 })],
  },
  {
    name: 'admin slim body materializes',
    upstream: [rootfolder(FREE), profiles([{ id: 11, name: 'Choose Me' }]), created({ id: 1234, title: 'House', seasons: [] })],
    steps: [add('admin', { tvdbId: 73255, tmdbId: 1408, title: 'House' })],
  },
  {
    name: 'search off skips the grab',
    upstream: [rootfolder(FREE), created({ id: 99, title: 'Foo', monitored: true, seasons: [] })],
    steps: [adminAdd({ title: 'Foo', addOptions: SEARCH_OFF }, 'admin add search off')],
  },
  {
    name: 'add refused upstream is relayed',
    upstream: [rootfolder(FREE), created({ error: 'sonarr says no' }, 400)],
    steps: [adminAdd({ title: 'Foo', addOptions: { searchForMissingEpisodes: true }, seasons: [{ seasonNumber: 1, monitored: true }] }, 'admin add refused')],
  },
  {
    name: 'nothing monitored skips the grab',
    upstream: [rootfolder(FREE), created({ id: 99, title: 'Foo', monitored: true, seasons: [{ seasonNumber: 1, monitored: false }] })],
    steps: [adminAdd({ title: 'Foo', addOptions: { searchForMissingEpisodes: true }, seasons: [{ seasonNumber: 1, monitored: false }] }, 'admin add none monitored')],
  },
  {
    name: 'search is forced off on the forwarded body',
    upstream: [rootfolder(FREE), created({ id: 99, title: 'Foo', monitored: true, seasons: [] })],
    steps: [adminAdd({ title: 'Foo', addOptions: { searchForMissingEpisodes: true, searchForCutoffUnmetEpisodes: true, monitor: 'future' } }, 'admin add both searches')],
  },
  {
    name: 'admin path tolerance forwards the canonical path',
    upstream: [rootfolder(FREE), created({ id: 4242, title: 'Admin Add', seasons: [] })],
    steps: [
      adminAdd({ title: 'Admin Add', tvdbId: 4242, rootFolderPath: '/data/tv/', addOptions: SEARCH_OFF }, 'trailing slash'),
      adminAdd({ title: 'Admin Add', tvdbId: 4242, rootFolderPath: '/DATA/TV', addOptions: SEARCH_OFF }, 'case variant'),
      adminAdd({ title: 'Admin Add', tvdbId: 4242, rootFolderPath: '/data/nope', addOptions: SEARCH_OFF }, 'absent'),
    ],
  },
  {
    name: 'section and admin gates',
    upstream: [],
    steps: [
      add('kid', { title: 'X', tvdbId: 1 }, 'kid add is section-blocked'),
      monitor('kid', 1, 1),
      send('kid', 'PUT', '/api/sonarr/api/v3/series/5', { monitored: false }),
      get('kid', '/api/sonarr/api/v3/release?seriesId=1'),
      monitor('alice', 1, 2),
    ],
  },
  {
    name: 'add with an unusable body',
    upstream: [],
    steps: [
      { name: 'array body', as: 'admin', method: 'POST', path: '/api/sonarr/api/v3/series', raw: '[1,2]' },
      { name: 'non-json body', as: 'admin', method: 'POST', path: '/api/sonarr/api/v3/series', raw: 'nope' },
      { name: 'null body', as: 'alice', method: 'POST', path: '/api/sonarr/api/v3/series', raw: 'null' },
    ],
  },
  {
    name: 'an unparseable 201 skips the reconcile',
    upstream: [rootfolder(FREE), created('<html>added</html>', 201)],
    steps: [adminAdd({ title: 'Html' }, 'admin add html ack')],
  },

  // --- the add: reconcile ---
  {
    name: 'explicit season pick is put back',
    upstream: [
      rootfolder(FREE),
      created({ id: 77, title: 'Pick', monitored: true, seasons: [{ seasonNumber: 1, monitored: false, statistics: { episodeCount: 8 } }, { seasonNumber: 2, monitored: false }] }),
      seriesPut(77),
      episodes(77, { 1: 8, 2: 4 }),
      releases(77, 2, [rel('p2', 12 * GB, 100, 'Pick S02 1080p', pack(2))]),
      grabPost(),
    ],
    steps: [
      adminAdd({
        title: 'Pick',
        addOptions: { monitor: 'none', searchForMissingEpisodes: true },
        seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: true }],
      }, 'admin add season 2 only'),
    ],
  },
  {
    name: 'explicit pick re-reads an empty echo; a failed PUT still grabs',
    upstream: [
      rootfolder(FREE),
      created({ id: 78, title: 'Pick Two', seasons: [] }),
      seriesGet(78, { id: 78, title: 'Pick Two', monitored: false, seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: false }], extra: 'kept' }),
      seriesPut(78, 500, { error: 'nope' }),
      episodes(78, { 1: 2, 2: 2 }),
      releases(78, 2, []),
    ],
    steps: [
      adminAdd({
        title: 'Pick Two',
        addOptions: { monitor: 'none' },
        seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: true }],
      }, 'admin add season 2 only'),
    ],
  },
  {
    name: 'explicit pick with nothing to patch',
    upstream: [rootfolder(FREE), created({ id: 79, title: 'Pick Three', seasons: [] }), seriesGet(79, { id: 79, seasons: [] }), episodes(79, { 1: 1 }), releases(79, 1, [])],
    steps: [adminAdd({ title: 'Pick Three', addOptions: { monitor: 'none' }, seasons: [{ seasonNumber: 1, monitored: true }] }, 'admin add season 1 only')],
  },
  {
    name: 'a failed re-read skips the grab',
    upstream: [rootfolder(FREE), created({ id: 80, title: 'Y', seasons: [] }), seriesGet(80, { error: 'x' }, 500)],
    steps: [adminAdd({ title: 'Y' }, 'admin add, re-read 500')],
  },
  {
    name: 'a re-read that is not JSON skips the grab',
    upstream: [rootfolder(FREE), created({ id: 81, title: 'Z', seasons: [] }), seriesGet(81, '<html>')],
    steps: [adminAdd({ title: 'Z' }, 'admin add, re-read html')],
  },

  // --- the background grab ---
  {
    name: 'capped grab: best per chunk, packs first, no overlap',
    upstream: [
      rootfolder(FREE),
      created({ id: 500, title: 'Picker', seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }, { seasonNumber: 3, monitored: false }] }),
      episodes(500, { 1: 6, 2: 4, 3: 2 }),
      releases(500, 1, [
        rel('s1-pack', 24 * GB, 100, 'Picker S01 1080p', pack(1)),
        rel('s1-pack-4k', 60 * GB, 120, 'Picker S01 2160p', pack(1)),
        rel('s1e1', 2 * GB, 110, 'Picker S01E01', ep(1, [1])),
      ]),
      releases(500, 2, [
        rel('s2e1-2', 8 * GB, 100, 'Picker S02E01-E02', ep(2, [1, 2])),
        rel('s2e2-3', 6 * GB, 90, 'Picker S02E02-E03', ep(2, [2, 3])),
        rel('s2e3a', 3 * GB, 80, 'Picker S02E03 a', ep(2, [3])),
        rel('s2e3b', 2 * GB, 80, 'Picker S02E03 b', ep(2, [3])),
        rel('s2e4-4k', 12 * GB, 100, 'Picker S02E04 2160p', ep(2, [4])),
        rel('s2e4-rej', 3 * GB, 100, 'Picker S02E04 rejected', { ...ep(2, [4]), rejected: true }),
        rel('s2e4-tmp', 3 * GB, 95, 'Picker S02E04 held', { ...ep(2, [4]), temporarilyRejected: true }),
        rel('s3e1', 1 * GB, 100, 'Picker S03E01', ep(3, [1])),
        rel('zero', 0, 100, 'Picker zero', ep(2, [4])),
        rel('special', 1 * GB, 50, 'Picker special'),
      ]),
      grabPost(),
    ],
    steps: [adminAdd({ title: 'Picker', addOptions: { searchForMissingEpisodes: true }, seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }, { seasonNumber: 3, monitored: false }] }, 'admin add seasons 1-2')],
  },
  {
    name: 'capped grab: a failed season search moves on',
    upstream: [
      rootfolder(FREE),
      created({ id: 501, title: 'Flaky', seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }] }),
      episodes(501, { 1: 2, 2: 2 }),
      releases(501, 1, { error: 'indexers down' }, 500),
      releases(501, 2, [rel('f2', 2 * GB, 100, 'Flaky S02E01', ep(2, [1]))]),
      grabPost(201, { id: 3 }),
    ],
    steps: [adminAdd({ title: 'Flaky', seasons: [{ seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: true }] }, 'admin add flaky')],
  },
  {
    name: 'capped grab: every release rejected by the profile',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [rel('r1', 2 * GB, 100, 'S01E01', { ...ep(1, [1]), rejected: true }), rel('r2', 2 * GB, 90, 'S01E02', { ...ep(1, [2]), temporarilyRejected: true })])],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: every release over the cap',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [rel('big', 30 * GB, 100, 'S01E01 2160p', ep(1, [1])), rel('pack', 40 * GB, 90, 'S01 2160p', pack(1))])],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: no releases',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [])],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: the plan would breach the floor',
    upstream: [show7(), rootfolder(103 * GB), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [rel('e1', 4 * GB, 100, 'S01E01', ep(1, [1]))])],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: a refused grab is grab_failed',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [rel('e1', 4 * GB, 100, 'S01E01', ep(1, [1])), rel('e2', 4 * GB, 100, 'S01E02', ep(1, [2]))]), grabPost(500, { error: 'no' })],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: a 504 grab is grab_unconfirmed',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), episodes(7, { 1: 2 }), releases(7, 1, [rel('e1', 4 * GB, 100, 'S01E01', ep(1, [1]))]), grabPost(504, { error: 'upstream_timeout' })],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: empty episode list polls five times, packs skipped',
    upstream: [
      show7(),
      rootfolder(FREE),
      seriesPut(7),
      t('GET', '/api/v3/episode', 200, [], { query: { seriesId: '7' } }),
      releases(7, 1, [rel('pk', 8 * GB, 120, 'S01 pack', pack(1)), rel('e1', 2 * GB, 100, 'S01E01', ep(1, [1]))]),
      grabPost(),
    ],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'capped grab: refused episode list polls five times',
    upstream: [show7(), rootfolder(FREE), seriesPut(7), t('GET', '/api/v3/episode', 500, 'busy', { query: { seriesId: '7' } }), releases(7, 1, [rel('e1', 2 * GB, 100, 'S01E01', ep(1, [1]))]), grabPost()],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'reservation in flight',
    upstream: [
      show7(),
      seriesPut(7),
      rootfolder(TIGHT_FREE),
      episodes(7, { 1: 1 }),
      releases(7, 1, [rel('g-7', 4 * GB, 100, 'Show Seven S01E01', ep(1, [1]))]),
      grabPost(200, { ok: true }, 1000),
      created({ id: 70, title: 'Just Monitor' }),
    ],
    steps: [
      monitor('admin', 7, 1, { settle: false, wait_for: { method: 'POST', path: '/sonarr/api/v3/release' } }),
      monitor('admin', 7, 1, { name: 'second monitor while the first grab holds its bytes', settle: false }),
      { ...adminAdd({ title: 'Just Monitor', addOptions: SEARCH_OFF }, 'a search-off add is not held back'), settle: false },
      { ...adminAdd({ title: 'Another Show', addOptions: { searchForMissingEpisodes: true } }, 'search add while the grab holds its bytes'), settle: true },
      monitor('admin', 7, 1, { name: 'monitor again once the bytes are released' }),
    ],
  },

  // --- season monitor ---
  {
    name: 'season monitor gates and params',
    upstream: [seriesGet(1, { id: 1, title: 'Foo', seasons: [{ seasonNumber: 1, monitored: true }] })],
    steps: [
      monitor('alice', 1, 2),
      monitor('admin', 'abc', 2),
      monitor('admin', 1, 'xx'),
      monitor('admin', 1, -1),
      monitor('admin', 1, 1.5),
      monitor('admin', 0, 1),
      monitor('admin', 1, 9),
      monitor('admin', 1, 1),
    ],
  },
  {
    name: 'season monitor upstream failures',
    upstream: [
      seriesGet(2, { error: 'no such series' }, 404),
      t('GET', '/api/v3/series/42', 200, { id: 42, title: 'Foo', rootFolderPath: '/data/tv', seasons: [{ seasonNumber: 5, monitored: false }] }),
      t('PUT', '/api/v3/series/42', 400, '{"error":"validation failed"}'),
      seriesGet(99, { id: 99, title: 'LowSpace', rootFolderPath: '/data/tiny', seasons: [{ seasonNumber: 3, monitored: false }] }),
      seriesGet(55, { id: 55, title: 'NoSpace', rootFolderPath: '/data/mystery', seasons: [{ seasonNumber: 1, monitored: false }] }),
      seriesGet(66, { id: 66, title: 'Elsewhere', rootFolderPath: '/data/gone', seasons: [{ seasonNumber: 1, monitored: false }] }),
      t('GET', '/api/v3/rootfolder', 200, [
        { id: 1, path: '/data/tv', freeSpace: FREE },
        { id: 2, path: '/data/tiny', freeSpace: 5 * GB },
        { id: 3, path: '/data/mystery' },
      ]),
    ],
    steps: [monitor('admin', 2, 2), monitor('admin', 42, 5), monitor('admin', 99, 3), monitor('admin', 55, 1), monitor('admin', 66, 1)],
  },
  {
    name: 'season monitor rootfolder unreachable',
    upstream: [show7(), t('GET', '/api/v3/rootfolder', 503, 'busy')],
    steps: [monitor('admin', 7, 1)],
  },
  {
    name: 'season monitor flips one season and grabs it',
    upstream: [
      seriesGet(8, { id: 8, title: 'New Season', rootFolderPath: '/data/tv', monitored: false, seasons: [{ seasonNumber: 4, monitored: true }, { seasonNumber: 5, monitored: false, statistics: { episodeCount: 2 } }] }),
      rootfolder(FREE),
      seriesPut(8, 202, { id: 8 }),
      episodes(8, { 4: 10, 5: 2 }),
      releases(8, 5, [rel('s5', 8 * GB, 100, 'New Season S05 1080p', pack(5))]),
      grabPost(),
    ],
    steps: [monitor('admin', 8, 5)],
  },
  {
    name: 'season 0 (specials) can be monitored',
    upstream: [
      seriesGet(9, { id: 9, title: 'Specials', rootFolderPath: '/data/tv', seasons: [{ seasonNumber: 0, monitored: false }] }),
      rootfolder(FREE),
      seriesPut(9),
      episodes(9, { 0: 1 }),
      releases(9, 0, []),
    ],
    steps: [monitor('admin', 9, 0)],
  },

  // --- clear stuck ---
  {
    name: 'clear-stuck removes import-jammed records',
    upstream: [
      t('GET', '/api/v3/queue', 200, {
        records: [
          { id: 1, trackedDownloadState: 'importBlocked' },
          { id: 2, trackedDownloadState: 'downloading' },
          { id: 3, trackedDownloadState: 'importPending' },
        ],
      }),
      t('DELETE', '/api/v3/queue/bulk', 200, {}),
    ],
    steps: [send('alice', 'POST', '/api/sonarr/api/v3/queue/clear-stuck', {}), send('admin', 'POST', '/api/sonarr/api/v3/queue/clear-stuck', {})],
  },
  {
    name: 'clear-stuck with nothing jammed',
    upstream: [t('GET', '/api/v3/queue', 200, { records: [{ id: 1, trackedDownloadState: 'downloading' }] })],
    steps: [send('admin', 'POST', '/api/sonarr/api/v3/queue/clear-stuck', {})],
  },
  { name: 'clear-stuck queue unreachable', upstream: [t('GET', '/api/v3/queue', 502, { error: 'boom' })], steps: [send('admin', 'POST', '/api/sonarr/api/v3/queue/clear-stuck', {})] },
  {
    name: 'clear-stuck bulk delete failed',
    upstream: [t('GET', '/api/v3/queue', 200, { records: [{ id: 7, trackedDownloadState: 'importBlocked' }] }), t('DELETE', '/api/v3/queue/bulk', 500, { error: 'nope' })],
    steps: [send('admin', 'POST', '/api/sonarr/api/v3/queue/clear-stuck', {})],
  },

  // --- S1 command ---
  {
    name: 'S1 command',
    upstream: [t('POST', '/api/v3/command', 201, { id: 7, name: 'RefreshSeries', status: 'queued', extra: 'x' })],
    steps: [
      send('alice', 'POST', '/api/sonarr/api/v3/command', { name: 'RefreshSeries', seriesId: 1 }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'Backup', seriesId: 1 }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'EpisodeSearch' }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'EpisodeSearch', episodeIds: [] }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'EpisodeSearch', episodeIds: [5, 6], seriesId: 1 }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'RefreshSeries', seriesId: 42, evil: 'rm -rf' }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'SeriesSearch' }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'RenameFiles', seriesId: 42 }),
      send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'RenameFiles', seriesId: 42, files: [1, 2], other: true }),
      { name: 'non-json command', as: 'admin', method: 'POST', path: '/api/sonarr/api/v3/command', raw: '{not valid json' },
    ],
  },
  { name: 'S1 command failed', upstream: [t('POST', '/api/v3/command', 500, { error: 'nope' })], steps: [send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'SeriesSearch', seriesId: 3 })] },
  { name: 'S1 non-json ack', upstream: [t('POST', '/api/v3/command', 200, 'not json')], steps: [send('admin', 'POST', '/api/sonarr/api/v3/command', { name: 'RefreshSeries', seriesId: 1 })] },

  // --- S2 interactive search ---
  {
    name: 'S2 interactive search',
    upstream: [
      t('GET', '/api/v3/episode', 200, Array.from({ length: 6 }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1 })).concat([{ seasonNumber: 'x', episodeNumber: 1 } as never]), { query: { seriesId: '5' } }),
      t('GET', '/api/v3/release', 200, [
        {
          guid: 'big', indexerId: 1, title: 'Big Ep', size: 12 * GB, qualityWeight: 80, seasonNumber: 1, episodeNumbers: [1],
          protocol: 'usenet', indexer: 'Eweka', quality: { quality: { name: 'WEBDL-2160p' } }, languages: [{ name: 'English' }], rejected: false, rejections: [],
        },
        {
          guid: 'small', indexerId: 1, title: 'Small Ep', size: 3 * GB, qualityWeight: 40, seasonNumber: 1, episodeNumbers: [2],
          protocol: 'usenet', quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }], rejected: false, rejections: [],
        },
        {
          guid: 'pack', indexerId: 1, title: 'Full Season', size: 24 * GB, qualityWeight: 60, seasonNumber: 1, fullSeason: true,
          protocol: 'usenet', quality: { quality: { name: 'WEBDL-1080p' } }, languages: [{ name: 'English' }], rejected: false, rejections: [],
        },
        { guid: 'pack-big', indexerId: 1, title: 'Full Season 4K', size: 40 * GB, qualityWeight: 90, seasonNumber: 1, fullSeason: true },
        { guid: 'pack-s9', indexerId: 1, title: 'Unknown Season Pack', size: 400 * GB, seasonNumber: 9, fullSeason: true, age: 2 },
        { guid: 'multi', indexerId: 2, title: 'Two Eps', size: 11 * GB, seasonNumber: 1, episodeNumbers: [3, 4], temporarilyRejected: true, rejections: ['held'] },
      ], { query: { seriesId: '5', seasonNumber: '1' } }),
      t('GET', '/api/v3/release', 200, [{ guid: 'rss', indexerId: 3, title: 'RSS item', size: 1 * GB }], { query: { seriesId: '5' } }),
    ],
    steps: [
      get('alice', '/api/sonarr/api/v3/release?seriesId=1'),
      get('admin', '/api/sonarr/api/v3/release?seriesId=0'),
      get('admin', '/api/sonarr/api/v3/release'),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber=-1'),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber=abc'),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber=1'),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber='),
      get('admin', '/api/sonarr/api/v3/release?seriesId=5'),
    ],
  },
  {
    name: 'S2 search failed',
    upstream: [t('GET', '/api/v3/episode', 200, []), t('GET', '/api/v3/release', 500, '{"error":"boom"}')],
    steps: [get('admin', '/api/sonarr/api/v3/release?seriesId=5')],
  },
  {
    name: 'S2 non-json releases, refused episodes',
    upstream: [t('GET', '/api/v3/episode', 500, 'no'), t('GET', '/api/v3/release', 200, '<<garbage not json>>')],
    steps: [get('admin', '/api/sonarr/api/v3/release?seriesId=5')],
  },

  // --- S3 interactive grab ---
  {
    name: 'S3 interactive grab',
    upstream: [
      t('GET', '/api/v3/episode', 200, [{ seasonNumber: 1, episodeNumber: 1 }, { seasonNumber: 1, episodeNumber: 2 }], { query: { seriesId: '5' } }),
      t('GET', '/api/v3/release', 200, [
        { guid: 'pick', indexerId: 9, title: 'Picked Release', size: 3 * GB, qualityWeight: 50, seasonNumber: 1, episodeNumbers: [1], protocol: 'usenet' },
        { guid: 'huge', indexerId: 9, title: 'Huge', size: 30 * GB, qualityWeight: 50, seasonNumber: 1, episodeNumbers: [1] },
        { guid: 'pack', indexerId: 9, title: 'Season Pack', size: 9 * GB, qualityWeight: 60, seasonNumber: 1, fullSeason: true },
        { guid: 'noweight', indexerId: 9, size: 1 * GB },
      ], { query: { seriesId: '5' } }),
      t('POST', '/api/v3/release', 200, { ok: true }),
    ],
    steps: [
      send('alice', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'pick', indexerId: 9 }),
      { name: 'non-json grab', as: 'admin', method: 'POST', path: '/api/sonarr/api/v3/release?seriesId=5', raw: 'definitely-not-json' },
      send('admin', 'POST', '/api/sonarr/api/v3/release', { guid: 'pick', indexerId: 9 }, 'no seriesId'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'pick', indexerId: 9 }, 'within cap'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'huge', indexerId: 9 }, 'over cap'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'huge', indexerId: 9, allowOverCap: true }, 'over cap allowed'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'pack', indexerId: 9 }, 'pack judged per season'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'noweight', indexerId: 9 }, 'untitled release'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'ghost', indexerId: 9 }, 'not found'),
      send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber=zz', { guid: 'pick', indexerId: 9 }, 'bad season dropped'),
    ],
  },
  {
    name: 'S3 grab failed',
    upstream: [
      t('GET', '/api/v3/episode', 200, [{ seasonNumber: 1, episodeNumber: 1 }]),
      t('GET', '/api/v3/release', 200, [{ guid: 'pick', indexerId: 9, title: 'Picked Release', size: 3 * GB, qualityWeight: 50, seasonNumber: 1, episodeNumbers: [1] }]),
      t('POST', '/api/v3/release', 500, { error: 'x' }),
    ],
    steps: [send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5&seasonNumber=1', { guid: 'pick', indexerId: 9 })],
  },
  {
    name: 'S3 release list failed',
    upstream: [t('GET', '/api/v3/episode', 200, []), t('GET', '/api/v3/release', 500, { error: 'x' })],
    steps: [send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'pick', indexerId: 9 })],
  },
  {
    name: 'S3 non-json release list',
    upstream: [t('GET', '/api/v3/episode', 200, []), t('GET', '/api/v3/release', 200, '<<garbage>>')],
    steps: [send('admin', 'POST', '/api/sonarr/api/v3/release?seriesId=5', { guid: 'g', indexerId: 1 })],
  },

  // --- S4 rename, S5 episode monitor, S6 history ---
  {
    name: 'S4 rename preview',
    upstream: [t('GET', '/api/v3/rename', 200, [{ episodeFileId: 1, seasonNumber: 1, existingPath: '/old/a.mkv', newPath: '/new/a.mkv', extra: 'drop' }, {}], { query: { seriesId: '5' } })],
    steps: [
      get('alice', '/api/sonarr/api/v3/rename?seriesId=1'),
      get('admin', '/api/sonarr/api/v3/rename?seriesId=0'),
      get('admin', '/api/sonarr/api/v3/rename?seriesId=5'),
    ],
  },
  { name: 'S4 rename failed', upstream: [t('GET', '/api/v3/rename', 500, { error: 'boom' })], steps: [get('admin', '/api/sonarr/api/v3/rename?seriesId=5')] },
  { name: 'S4 non-json rename', upstream: [t('GET', '/api/v3/rename', 200, '<<garbage>>')], steps: [get('admin', '/api/sonarr/api/v3/rename?seriesId=7')] },
  {
    name: 'S5 episode monitor',
    upstream: [t('PUT', '/api/v3/episode/monitor', 202, [])],
    steps: [
      send('alice', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: [1], monitored: true }),
      send('admin', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: [], monitored: true }),
      send('admin', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: [1] }),
      send('admin', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: ['1', 1.5, 2 ** 60], monitored: true }, 'no safe-integer ids'),
      { name: 'non-json monitor', as: 'admin', method: 'PUT', path: '/api/sonarr/api/v3/episode/monitor', raw: 'not-json' },
      send('admin', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: [10, 'x', 11, 12.5, 12], monitored: false }),
    ],
  },
  {
    name: 'S5 episode monitor failed',
    upstream: [t('PUT', '/api/v3/episode/monitor', 500, '{"error":"no"}')],
    steps: [send('admin', 'PUT', '/api/sonarr/api/v3/episode/monitor', { episodeIds: [1, 2], monitored: true })],
  },
  {
    name: 'S6 history',
    upstream: [
      t('GET', '/api/v3/history/series', 200, {
        records: [
          { date: '2026-06-01T00:00:00Z', eventType: 'grabbed', sourceTitle: 'old', quality: { quality: { name: 'WEBDL-1080p' } } },
          { date: '2026-06-22T00:00:00Z', eventType: 'grabbed', sourceTitle: 'S01E01', quality: { quality: { name: 'WEBDL-1080p' } }, seasonNumber: 1, episodeId: 5 },
          { date: '2026-06-10T00:00:00Z', eventType: 'downloadFolderImported', sourceTitle: 'mid', quality: { quality: { name: 'WEBDL-1080p' } } },
          { date: 'bad', eventType: 'grabbed', sourceTitle: 'undated' },
        ],
      }, { query: { seriesId: '5' } }),
    ],
    steps: [
      get('alice', '/api/sonarr/api/v3/history/series?seriesId=1'),
      get('admin', '/api/sonarr/api/v3/history/series?seriesId=x'),
      get('admin', '/api/sonarr/api/v3/history/series?seriesId=5'),
    ],
  },
  { name: 'S6 history failed', upstream: [t('GET', '/api/v3/history/series', 503, { error: 'boom' })], steps: [get('admin', '/api/sonarr/api/v3/history/series?seriesId=5')] },
  { name: 'S6 non-json history', upstream: [t('GET', '/api/v3/history/series', 200, '<<garbage>>')], steps: [get('admin', '/api/sonarr/api/v3/history/series?seriesId=7')] },

  // --- S7 edit ---
  {
    name: 'S7 edit overlays only the allowlist',
    upstream: [
      t('GET', '/api/v3/series/5', 200, {
        id: 5, title: 'Existing', monitored: true, qualityProfileId: 1,
        rootFolderPath: '/data/tv', path: '/data/tv/Existing', seasons: [{ seasonNumber: 1, monitored: true }],
      }),
      t('PUT', '/api/v3/series/5', 202, { id: 5, accepted: true }),
    ],
    steps: [
      send('alice', 'PUT', '/api/sonarr/api/v3/series/5', { monitored: false }),
      send('admin', 'PUT', '/api/sonarr/api/v3/series/5', {
        monitored: false, qualityProfileId: 7, rootFolderPath: '/data/tv2', title: 'HACKED', path: '/etc/passwd', id: 999, seasons: [],
      }),
      send('admin', 'PUT', '/api/sonarr/api/v3/series/5', { monitored: 'yes', qualityProfileId: '7', rootFolderPath: '' }, 'wrong types dropped'),
      { name: 'non-json patch', as: 'admin', method: 'PUT', path: '/api/sonarr/api/v3/series/5', raw: 'not-json-at-all' },
      send('admin', 'PUT', '/api/sonarr/api/v3/series/0', { monitored: false }),
    ],
  },
  { name: 'S7 lookup failed', upstream: [t('GET', '/api/v3/series/9', 404, '{"error":"no"}')], steps: [send('admin', 'PUT', '/api/sonarr/api/v3/series/9', { monitored: false })] },
  {
    name: 'S7 update failed',
    upstream: [t('GET', '/api/v3/series/9', 200, { id: 9, title: 'X', monitored: true }), t('PUT', '/api/v3/series/9', 400, '{"error":"validation"}', { ct: 'application/json' })],
    steps: [send('admin', 'PUT', '/api/sonarr/api/v3/series/9', { monitored: false })],
  },

  // --- notifications ---
  {
    name: 'notifications gates',
    upstream: [],
    steps: [
      notify(undefined, 'GET'),
      notify('alice', 'GET'),
      notify('alice', 'POST', { webhookUrl: GOOD_WEBHOOK }),
      notify('alice', 'DELETE'),
      notify('alice', 'POST', undefined, '/api/notifications/discord/test'),
      notify('kid', 'GET'),
    ],
  },
  {
    name: 'notifications status',
    upstream: [
      list(t, [conn(7), { id: 1, name: 'Some Other', implementation: 'Discord' }, { id: 2, name: EMERALD, implementation: 'Slack' }, { id: '3', name: EMERALD, implementation: 'Discord' }]),
      list(r, [conn(4)]),
    ],
    steps: [notify('admin', 'GET')],
  },
  { name: 'notifications status, nothing configured', upstream: [list(t, []), list(r, [conn(4)])], steps: [notify('admin', 'GET')] },
  { name: 'notifications status, sonarr list refused', upstream: [list(t, { error: 'boom' }, 500), list(r, [])], steps: [notify('admin', 'GET')] },
  { name: 'notifications status, radarr list refused', upstream: [list(t, [conn(7)]), list(r, 'down', 503)], steps: [notify('admin', 'GET')] },
  {
    name: 'notifications POST validation',
    upstream: [],
    steps: [
      { ...notify('admin', 'POST'), name: 'empty object', body: {} },
      { name: 'non-json body', as: 'admin', method: 'POST', path: '/api/notifications/discord', raw: '{not json' },
      configure('https://evil.example.com/api/webhooks/x/y', 'other host'),
      configure('   ', 'whitespace only'),
      configure('http://discord.com/api/webhooks/1/a', 'plain http'),
      configure('https://discord.com.evil.example/api/webhooks/1/a', 'lookalike host'),
      configure('https://discord.com/api/webhookz/1/a', 'wrong path'),
    ],
  },
  {
    name: 'notifications POST refuses without a fresh list',
    upstream: [list(t, { error: 'boom' }, 500), list(r, []), t('POST', '/api/v3/notification', 201, { id: 1 }), r('POST', '/api/v3/notification', 201, { id: 1 })],
    steps: [configure()],
  },
  {
    name: 'notifications POST, radarr list refused',
    upstream: [list(t, []), list(r, { error: 'radarr down' }, 500), t('POST', '/api/v3/notification', 201, { id: 1 })],
    steps: [configure()],
  },
  {
    name: 'notifications create on both sides',
    upstream: [list(t, []), list(r, []), t('POST', '/api/v3/notification', 201, { id: 50 }), r('POST', '/api/v3/notification', 201, { id: 51 })],
    steps: [configure(), configure('  https://discordapp.com/api/webhooks/9/z  ', 'discordapp host, trimmed')],
  },
  {
    name: 'notifications update in place',
    upstream: [list(t, [conn(100, { fields: [] })]), list(r, [conn(200)]), t('PUT', '/api/v3/notification/100', 200, {}), r('PUT', '/api/v3/notification/200', 200, {})],
    steps: [configure()],
  },
  {
    name: 'notifications sonarr update fails, nothing created',
    upstream: [list(t, [conn(100)]), list(r, [conn(200)]), t('PUT', '/api/v3/notification/100', 500, 'sonarr-down'), t('POST', '/api/v3/notification', 201, { id: 999 })],
    steps: [configure()],
  },
  {
    name: 'notifications radarr update fails after sonarr updated',
    upstream: [list(t, [conn(100, { tags: [1] })]), list(r, [conn(200)]), t('PUT', '/api/v3/notification/100', 200, {}), r('PUT', '/api/v3/notification/200', 500, 'x'.repeat(450))],
    steps: [configure()],
  },
  {
    name: 'notifications sonarr create fails',
    upstream: [list(t, []), list(r, []), t('POST', '/api/v3/notification', 500, 'upstream boom')],
    steps: [configure()],
  },
  {
    name: 'notifications radarr create fails, sonarr create rolled back',
    upstream: [list(t, []), list(r, []), t('POST', '/api/v3/notification', 201, { id: 50 }), r('POST', '/api/v3/notification', 500, 'radarr boom'), t('DELETE', '/api/v3/notification/50', 200, {})],
    steps: [configure()],
  },
  {
    name: 'notifications rollback failure is reported',
    upstream: [list(t, []), list(r, []), t('POST', '/api/v3/notification', 201, { id: 50 }), r('POST', '/api/v3/notification', 502, 'radarr down'), t('DELETE', '/api/v3/notification/50', 500, 'rollback delete boom')],
    steps: [configure()],
  },
  {
    name: 'notifications create ack without an id',
    upstream: [list(t, []), list(r, []), t('POST', '/api/v3/notification', 201, 'created'), r('POST', '/api/v3/notification', 500, 'radarr boom')],
    steps: [configure()],
  },
  {
    name: 'notifications extras are deleted',
    upstream: [
      list(t, [conn(100), conn(101), conn(102)]),
      list(r, [conn(200)]),
      t('PUT', '/api/v3/notification/100', 200, {}),
      r('PUT', '/api/v3/notification/200', 200, {}),
      t('DELETE', '/api/v3/notification/101', 200, {}),
      t('DELETE', '/api/v3/notification/102', 200, {}),
    ],
    steps: [configure()],
  },
  {
    name: 'notifications extras cleanup failure rolls the update back',
    upstream: [
      list(t, [conn(100, { fields: [{ name: 'webHookUrl', value: 'https://discord.com/api/webhooks/old/x' }] }), conn(101)]),
      list(r, []),
      t('PUT', '/api/v3/notification/100', 200, {}),
      t('DELETE', '/api/v3/notification/101', 500, 'delete boom'),
    ],
    steps: [configure()],
  },
  {
    name: 'notifications DELETE',
    upstream: [list(t, [conn(7)]), list(r, [conn(8), conn(9)]), t('DELETE', '/api/v3/notification/7', 200, {}), r('DELETE', '/api/v3/notification/8', 200, {}), r('DELETE', '/api/v3/notification/9', 200, {})],
    steps: [notify('admin', 'DELETE')],
  },
  { name: 'notifications DELETE, nothing there', upstream: [list(t, []), list(r, [])], steps: [notify('admin', 'DELETE')] },
  {
    name: 'notifications DELETE, radarr list refused',
    upstream: [list(t, [conn(7)]), list(r, { error: 'radarr down' }, 500), t('DELETE', '/api/v3/notification/7', 200, {})],
    steps: [notify('admin', 'DELETE')],
  },
  {
    name: 'notifications DELETE, partial failure',
    upstream: [list(t, [conn(7)]), list(r, [conn(8)]), t('DELETE', '/api/v3/notification/7', 200, {}), r('DELETE', '/api/v3/notification/8', 500, 'boom')],
    steps: [notify('admin', 'DELETE')],
  },
  {
    name: 'notifications DELETE, total failure',
    upstream: [list(t, [conn(7)]), list(r, [conn(8)]), t('DELETE', '/api/v3/notification/7', 500, 'boom'), r('DELETE', '/api/v3/notification/8', 404, 'gone')],
    steps: [notify('admin', 'DELETE')],
  },
  { name: 'notifications test, not configured', upstream: [list(t, [])], steps: [notify('admin', 'POST', undefined, '/api/notifications/discord/test')] },
  {
    name: 'notifications test',
    upstream: [list(t, [conn(7)]), t('POST', '/api/v3/notification/7/test', 200, {})],
    steps: [notify('admin', 'POST', undefined, '/api/notifications/discord/test')],
  },
  {
    name: 'notifications test failed',
    upstream: [list(t, [conn(7)]), t('POST', '/api/v3/notification/7/test', 400, 'webhook unreachable')],
    steps: [notify('admin', 'POST', undefined, '/api/notifications/discord/test')],
  },
  { name: 'notifications test, list refused', upstream: [list(t, 'busy', 503)], steps: [notify('admin', 'POST', undefined, '/api/notifications/discord/test')] },
]

// --- the fake upstream ----------------------------------------------------------------

type Call = { method: string; path: string; query: string; body: unknown; key_header: string | null; secret: string | null; bearer: boolean }
const calls: Call[] = []
let routes: Route[] = []
let open = 0
const fake = http.createServer((req, res) => {
  open++
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
    const answer = () => {
      open--
      if (hit) {
        res.writeHead(hit.status, { 'content-type': hit.ct })
        return res.end(hit.text)
      }
      const rec = url.pathname.startsWith('/rec/')
      res.writeHead(rec ? 200 : 404, { 'content-type': 'application/json' })
      res.end(rec ? '{}' : '{"error":"no fixture"}')
    }
    if (hit?.delay_ms) setTimeout(answer, hit.delay_ms)
    else answer()
  })
})
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

/** No new call for 100 ms. */
async function quiet(): Promise<void> {
  let seen = -1
  while (calls.length !== seen) {
    seen = calls.length
    await sleep(100)
  }
}

// --- the TS app ------------------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonarr-goldens-'))
fs.writeFileSync(path.join(dir, 'policies.json'), POLICIES)
Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  SONARR_URL: `${fakeUrl}/sonarr`,
  RADARR_URL: `${fakeUrl}/radarr`,
  RECOMMENDER_URL: `${fakeUrl}/rec`,
  USER_POLICIES_PATH: path.join(dir, 'policies.json'),
  USER_FEEDBACK_PATH: path.join(dir, 'feedback.json'),
  REJECTIONS_PATH: path.join(dir, 'rejections.json'),
  USER_WATCHLIST_PATH: path.join(dir, 'watchlist.json'),
  GRAB_LOG_PATH: path.join(dir, 'grabs.jsonl'),
})
delete process.env.NODE_ENV
process.chdir(dir)

// The TV grab's settles (2 s, then 1.5 s per episode poll) run at once.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
  realSetTimeout(fn, ms === 2000 || ms === 1500 ? 0 : ms, ...args)) as typeof setTimeout

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(fakeUrl)) throw new Error(`gen-sonarr-goldens: no network (${url})`)
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
  ['SONARR_API_KEY', 'sonarrApiKey'],
  ['RADARR_API_KEY', 'radarrApiKey'],
  ['DEFAULT_SONARR_ROOT_FOLDER_PATH', 'defaultSonarrRootFolderPath'],
])
const normTs = (line: string) => line.replace(/"ts":"[^"]*"/, '"ts":"<ts>"')
const normBody = (text: string) => text.replace(/"retry_after_ms":\d+/g, '"retry_after_ms":"<ms>"')
const spawnsGrab = (st: Step) =>
  (st.method ?? 'GET') === 'POST' && (st.path === '/api/sonarr/api/v3/series' || /\/seasons\/[^/]+\/monitor$/.test(st.path))

const out = []
let n = 0
for (const sc of SCENARIOS) {
  __resetRateLimitsForTests()
  const grabPath = path.join(dir, `grabs-${n++}.jsonl`)
  _setGrabLogPathForTests(grabPath)
  const grabText = () => (fs.existsSync(grabPath) ? fs.readFileSync(grabPath, 'utf8') : '')
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
    const before = grabText()
    const statuses: number[] = []
    let res!: Response
    for (let i = 0; i < (st.repeat ?? 1); i++) {
      res = await app.request(new Request(`http://localhost${st.path}`, { method, headers, body }))
      statuses.push(res.status)
      if (i + 1 < (st.repeat ?? 1)) await res.text()
    }
    const text = await res.text()
    if (st.wait_for) {
      const want = st.wait_for
      for (let i = 0; !calls.some((c) => c.method === want.method && c.path === want.path); i++) {
        if (i > 200) throw new Error(`${sc.name} / ${st.name}: never saw ${want.method} ${want.path}`)
        await sleep(10)
      }
    }
    const settle = st.settle ?? spawnsGrab(st)
    if (settle) {
      for (;;) {
        await quiet()
        const [seen, size] = [calls.length, grabText().length]
        await sleep(150)
        if (open === 0 && calls.length === seen && grabText().length === size) break
      }
    }
    const after = grabText()
    const { body: _b, raw: _r, ...rest } = st
    steps.push({
      ...rest,
      settle,
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
  out.push({ name: sc.name, env: sc.env ?? {}, upstream: sc.upstream, grabs_seed: null, steps })
}

console.log = log
fake.close()
fs.writeFileSync(
  path.join(here, 'sonarr-goldens.json'),
  JSON.stringify({ env: ENV, members: MEMBERS, policies: POLICIES, scenarios: out }, null, 2) + '\n',
)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
