// Writes edge-goldens.json from the untouched TS app (server/app.ts) under
// fixed test secrets: /api/health, /api/limits with and without a session,
// /api/version, a CORS preflight and a simple CORS read, the security
// headers, the X-Request-Id echo (kept and regenerated), a redacted request
// log line, the /api 404, the 413 body limit (chunked and Content-Length),
// the CSRF reject and the SPA fallback. src/edge_goldens.rs replays every
// scenario through gateway::router and applies its documented deltas.
//
// No network: globalThis.fetch throws for every host (no S1 scenario calls
// out). The session cookie is minted per run on both sides (a committed one
// would expire), so the scenario only names it.
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-gateway-goldens.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

// Read by the Rust replay too (minus the per-run paths).
const ENV: Record<string, string> = {
  SESSION_SECRET: 'gateway-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'gateway-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'gateway-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'gateway-goldens-internal-secret-0123456789abcdef',
  ADMIN_SUBS: 'workos:user_01E4ZCR3C56J083X43JQXF3JK5',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '1',
  SONARR_API_KEY: 'golden-sonarr-key',
  DEFAULT_SONARR_ROOT_FOLDER_PATH: '/tv',
  DEFAULT_ROOT_FOLDER_PATH: '/media',
  USE_MEDIA_CORE: '1',
  MUSIC_LIBRARY_PATHS: '/music',
  DVR_ENABLED: '1',
  MIN_FREE_GB: '50',
  MAX_MOVIE_SIZE_GB: '12.5',
  DEFAULT_PROFILE_NAME: 'Choose Me',
  EEX_RELEASE: 'golden-sha',
  APPLE_CLIENT_ID: 'com.example.app',
  WORKOS_CLIENT_ID: 'client_golden',
  WORKOS_API_KEY: 'sk_golden',
  WORKOS_REDIRECT_URI: 'https://api.example/api/auth/workos/callback',
}
const EXCHANGE_VERSIONS = [1, 2, 5]
const MEMBER = 'apple:000001.0123456789abcdef0123456789abcdef.0001'
const SPA_INDEX = '<!doctype html><title>eex golden</title>'
const SPA_ASSET = 'console.log("golden")\n'
const HEADERS = [
  'content-type',
  'content-security-policy',
  'x-frame-options',
  'x-request-id',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'set-cookie',
]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-goldens-'))
fs.mkdirSync(path.join(dir, 'dist/assets'), { recursive: true })
fs.writeFileSync(path.join(dir, 'dist/index.html'), SPA_INDEX)
fs.writeFileSync(path.join(dir, 'dist/assets/app.js'), SPA_ASSET)
const { default: Database } = await import('better-sqlite3')
const exchange = new Database(path.join(dir, 'exchange.db'))
exchange.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)')
for (const v of EXCHANGE_VERSIONS) exchange.prepare('INSERT INTO schema_migrations VALUES (?)').run(v)
exchange.close()
// media.db exists but has no schema_migrations table: {current: null}.
const media = new Database(path.join(dir, 'media.db'))
media.exec('CREATE TABLE t (x)')
media.close()

Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  RECOMMENDER_DB_PATH: path.join(dir, 'exchange.db'),
  MEDIA_DB_PATH: path.join(dir, 'media.db'),
})
delete process.env.NODE_ENV
process.chdir(dir) // ./dist is cwd-relative; no .env.local here

globalThis.fetch = async (input: string | URL | Request) => {
  throw new Error(`gen-gateway-goldens: no network (${String(input instanceof Request ? input.url : input)})`)
}
const logs: string[] = []
const log = console.log
console.log = (...args: unknown[]) => {
  logs.push(args.map(String).join(' '))
}

const { app } = await import(path.join(server, 'app.js'))
const session = await import(path.join(server, 'session.js'))
const memberCookie = `eex.session=${await session.createSession({ sub: MEMBER, username: 'Mom', role: 'user' })}`

type Scenario = {
  name: string
  method?: string
  path: string
  headers?: Record<string, string>
  /** Sent with the member's session cookie. */
  cookie?: boolean
  body?: string
  /** A chunked body of this many bytes (no Content-Length). */
  chunked?: number
}
const big = 1024 * 1024 + 1
const scenarios: Scenario[] = [
  { name: 'health', path: '/api/health', headers: { 'X-Request-Id': 'golden-health' } },
  { name: 'health with a hostile Origin', path: '/api/health', headers: { Origin: 'https://evil.example' } },
  { name: 'health, request id regenerated', path: '/api/health', headers: { 'X-Request-Id': 'bad id!' } },
  { name: 'cors read exposes Retry-After', path: '/api/health', headers: { Origin: 'https://app.example' } },
  { name: 'limits without a session', path: '/api/limits' },
  { name: 'limits with a session', path: '/api/limits', cookie: true },
  { name: 'version', path: '/api/version' },
  {
    name: 'cors preflight',
    method: 'OPTIONS',
    path: '/api/settings/anthropic-key',
    headers: {
      Origin: 'https://app.example',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type,x-eex-expected-sub',
    },
  },
  {
    name: 'redacted log line',
    path: '/api/nope?t=stream-secret&token=tok&code=c0de&inviteCode=inv&id_token=eyJx&ok=1',
    headers: { 'X-Request-Id': 'golden-log', 'User-Agent': `golden "agent" ${'a'.repeat(150)}` },
  },
  { name: 'unknown /api path', path: '/api/definitely-not-a-route' },
  {
    name: '413 chunked',
    method: 'POST',
    path: '/api/media/watch',
    headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' },
    cookie: true,
    chunked: big,
  },
  {
    name: '413 content-length',
    method: 'POST',
    path: '/api/iptv/anything',
    headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' },
    cookie: true,
    body: 'x'.repeat(big),
  },
  {
    name: 'csrf reject',
    method: 'POST',
    path: '/api/auth/logout',
    headers: { Origin: 'https://evil.example' },
    cookie: true,
  },
  { name: 'spa index', path: '/' },
  { name: 'spa deep link', path: '/settings/some/deep/route' },
  { name: 'spa asset', path: '/assets/app.js' },
]

function chunkedBody(total: number): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close()
      const n = Math.min(chunk.byteLength, total - sent)
      controller.enqueue(chunk.subarray(0, n))
      sent += n
    },
  })
}

const ran = []
for (const s of scenarios) {
  const headers: Record<string, string> = { ...(s.headers ?? {}) }
  if (s.cookie) headers.Cookie = memberCookie
  const init: RequestInit & { duplex?: 'half' } = { method: s.method ?? 'GET', headers }
  if (s.body !== undefined) init.body = s.body
  if (s.chunked !== undefined) {
    init.body = chunkedBody(s.chunked)
    init.duplex = 'half'
  }
  const before = logs.length
  const r: Response = await app.request(new Request(`http://localhost${s.path}`, init))
  const picked: Record<string, string> = {}
  for (const h of HEADERS) {
    const v = r.headers.get(h)
    if (v !== null) picked[h] = v
  }
  // A generated request id (none sent, or one Hono refused) and the
  // server_id differ per run: replaced by placeholders, as the replay does.
  const id = picked['x-request-id']
  const generated = id !== headers['X-Request-Id']
  const scrub = (text: string) => {
    let out = text.replace(/"server_id":"[^"]*"/, '"server_id":"<server_id>"')
    if (generated) out = out.split(id).join('<request-id>')
    return out
  }
  for (const h of Object.keys(picked)) picked[h] = scrub(picked[h])
  const { body: _b, chunked: _c, headers: requestHeaders, ...rest } = s
  ran.push({
    ...rest,
    ...(requestHeaders ? { request_headers: requestHeaders } : {}),
    ...(s.body !== undefined ? { body_bytes: s.body.length } : {}),
    ...(s.chunked !== undefined ? { chunked_bytes: s.chunked } : {}),
    request_id_generated: generated,
    status: r.status,
    headers: picked,
    body: scrub(await r.text()),
    logs: logs
      .slice(before)
      .filter((l) => l.startsWith('[app] '))
      .map((l) => scrub(l.replace(/ \d+ms /, ' <ms>ms '))),
  })
}

console.log = log
const out = { env: ENV, exchange_versions: EXCHANGE_VERSIONS, member: MEMBER, spa: { index: SPA_INDEX, asset: SPA_ASSET }, scenarios: ran }
fs.writeFileSync(path.join(here, 'edge-goldens.json'), JSON.stringify(out, null, 2) + '\n')
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
