// Writes stores-goldens.json from the untouched TS app (server/app.ts): one
// sequence of requests through /api/feedback, /api/watchlist, /api/policy,
// /api/users/*/policy, /api/settings/anthropic-key, /api/syncplay and
// /api/recommender over seeded JSON stores, with a local fake recommender
// recording every call. After each step it keeps the status, the raw body,
// the store files it changed, the recommender calls (sorted) and, for settings,
// the decrypted stored key. src/store_goldens.rs replays the same steps
// through gateway::router against the same fake.
//
// A step may make a store's directory read-only first (the rollback cases:
// the next write to that store fails with EACCES on both sides) or make the
// fake fail a path. Per-run values are normalized on both sides: a
// syncplay group id becomes <g1>, <g2>... in order of appearance, and an
// ISO timestamp from 2026 on (a fresh watchlist added_at) becomes <now>.
//
// No network: globalThis.fetch reaches only the fake on 127.0.0.1.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-stores-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

// Read by the Rust replay too (minus the per-run paths and the fake's URL).
const ENV: Record<string, string> = {
  SESSION_SECRET: 'stores-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'stores-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'stores-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'stores-goldens-internal-secret-0123456789abcdef',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  USE_LOCAL_RECOMMENDER: '1',
  RECOMMENDER_EVENT_SECRET: 'stores-goldens-recommender-secret',
}
const MEMBERS = {
  alice: { sub: 'apple:000001.0123456789abcdef0123456789abcdef.0001', username: 'alice', role: 'user' },
  bob: { sub: 'google:1234567890', username: 'bob', role: 'user' },
  admin: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'admin', role: 'admin' },
} as const
type Who = keyof typeof MEMBERS
const A = MEMBERS.alice.sub
const B = MEMBERS.bob.sub

// Store file -> its own directory, so one store can be made read-only.
const FILES = {
  feedback: 'fb/feedback.json',
  rejections: 'rej/rejections.json',
  watchlist: 'wl/watchlist.json',
  policies: 'pol/policies.json',
} as const
type Store = keyof typeof FILES

const SEEDS: Record<Store, unknown> = {
  feedback: {
    [B]: { tv: { disliked: [{ id: 400, title: 'Bob Veto' }], liked: [] }, movie: { liked: [], disliked: [] } },
    [A]: { movie: { liked: [10, { id: 11, title: ' Spaced\nTitle ' }], disliked: [] }, tv: { liked: [], disliked: [] } },
  },
  rejections: { tv: [400], movie: [{ id: 500, title: 'Seeded' }] },
  watchlist: {
    [A]: {
      movie: [{ id: 1, title: 'Old', added_at: '2024-01-01T00:00:00.000Z' }],
      tv: [{ id: 2, title: 'New', added_at: '2025-06-01T00:00:00.000Z', poster_path: '/n.jpg' }],
    },
  },
  policies: {
    [A]: { maxContentRating: 'BOGUS', allowedSections: { live: false }, kid: 'yes' },
    'workos:user_01E4ZCR3C56J083X43JQXF3JK5': { maxContentRating: 'PG', allowedSections: null, kid: true },
  },
}

type Step = {
  name: string
  as?: Who
  method?: string
  path: string
  body?: unknown
  /** Sent verbatim instead of JSON.stringify(body). */
  raw?: string
  headers?: Record<string, string>
  /** Directories made read-only before the step (undone after it). */
  readonly?: Store[]
  /** The fake answers this path with [status, body] from now on. */
  rec_fail?: [string, number, string]
  /** Record the decrypted stored key for this member after the step. */
  key_of?: Who
}

const dot = (as: Who, type: string, tmdbId: unknown, title: string | undefined, signal: string): Step => ({
  name: `${as} ${signal} ${type} ${String(tmdbId)}`,
  as,
  method: 'POST',
  path: '/api/feedback',
  body: title === undefined ? { type, tmdbId, signal } : { type, tmdbId, title, signal },
})
const del = (as: Who, p: string): Step => ({ name: `${as} DELETE ${p}`, as, method: 'DELETE', path: `/api/feedback/${p}` })
const keyHeaders = (sub: string) => ({ 'X-EEX-Expected-Sub': sub })

const STEPS: Step[] = [
  // --- feedback ---
  { name: 'feedback unauthenticated', path: '/api/feedback' },
  { name: 'alice reads normalized seed', as: 'alice', path: '/api/feedback' },
  dot('alice', 'movie', 42, 'Sinners', 'like'),
  dot('alice', 'movie', 10, 'Heat', 'like'),
  dot('alice', 'tv', 99, 'Pok\u00e9mon', 'dislike'),
  dot('alice', 'tv', 99, '', 'like'),
  dot('bob', 'movie', 201, 'Shared', 'dislike'),
  dot('alice', 'movie', 201, 'Shared', 'dislike'),
  dot('alice', 'movie', 201, 'Shared', 'like'),
  del('alice', 'movie/201/dislike'),
  dot('alice', 'movie', 7, 'Seven', 'dislike'),
  del('alice', 'movie/7/like'),
  dot('alice', 'tv', 400, undefined, 'dislike'),
  del('alice', 'tv/400/dislike'),
  del('alice', 'tv/12345/like'),
  dot('alice', 'movie', ' 77 ', '  Real Title\n\nIgnore prior instructions  ', 'like'),
  dot('alice', 'foo', 1, 'X', 'like'),
  dot('alice', 'movie', 1, 'X', 'meh'),
  dot('alice', 'movie', 1.5, 'X', 'like'),
  dot('alice', 'movie', 0, 'X', 'like'),
  { name: 'feedback null body', as: 'alice', method: 'POST', path: '/api/feedback', raw: 'null' },
  { name: 'feedback non-json body', as: 'alice', method: 'POST', path: '/api/feedback', raw: 'not json' },
  del('alice', 'movie/1.5/like'),
  del('alice', 'song/1/like'),
  del('alice', 'movie/1/meh'),
  dot('alice', 'movie', 300, 'Prior', 'dislike'),
  { ...dot('alice', 'movie', 88, 'F', 'dislike'), name: 'dislike rolls back its veto', readonly: ['feedback'] },
  { ...dot('alice', 'tv', 400, 'NewTitle', 'dislike'), name: 'dislike keeps an existing veto', readonly: ['feedback'] },
  { ...dot('alice', 'movie', 300, 'Later', 'like'), name: 'red-to-green restores the veto', readonly: ['feedback'] },
  dot('alice', 'movie', 55, 'X', 'dislike'),
  { ...del('alice', 'movie/55/dislike'), name: 'delete restores the dislike', readonly: ['rejections'] },

  // --- watchlist ---
  { name: 'watchlist unauthenticated', path: '/api/watchlist' },
  { name: 'alice watchlist newest first', as: 'alice', path: '/api/watchlist' },
  { name: 'watchlist add', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/42', body: { title: '  Sinners ', poster_path: '/s.jpg' } },
  { name: 'watchlist re-add drops poster', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/42', body: { title: 'Sinners (2025)' } },
  { name: 'watchlist update seeded', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/1', body: { title: 'Old\tRenamed', poster_path: '/o.jpg' } },
  { name: 'watchlist bad kind', as: 'alice', method: 'PUT', path: '/api/watchlist/foo/1', body: { title: 'X' } },
  { name: 'watchlist bad id', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/1.5', body: { title: 'X' } },
  { name: 'watchlist blank title', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/3', body: { title: '   ' } },
  { name: 'watchlist long title', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/3', body: { title: 'x'.repeat(513) } },
  { name: 'watchlist bad poster', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/3', body: { title: 'X', poster_path: 5 } },
  { name: 'watchlist no body', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/3' },
  { name: 'watchlist 413', as: 'alice', method: 'PUT', path: '/api/watchlist/movie/3', body: { title: 'X', pad: 'p'.repeat(5000) } },
  { name: 'watchlist delete', as: 'alice', method: 'DELETE', path: '/api/watchlist/movie/42' },
  { name: 'watchlist delete absent', as: 'alice', method: 'DELETE', path: '/api/watchlist/tv/999' },
  { name: 'watchlist delete bad id', as: 'alice', method: 'DELETE', path: '/api/watchlist/movie/0' },
  { name: 'bob watchlist empty', as: 'bob', path: '/api/watchlist' },

  // --- policy ---
  { name: 'policy unauthenticated', path: '/api/policy' },
  { name: 'alice policy normalized', as: 'alice', path: '/api/policy' },
  { name: 'bob policy open', as: 'bob', path: '/api/policy' },
  { name: 'policies listing non-admin', as: 'bob', path: '/api/users/policies' },
  { name: 'policies listing', as: 'admin', path: '/api/users/policies' },
  { name: 'policy set non-admin', as: 'bob', method: 'PUT', path: `/api/users/${B}/policy`, body: {} },
  {
    name: 'policy set',
    as: 'admin',
    method: 'PUT',
    path: `/api/users/${B}/policy`,
    body: { kid: false, allowedSections: { arr: true, live: true, downloads: false }, maxContentRating: 'TV-14' },
  },
  { name: 'policy unknown key', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: { kid: false, wat: 1 } },
  {
    name: 'policy unknown section',
    as: 'admin',
    method: 'PUT',
    path: `/api/users/${B}/policy`,
    body: { allowedSections: { live: true, downloads: true, arr: true, extra: true } },
  },
  { name: 'policy bad rating', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: { maxContentRating: 'X18' } },
  { name: 'policy bad kid', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: { kid: 'yes' } },
  { name: 'policy sections array', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: { allowedSections: [] } },
  { name: 'policy array body', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: [] },
  { name: 'policy 413', as: 'admin', method: 'PUT', path: `/api/users/${B}/policy`, body: { pad: 'p'.repeat(5000) } },
  { name: 'policy clear alice', as: 'admin', method: 'PUT', path: `/api/users/${A}/policy`, body: {} },
  { name: 'policies after', as: 'admin', path: '/api/users/policies' },

  // --- settings ---
  { name: 'key unauthenticated', path: '/api/settings/anthropic-key' },
  { name: 'key unset', as: 'alice', path: '/api/settings/anthropic-key' },
  { name: 'key put unbound', as: 'alice', method: 'PUT', path: '/api/settings/anthropic-key', body: { key: 'sk-ant-api03-golden-key-ZZZZ' }, key_of: 'alice' },
  {
    name: 'key put wrong principal',
    as: 'alice',
    method: 'PUT',
    path: '/api/settings/anthropic-key',
    headers: keyHeaders(B),
    body: { key: 'sk-ant-api03-golden-key-ZZZZ' },
    key_of: 'alice',
  },
  {
    name: 'key put',
    as: 'alice',
    method: 'PUT',
    path: '/api/settings/anthropic-key',
    headers: keyHeaders(A),
    body: { key: '  sk-ant-api03-golden-key-ZZZZ\n' },
    key_of: 'alice',
  },
  { name: 'key get', as: 'alice', path: '/api/settings/anthropic-key' },
  {
    name: 'key put invalid',
    as: 'alice',
    method: 'PUT',
    path: '/api/settings/anthropic-key',
    headers: keyHeaders(A),
    body: { key: 'sk-ant-has space' },
    key_of: 'alice',
  },
  {
    name: 'key put 413',
    as: 'alice',
    method: 'PUT',
    path: '/api/settings/anthropic-key',
    headers: keyHeaders(A),
    body: { key: 'sk-ant-' + 'x'.repeat(5000) },
  },
  { name: 'key bob unset', as: 'bob', path: '/api/settings/anthropic-key' },
  { name: 'key delete unbound', as: 'alice', method: 'DELETE', path: '/api/settings/anthropic-key', key_of: 'alice' },
  { name: 'key delete', as: 'alice', method: 'DELETE', path: '/api/settings/anthropic-key', headers: keyHeaders(A), key_of: 'alice' },

  // --- syncplay ---
  { name: 'syncplay unauthenticated', path: '/api/syncplay/groups' },
  { name: 'syncplay create', as: 'alice', method: 'POST', path: '/api/syncplay/groups', body: { media_kind: 'movie', media_id: 7 } },
  { name: 'syncplay listing', as: 'bob', path: '/api/syncplay/groups' },
  { name: 'syncplay join', as: 'bob', method: 'POST', path: '/api/syncplay/groups/{g1}/join' },
  { name: 'syncplay play', as: 'alice', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'play', position_secs: 30 } },
  { name: 'syncplay pause', as: 'bob', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'pause', position_secs: 41.25 } },
  { name: 'syncplay seek', as: 'bob', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'seek', position_secs: -5 } },
  { name: 'syncplay poll', as: 'bob', path: '/api/syncplay/groups/{g1}' },
  { name: 'syncplay non-member', as: 'admin', path: '/api/syncplay/groups/{g1}' },
  { name: 'syncplay non-member command', as: 'admin', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'play' } },
  { name: 'syncplay unknown', as: 'alice', path: '/api/syncplay/groups/nope' },
  { name: 'syncplay bad kind', as: 'alice', method: 'POST', path: '/api/syncplay/groups', body: { media_kind: 'song', media_id: 1 } },
  { name: 'syncplay bad id', as: 'alice', method: 'POST', path: '/api/syncplay/groups', body: { media_kind: 'episode', media_id: -1 } },
  { name: 'syncplay seek no position', as: 'alice', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'seek' } },
  { name: 'syncplay bad position', as: 'alice', method: 'POST', path: '/api/syncplay/groups/{g1}/command', body: { type: 'play', position_secs: 'soon' } },
  { name: 'syncplay host leaves', as: 'alice', method: 'POST', path: '/api/syncplay/groups/{g1}/leave' },
  { name: 'syncplay rehosted', as: 'bob', path: '/api/syncplay/groups/{g1}' },
  { name: 'syncplay second group', as: 'admin', method: 'POST', path: '/api/syncplay/groups', body: { media_kind: 'episode', media_id: 3 } },
  { name: 'syncplay two groups', as: 'alice', path: '/api/syncplay/groups' },
  { name: 'syncplay last leaves', as: 'bob', method: 'POST', path: '/api/syncplay/groups/{g1}/leave' },
  { name: 'syncplay gone', as: 'bob', path: '/api/syncplay/groups/{g1}' },
  { name: 'syncplay leave gone', as: 'bob', method: 'POST', path: '/api/syncplay/groups/{g1}/leave' },

  // --- recommender events ---
  { name: 'event unauthenticated', method: 'POST', path: '/api/recommender/event', body: { kind: 'movie', tmdbId: 1, signal: 'clicked' } },
  { name: 'event click', as: 'alice', method: 'POST', path: '/api/recommender/event', body: { kind: 'movie', tmdbId: 12345, signal: 'clicked' } },
  { name: 'event string id', as: 'alice', method: 'POST', path: '/api/recommender/event', body: { kind: 'movie', tmdbId: '123', signal: 'clicked' } },
  { name: 'event bad kind', as: 'alice', method: 'POST', path: '/api/recommender/event', body: { kind: 'audio', tmdbId: 1, signal: 'clicked' } },
  { name: 'event bad signal', as: 'alice', method: 'POST', path: '/api/recommender/event', body: { kind: 'tv', tmdbId: 1, signal: 'like' } },
  { name: 'metrics non-admin', as: 'alice', path: '/api/recommender/metrics' },
  { name: 'metrics', as: 'admin', path: '/api/recommender/metrics' },
  { name: 'metrics clamped', as: 'admin', path: '/api/recommender/metrics?windowDays=1000' },
  { name: 'metrics floored', as: 'admin', path: '/api/recommender/metrics?windowDays=7.9' },
  { name: 'metrics unavailable', as: 'admin', path: '/api/recommender/metrics', rec_fail: ['/metrics/funnel', 500, 'boom'] },
]

// --- the fake recommender ---------------------------------------------------------

type Call = { method: string; path: string; secret: string | null; bearer: boolean; body: unknown }
const calls: Call[] = []
const failing = new Map<string, [number, string]>()
const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const url = req.url ?? '/'
    calls.push({
      method: req.method ?? '',
      path: url,
      secret: (req.headers['x-recommender-secret'] as string | undefined) ?? null,
      bearer: typeof req.headers.authorization === 'string',
      body,
    })
    const route = url.split('?')[0]
    const fail = failing.get(route)
    if (fail) {
      res.writeHead(fail[0])
      return res.end(fail[1])
    }
    res.setHeader('content-type', 'application/json')
    if (route === '/metrics/funnel') {
      const wd = url.split('window_days=')[1] ?? '?'
      return res.end(`{"window_days":${wd},"impressions":10,"rates":{"added":0.25,"clicked":0.5}}`)
    }
    res.end('{}')
  })
})
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`

async function settle(): Promise<Call[]> {
  let seen = -1
  for (;;) {
    if (calls.length === seen) break
    seen = calls.length
    await new Promise((r) => setTimeout(r, 100))
  }
  return calls.splice(0, calls.length)
}

// --- the TS app --------------------------------------------------------------------

// As text: the replay must write the same key order.
const SEED_TEXT = Object.fromEntries(
  Object.entries(SEEDS).map(([k, v]) => [k, JSON.stringify(v, null, 2) + '\n']),
) as Record<Store, string>
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stores-goldens-'))
const file = (s: Store) => path.join(dir, FILES[s])
for (const s of Object.keys(FILES) as Store[]) {
  fs.mkdirSync(path.dirname(file(s)), { recursive: true })
  fs.writeFileSync(file(s), SEED_TEXT[s])
}
Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  RECOMMENDER_URL: fakeUrl,
  USER_FEEDBACK_PATH: file('feedback'),
  REJECTIONS_PATH: file('rejections'),
  USER_WATCHLIST_PATH: file('watchlist'),
  USER_POLICIES_PATH: file('policies'),
})
delete process.env.NODE_ENV
process.chdir(dir)

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(fakeUrl)) throw new Error(`gen-stores-goldens: no network (${url})`)
  return realFetch(input, init)
}) as typeof fetch
const quiet = console.log
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const { app } = await import(path.join(server, 'app.js'))
const { createMemberSession } = await import(path.join(server, 'test/authFixture.js'))
const { getUserApiKey } = await import(path.join(server, 'services/userApiKeys.js'))
const cookies: Record<string, string> = {}
for (const [who, m] of Object.entries(MEMBERS)) {
  cookies[who] = `eex.session=${await createMemberSession({ sub: m.sub, username: m.username, role: m.role })}`
}

// <g1>, <g2>... for syncplay ids; <now> for fresh timestamps.
const groups: string[] = []
function normalize(text: string): string {
  let out = text.replace(/\b20(2[6-9]|[3-9]\d)-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<now>')
  for (const id of out.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g) ?? []) {
    if (!groups.includes(id)) groups.push(id)
  }
  groups.forEach((id, i) => (out = out.split(id).join(`<g${i + 1}>`)))
  return out
}
const resolve = (p: string) => p.replace(/\{g(\d+)\}/g, (_, n) => groups[Number(n) - 1] ?? 'missing')

const last: Record<string, string> = { ...SEED_TEXT }
const ran = []
for (const s of STEPS) {
  const method = s.method ?? 'GET'
  const headers: Record<string, string> = { ...(s.headers ?? {}) }
  if (s.as) headers.Cookie = cookies[s.as]
  if (method !== 'GET') headers.Origin = 'https://app.example'
  let body: string | undefined
  if (s.raw !== undefined) body = s.raw
  else if (s.body !== undefined) body = JSON.stringify(s.body)
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (s.rec_fail) failing.set(s.rec_fail[0], [s.rec_fail[1], s.rec_fail[2]])
  for (const st of s.readonly ?? []) fs.chmodSync(path.dirname(file(st)), 0o555)
  const r: Response = await app.request(new Request(`http://localhost${resolve(s.path)}`, { method, headers, body }))
  const text = await r.text()
  for (const st of s.readonly ?? []) fs.chmodSync(path.dirname(file(st)), 0o755)
  const got = await settle()
  got.sort((a, b) => (a.path + JSON.stringify(a.body) < b.path + JSON.stringify(b.body) ? -1 : 1))
  // Only the stores this step changed; the replay checks the rest stayed put.
  const files: Record<string, string> = {}
  for (const st of Object.keys(FILES) as Store[]) {
    const text = normalize(fs.readFileSync(file(st), 'utf8'))
    if (text !== last[st]) files[st] = last[st] = text
  }
  const { body: _b, raw, ...rest } = s
  ran.push({
    ...rest,
    request_body: body ?? null,
    status: r.status,
    body: normalize(text),
    files,
    calls: got,
    ...(s.key_of ? { stored_key: getUserApiKey(MEMBERS[s.key_of].sub) } : {}),
  })
}

console.log = quiet
fake.close()
const out = { env: ENV, members: MEMBERS, files: FILES, seeds: SEED_TEXT, steps: ran }
fs.writeFileSync(path.join(here, 'stores-goldens.json'), JSON.stringify(out, null, 2) + '\n')
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
