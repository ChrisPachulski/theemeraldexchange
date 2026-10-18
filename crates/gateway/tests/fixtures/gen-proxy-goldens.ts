// Writes proxy-goldens.json from the untouched TS app (server/app.ts): the
// /api/media, /api/transcode, /api/iptv, /api/dvr, /api/account and
// /api/telemetry routes, scenario by scenario, against one local fake that
// stands in for media-core (/mc), the transcoder (/tc), the iptv service
// (/iptv), Radarr (/radarr), Sonarr (/sonarr), the recommender (/rec) and
// Glitchtip (/api/<project>/...), recording every request it gets (the
// internal principal decrypted to sub/role/auth_mode). Per step it keeps the
// status, the proxy-relevant response headers, the body (large or binary
// bodies as length + byte sum) and the fake's requests; abort steps run the
// app on a real socket, read one chunk, hang up and count the fake's open
// sockets; the account scenarios dump server.db and the JSON stores.
// src/proxy/goldens.rs replays the same scenarios through gateway::router.
//
// Per-run values are normalized on both sides: a stream token becomes
// <token>, the fake's origin {FAKE}.
//
// No network: globalThis.fetch throws for every host but the fake and the
// dead 127.0.0.1:9 (the unreachable-service cases).
// Run from the repo root while the TS server exists (it goes at S8):
//   npx tsx crates/gateway/tests/fixtures/gen-proxy-goldens.ts
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo, Socket } from 'node:net'
import Database from 'better-sqlite3'
import { compactDecrypt } from 'jose'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../../../../server')

const ENV: Record<string, string> = {
  SESSION_SECRET: 'proxy-goldens-session-secret-0123456789abcdef',
  STREAM_TOKEN_SECRET: 'proxy-goldens-stream-secret-0123456789abcdef',
  DEVICE_TOKEN_SECRET: 'proxy-goldens-device-secret-0123456789abcdef',
  INTERNAL_PRINCIPAL_SECRET: 'proxy-goldens-internal-principal-placeholder-zzz',
  RECOMMENDER_EVENT_SECRET: 'proxy-goldens-recommender-placeholder-zzz',
  RADARR_API_KEY: 'placeholder-radarr-key',
  SONARR_API_KEY: 'placeholder-sonarr-key',
  ALLOWED_ORIGINS: 'https://app.example',
  SERVE_SPA: '0',
  USE_MEDIA_CORE: '1',
  USE_LOCAL_RECOMMENDER: '1',
  DVR_ENABLED: '1',
  EEX_RELEASE: 'sha-golden',
}
const MEMBERS = {
  alice: { sub: 'apple:000001.0123456789abcdef0123456789abcdef.0001', username: 'alice', role: 'user' },
  bob: { sub: 'google:1234567890', username: 'bob', role: 'user' },
  admin: { sub: 'local:01ARZ3NDEKTSV4RRFFQ69G5FAV', username: 'admin', role: 'admin' },
} as const
type Who = keyof typeof MEMBERS

// --- scenarios -------------------------------------------------------------------------

type Route = {
  method: string
  path: string
  status: number
  headers: Record<string, string>
  body: string
  /** Stream a `bytes`-long body, byte i = (i + seed) & 0xff, in 64 KiB chunks. */
  bytes?: number
  seed?: number
  /** Stream 1 KiB chunks every 50 ms until the client hangs up. */
  slow?: boolean
}
const json = (method: string, p: string, status: number, body: unknown, headers: Record<string, string> = {}): Route => ({
  method,
  path: p,
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const text = (method: string, p: string, status: number, body: string, headers: Record<string, string> = {}): Route => ({ method, path: p, status, headers, body })

type Kind = 'vod' | 'remux' | 'live' | 'playlist' | 'recording'
type Step = {
  name: string
  as?: Who
  method?: string
  /** `{token}` is replaced by the minted token. */
  path?: string
  token?: { kind: Kind; rid: string; who: Who }
  /** GET the previous step's JSON `url` (cookieless unless `as`). */
  from_url?: boolean
  headers?: Record<string, string>
  body?: string
  /** A large body: `head` then `ch` up to `total` bytes. */
  fill?: { head: string; ch: string; total: number }
  /** Revoke this member before the request. */
  revoke?: Who
  /** Serve the app on a socket, read one chunk, hang up. */
  abort?: boolean
}
type Scenario = {
  name: string
  env?: Record<string, string>
  unset?: string[]
  policies?: Partial<Record<Who, unknown>>
  upstream: Route[]
  /** server.db statements run after the members are seeded. */
  seed_sql?: string[]
  /** Dump these (single TEXT column) plus the JSON stores after the steps. */
  state_sql?: string[]
  steps: Step[]
}
const get = (as: Who | undefined, p: string, extra: Partial<Step> = {}): Step => ({ name: `${as ?? 'anon'} GET ${p}`, as, path: p, ...extra })
const req = (as: Who | undefined, method: string, p: string, extra: Partial<Step> = {}): Step => ({ name: `${as ?? 'anon'} ${method} ${p}`, as, method, path: p, ...extra })

const RADARR = json('GET', '/radarr/api/v3/movie', 200, [
  { tmdbId: 550, title: 'Fight Club', certification: 'R' },
  { tmdbId: 551, title: 'Rated G', certification: 'G' },
  { tmdbId: 552, title: 'No cert' },
])
const SONARR = json('GET', '/sonarr/api/v3/series', 200, [
  { tvdbId: 121361, title: 'GoT', certification: 'TV-MA' },
  { tvdbId: 999, title: 'Kids', certification: 'TV-Y' },
])
const CAP_PG13 = { maxContentRating: 'PG-13' }
const KID = { kid: true }
const NO_LIVE = { allowedSections: { live: false, downloads: true, arr: true } }

const MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\'iframe.m3u8\'',
  '#EXTINF:6.0,',
  'seg_00000.m4s',
  '  seg_00001.m4s?x=1  ',
  '',
  'https://cdn.example/abs.ts',
  '#EXT-X-MEDIA:TYPE=AUDIO,URI="http://cdn.example/a.m3u8",NAME="x"',
  '#EXT-X-ENDLIST',
].join('\n')
const HANDOFF = {
  sessionId: 's1',
  manifestUrl: '/api/transcode/session/s1/index.m3u8',
  masterUrl: null,
  heartbeatUrl: '/api/transcode/session/s1/heartbeat',
  subtitle: { url: '/api/transcode/session/s1/subtitles.vtt', language: 'en' },
}
const READY = text('GET', '/tc/api/transcode/session/s1/index.m3u8', 200, '#EXTM3U\n#EXTINF:6.0,\nseg_00000.ts\n', { 'content-type': 'application/vnd.apple.mpegurl' })
const IFRAMES = text('GET', '/tc/api/transcode/session/s1/iframe.m3u8', 200, '#EXTM3U\n#EXT-X-I-FRAMES-ONLY\n', { 'content-type': 'application/vnd.apple.mpegurl' })
const GRANT = (kind: string, id: string, body: unknown, status = 200) => json('POST', `/mc/api/media/play/${kind}/${id}/grant`, status, body)
const STREAM = (kind: string, id: string, body: unknown, status = 200) => json('GET', `/mc/api/media/stream/${kind}/${id}`, status, body)
const PLAY = (as: Who, kind: string, id: string, body: unknown = {}) =>
  req(as, 'POST', `/api/media/playback/${kind}/${id}`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const MB = 1_048_576

const ACCOUNT_SEED = [
  `INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at) VALUES ('hash-1', '${MEMBERS.alice.sub}', 'cousin', NULL, 1, 0, '2026-01-01T00:00:00.000Z', NULL)`,
  `INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at) VALUES ('hash-2', '${MEMBERS.admin.sub}', 'kept', NULL, 1, 0, '2026-01-01T00:00:00.000Z', NULL)`,
  `INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES ('${MEMBERS.alice.sub}', 'x', '2026-01-01T00:00:00.000Z')`,
  `INSERT INTO user_api_keys (sub, ciphertext, updated_at) VALUES ('${MEMBERS.bob.sub}', 'y', '2026-01-01T00:00:00.000Z')`,
  `INSERT INTO webauthn_credentials (credential_id, sub, public_key, counter, created_at) VALUES ('cred-a', '${MEMBERS.alice.sub}', x'00', 0, '2026-01-01T00:00:00.000Z')`,
  `INSERT INTO webauthn_credentials (credential_id, sub, public_key, counter, created_at) VALUES ('cred-b', '${MEMBERS.bob.sub}', x'00', 0, '2026-01-01T00:00:00.000Z')`,
  `INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) VALUES ('jti-a1', '${MEMBERS.alice.sub}', 'dev-a1', 'Apple TV', 'tvos', 'srv', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
  `INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) VALUES ('jti-a2', '${MEMBERS.alice.sub}', 'dev-a2', 'iPad', 'ios', 'srv', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
  `INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) VALUES ('jti-b1', '${MEMBERS.bob.sub}', 'dev-b1', 'Phone', 'ios', 'srv', '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
]
const ACCOUNT_STATE = [
  `SELECT group_concat(sub || '=' || (revoked_at IS NOT NULL), ',') FROM (SELECT sub, revoked_at FROM members ORDER BY sub)`,
  `SELECT group_concat(code_hash || '=' || (revoked_at IS NOT NULL), ',') FROM (SELECT code_hash, revoked_at FROM invites ORDER BY code_hash)`,
  `SELECT group_concat(jti || '=' || reason, ',') FROM (SELECT jti, reason FROM device_token_revocations ORDER BY jti)`,
  `SELECT group_concat(sub, ',') FROM (SELECT sub FROM user_api_keys ORDER BY sub)`,
  `SELECT group_concat(credential_id, ',') FROM (SELECT credential_id FROM webauthn_credentials ORDER BY credential_id)`,
]
const ACCOUNT_STORES = {
  policies: { [MEMBERS.alice.sub]: KID, [MEMBERS.bob.sub]: CAP_PG13 },
  feedback: {
    [MEMBERS.alice.sub]: { movie: { liked: [{ id: 550, title: 'Fight Club' }], disliked: [] }, tv: { liked: [], disliked: [] } },
    [MEMBERS.bob.sub]: { movie: { liked: [{ id: 551, title: 'Kept' }], disliked: [] }, tv: { liked: [], disliked: [] } },
  },
  watchlist: {
    [MEMBERS.alice.sub]: { movie: [{ id: 550, title: 'Fight Club', added_at: '2026-01-01T00:00:00.000Z' }], tv: [] },
    [MEMBERS.bob.sub]: { movie: [{ id: 551, title: 'Kept', added_at: '2026-01-01T00:00:00.000Z' }], tv: [] },
  },
}
const DELETE_SELF = (as: Who | undefined) => req(as, 'DELETE', '/api/account/self')
const TUNNEL = (body: string | Step['fill'], extra: Partial<Step> = {}) =>
  req(undefined, 'POST', '/api/telemetry/tunnel', { ...(typeof body === 'string' ? { body } : { fill: body }), headers: { 'content-type': 'application/x-sentry-envelope' }, ...extra })
/** An envelope of exactly the 256 KiB cap. */
const atLimit = (header: string) => ({ head: `${header}\n`, ch: 'y', total: 256 * 1024 })
const envelope = (dsn: string) => `${JSON.stringify({ event_id: 'e1', dsn })}\n{"type":"event"}\n{"message":"boom"}`

const SCENARIOS: Scenario[] = [
  // --- /api/media: the gate and the proxy ---
  {
    name: 'media proxy forwards with the principal and the allowlists',
    upstream: [
      json('GET', '/mc/api/media/movies', 200, { items: [{ id: 7 }], total: 1 }, { etag: '"v1"', 'cache-control': 'private', 'x-secret': 'dropped' }),
      json('GET', '/mc/api/media/music/artists', 200, { items: [], total: 0 }),
      text('GET', '/mc/api/media/art/7', 200, 'raw-bytes'),
      text('POST', '/mc/api/media/scan', 202, '{"started":true}', { 'content-type': 'application/json' }),
      json('GET', '/mc/api/media/whoami', 401, { error: 'unauthenticated' }),
    ],
    steps: [
      get(undefined, '/api/media/movies'),
      get('alice', '/api/media/movies?page=2&t=drop-me&q=a+b%20c', { headers: { range: 'bytes=0-1', 'if-none-match': '"v0"', 'user-agent': 'AppleCoreMedia/1', 'x-forwarded-for': '198.51.100.1' } }),
      get('bob', '/api/media/music/artists'),
      get('alice', '/api/media/art/7'),
      req('admin', 'POST', '/api/media/scan', { headers: { 'content-type': 'application/json' }, body: '{"full":true}' }),
      get('alice', '/api/media/whoami'),
      get('alice', '/api/media/%E0%A4%A'),
    ],
  },
  {
    name: 'media range and conditional round trips',
    upstream: [
      text('GET', '/mc/api/media/stream/movie/7', 206, 'abcd', { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/100', 'accept-ranges': 'bytes', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT', 'x-accel-buffering': 'no' }),
      text('GET', '/mc/api/media/stream/track/3', 304, '', { etag: '"t3"' }),
    ],
    steps: [
      get('admin', '/api/media/stream/movie/7', { headers: { range: 'bytes=0-3', 'if-range': '"x"' } }),
      get('admin', '/api/media/stream/track/3', { headers: { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' } }),
    ],
  },
  {
    name: 'media rating gate on cookie streams, subtitles, chapters and youtube',
    policies: { alice: CAP_PG13, bob: KID },
    upstream: [
      RADARR,
      SONARR,
      text('GET', '/mc/api/media/stream/movie/8', 200, 'g-movie', { 'content-type': 'video/mp4' }),
      text('GET', '/mc/api/media/stream/track/3', 200, 'audio', { 'content-type': 'audio/mpeg' }),
      text('GET', '/mc/api/media/stream/episode/102', 200, 'kids-ep', { 'content-type': 'video/mp4' }),
      text('GET', '/mc/api/media/subtitles/movie/8/file', 200, 'WEBVTT', { 'content-type': 'text/vtt' }),
      json('GET', '/mc/api/media/subtitles/status', 200, { ok: true }),
      json('GET', '/mc/api/media/chapters/movie/8', 200, { chapters: [] }),
      json('GET', '/mc/api/media/youtube/videos', 200, { items: [] }),
      json('GET', '/mc/api/media/movies', 200, { items: [] }),
    ],
    steps: [
      get('alice', '/api/media/stream/movie/7'),
      get('alice', '/api/media/stream/movie/8'),
      get('alice', '/api/media/stream/movie/9'),
      get('alice', '/api/media/stream/movie/10'),
      get('alice', '/api/media/stream/movie/abc'),
      get('alice', '/api/media/stream/episode/101'),
      get('alice', '/api/media/stream/episode/102'),
      get('alice', '/api/media/stream/track/3'),
      get('alice', '/api/media/stream/video/5'),
      get('alice', '/api/media/subtitles/movie/7/file'),
      get('alice', '/api/media/subtitles/movie/8/file'),
      get('alice', '/api/media/subtitles/status'),
      get('alice', '/api/media/chapters/movie/7'),
      get('alice', '/api/media/chapters/%6dovie/7'),
      get('alice', '/api/media/chapters/movie/8'),
      get('alice', '/api/media/chapters/video/5'),
      get('alice', '/api/media/youtube/videos'),
      get('alice', '/api/media/%79outube/videos'),
      get('admin', '/api/media/youtube/videos'),
      get('bob', '/api/media/stream/movie/8'),
      get('bob', '/api/media/movies'),
      get(undefined, '/api/media/stream/movie/8'),
    ],
  },
  {
    name: 'media rating gate with radarr down and no media.db identity',
    policies: { alice: CAP_PG13 },
    upstream: [json('GET', '/radarr/api/v3/movie', 500, { error: 'boom' })],
    steps: [get('alice', '/api/media/stream/movie/8'), get('alice', '/api/media/subtitles/episode/101/file')],
  },
  {
    name: 'media-core unreachable',
    env: { MEDIA_CORE_URL: 'http://127.0.0.1:9' },
    upstream: [],
    steps: [get('alice', '/api/media/movies'), PLAY('alice', 'movie', '7')],
  },
  {
    name: 'media streams a multi-MB body',
    upstream: [{ method: 'GET', path: '/mc/api/media/stream/movie/7', status: 200, headers: { 'content-type': 'video/mp4' }, body: '', bytes: 3 * MB + 12345, seed: 7 }],
    steps: [get('admin', '/api/media/stream/movie/7')],
  },
  {
    name: 'media client abort closes the upstream socket',
    upstream: [{ method: 'GET', path: '/mc/api/media/stream/movie/7', status: 200, headers: { 'content-type': 'video/mp4' }, body: '', slow: true }],
    steps: [get('admin', '/api/media/stream/movie/7', { abort: true })],
  },
  // --- /api/media: the playback grant ---
  {
    name: 'playback direct play then the tokened stream',
    upstream: [
      GRANT('movie', '7', { directPlay: true, file: { duration_secs: 7200 } }),
      GRANT('track', '3', { directPlay: false, file: {} }),
      text('GET', '/mc/api/media/stream/movie/7', 200, 'movie-bytes', { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }),
      text('GET', '/mc/api/media/stream/track/3', 200, 'audio', { 'content-type': 'audio/mpeg' }),
    ],
    steps: [
      PLAY('alice', 'movie', '7', { containers: ['mp4', 'mkv'], video_codecs: ['h264', 'hevc'], max_height: 1080, hdr: 1, audio_codecs: ['aac', 'eac3'], aac_max_channels: 6.7, hls_fmp4_hevc: true, dolby_vision: 'yes', max_bitrate: 8000000.9, start_secs: 12.5 }),
      { name: 'cookieless tokened stream', from_url: true, headers: { range: 'bytes=0-' } },
      { name: 'tokened stream for another title', path: '/api/media/stream/movie/8?t={token}', token: { kind: 'vod', rid: 'media:movie:7', who: 'alice' } },
      { name: 'remux token on a stream', path: '/api/media/stream/movie/7?t={token}', token: { kind: 'remux', rid: 'media:movie:7', who: 'alice' } },
      { name: 'iptv-namespace token', path: '/api/media/stream/movie/7?t={token}', token: { kind: 'vod', rid: 'movie:7', who: 'alice' } },
      { name: 'garbage token', path: '/api/media/stream/movie/7?t=garbage' },
      { name: 'revoked holder', path: '/api/media/stream/movie/7?t={token}', token: { kind: 'vod', rid: 'media:movie:7', who: 'bob' }, revoke: 'bob' },
      PLAY('alice', 'track', '3', { force_hls: true, containers: [], aac_max_channels: 1 }),
    ],
  },
  {
    name: 'playback transcode with trickplay and a subtitle',
    upstream: [GRANT('episode', '101', { directPlay: false, file: { duration_secs: 3000 } }), STREAM('episode', '101', HANDOFF), READY, IFRAMES],
    steps: [PLAY('admin', 'episode', '101', { native_hls: true, alt_audio: true, start_secs: 90, max_height: 'tall' })],
  },
  {
    name: 'playback transcode without an I-frame rendition and with a master',
    upstream: [
      GRANT('movie', '7', { directPlay: true, file: { duration_secs: null } }),
      STREAM('movie', '7', { ...HANDOFF, masterUrl: '/api/transcode/session/s1/master.m3u8?v=2', heartbeatUrl: '', subtitle: { url: '' } }),
      text('GET', '/tc/api/transcode/session/s1/index.m3u8', 200, '#EXTM3U\n#EXTINF:6.0,\nseg_00000.m4s?x=1\n'),
      json('GET', '/tc/api/transcode/session/s1/iframe.m3u8', 404, { error: 'not_found' }),
    ],
    steps: [PLAY('admin', 'movie', '7', { force_hls: true })],
  },
  {
    name: 'playback failures',
    policies: { alice: CAP_PG13 },
    upstream: [
      RADARR,
      GRANT('movie', '404', { error: 'nope' }, 404),
      GRANT('movie', '500', { error: 'boom' }, 500),
      text('POST', '/mc/api/media/play/movie/501/grant', 200, 'not json'),
      GRANT('movie', '502', { directPlay: false }),
      STREAM('movie', '502', { error: 'busy' }, 503),
      GRANT('movie', '503', { directPlay: false }),
      STREAM('movie', '503', { error: 'boom' }, 500),
      GRANT('movie', '504', { directPlay: false }),
      text('GET', '/mc/api/media/stream/movie/504', 200, '<html>'),
      GRANT('movie', '505', { directPlay: false }),
      STREAM('movie', '505', { manifestUrl: '/api/transcode/session/x/index.m3u8' }),
    ],
    steps: [
      PLAY('alice', 'show', '7'),
      req(undefined, 'POST', '/api/media/playback/movie/7'),
      PLAY('alice', 'movie', '7'),
      PLAY('alice', 'video', '5'),
      PLAY('admin', 'movie', '404'),
      PLAY('admin', 'movie', '500'),
      PLAY('admin', 'movie', '501'),
      PLAY('admin', 'movie', '502'),
      PLAY('admin', 'movie', '503'),
      PLAY('admin', 'movie', '504'),
      PLAY('admin', 'movie', '505'),
      req('admin', 'GET', '/api/media/playback/movie/7'),
    ],
  },
  // --- the watched signal ---
  {
    name: 'watch writes earn one watched signal',
    upstream: [json('POST', '/mc/api/media/watch', 200, { ok: true })],
    steps: [
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: 7, position_secs: 4000, duration_secs: 7200 }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: 8, position_secs: 900, duration_secs: 1000 }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'episode', media_id: 101, position_secs: '1300', duration_secs: 3000 }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'episode', media_id: 101, position_secs: 10, completed: true }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: 9, completed: 1 }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: 7, position_secs: 100, duration_secs: 7200 }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ media_kind: 'movie', media_id: 7, completed: true }) }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: '{not json' }),
      req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: '7', completed: true }) }),
    ],
  },
  {
    name: 'a refused watch write earns nothing',
    upstream: [json('POST', '/mc/api/media/watch', 400, { error: 'bad' })],
    steps: [req('alice', 'POST', '/api/media/watch', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_kind: 'movie', media_id: 7, completed: true }) })],
  },
  // --- /api/transcode ---
  {
    name: 'transcode token manifest rewrite',
    upstream: [
      text('GET', '/tc/api/transcode/session/abc/index.m3u8', 200, MANIFEST, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'max-age=60', 'content-length': String(Buffer.byteLength(MANIFEST)) }),
      text('GET', '/tc/api/transcode/session/abc/seg_00000.ts', 206, 'TSDATA', { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-5/10', 'accept-ranges': 'bytes' }),
      json('POST', '/tc/api/transcode/session/abc/heartbeat', 200, { ok: true }),
      text('GET', '/tc/api/transcode/session/abc/missing.m3u8', 404, 'gone'),
    ],
    steps: [
      { name: 'tokened manifest', path: '/api/transcode/session/abc/index.m3u8?t={token}&v=1', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' }, headers: { 'user-agent': 'AppleCoreMedia/1.0' } },
      { name: 'cookie manifest is not rewritten', as: 'alice', path: '/api/transcode/session/abc/index.m3u8' },
      { name: 'tokened segment with range', path: '/api/transcode/session/abc/seg_00000.ts?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' }, headers: { range: 'bytes=0-5' } },
      { name: 'tokened heartbeat', method: 'POST', path: '/api/transcode/session/abc/heartbeat?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' }, headers: { 'content-type': 'application/json' }, body: '{"pos":12}' },
      { name: 'tokened 404 manifest passes through', path: '/api/transcode/session/abc/missing.m3u8?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' } },
      { name: 'token for another session', path: '/api/transcode/session/xyz/index.m3u8?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' } },
      { name: 'vod token on a session', path: '/api/transcode/session/abc/index.m3u8?t={token}', token: { kind: 'vod', rid: 'media:session:abc', who: 'alice' } },
      { name: 'revoked holder', path: '/api/transcode/session/abc/index.m3u8?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'bob' }, revoke: 'bob' },
    ],
  },
  {
    name: 'transcode session paths and the control-path block',
    upstream: [
      json('GET', '/tc/api/transcode/sessions', 200, []),
      text('GET', '/tc/api/transcode/session/grant/index.m3u8', 200, '#EXTM3U'),
      text('GET', '/tc/api/transcode/session/abc/warm.ts', 200, 'ts'),
      text('GET', '/tc/api/transcode/grants', 200, 'ok'),
      json('POST', '/tc/api/transcode/grant', 200, { leaked: true }),
      json('POST', '/tc/api/transcode/warm', 200, { leaked: true }),
      json('GET', '/tc/api/transcode/grant', 200, { leaked: true }),
    ],
    steps: [
      get(undefined, '/api/transcode/sessions'),
      get('admin', '/api/transcode/sessions', { headers: { 'user-agent': 'Mozilla/5.0' } }),
      get('alice', '/api/transcode/session/grant/index.m3u8'),
      get('alice', '/api/transcode/session/abc/warm.ts'),
      get('alice', '/api/transcode/grants'),
      req('alice', 'POST', '/api/transcode/grant', { headers: { 'content-type': 'application/json' }, body: '{"file":{"path":"/etc/shadow"}}' }),
      req('alice', 'POST', '/api/transcode/warm', { headers: { 'content-type': 'application/json' }, body: '{"path":"/etc/passwd"}' }),
      get('alice', '/api/transcode/grant'),
      get('alice', '/api/transcode/warm'),
      req('alice', 'POST', '/api/transcode/%67rant', { body: '{}' }),
      req('alice', 'POST', '/api/transcode/%77arm', { body: '{}' }),
      req('alice', 'POST', '/api/transcode/session/abc/../../warm', { body: '{}' }),
      req('alice', 'POST', '/api/transcode/session/abc/%2e%2e/%2E%2E/grant', { body: '{}' }),
      { name: 'tokened grant', method: 'POST', path: '/api/transcode/grant?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' }, body: '{}' },
      get('alice', '/api/transcode/%E0%A4%A'),
    ],
  },
  {
    name: 'transcode streams a multi-MB segment',
    upstream: [{ method: 'GET', path: '/tc/api/transcode/session/abc/seg_00001.ts', status: 200, headers: { 'content-type': 'video/mp2t' }, body: '', bytes: 2 * MB + 77, seed: 3 }],
    steps: [{ name: 'tokened big segment', path: '/api/transcode/session/abc/seg_00001.ts?t={token}', token: { kind: 'remux', rid: 'media:session:abc', who: 'alice' } }],
  },
  // --- /api/iptv ---
  {
    name: 'iptv session routes',
    policies: { bob: KID },
    upstream: [
      json('POST', '/iptv/api/iptv/stream/live/10/grant', 200, { delivery: 'hls', url: '/x' }),
      json('GET', '/iptv/api/iptv/categories', 200, { categories: [] }, { 'set-cookie': 'a=b', connection: 'keep-alive' }),
      json('GET', '/iptv/api/iptv/sessions', 200, []),
      json('GET', '/iptv/api/iptv/playlist/tokens', 200, []),
      json('POST', '/iptv/api/iptv/playlist/token', 200, { token: 'x' }),
      json('POST', '/iptv/api/iptv/stream/vod/5/grant', 200, { ok: true }),
      json('GET', '/iptv/api/iptv/stream/vod/5/grant', 200, { ok: true }),
    ],
    steps: [
      req('alice', 'POST', '/api/iptv/stream/live/10/grant?client=avplayer', { headers: { host: 'api.example.test', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' }, body: '{}' }),
      get(undefined, '/api/iptv/categories'),
      get('alice', '/api/iptv/categories', { headers: { 'accept-encoding': 'gzip', 'x-forwarded-host': 'tv.example', 'x-forwarded-for': '198.51.100.2, 10.0.0.1' } }),
      get('bob', '/api/iptv/categories'),
      req('bob', 'POST', '/api/iptv/stream/live/10/grant', { body: '{}' }),
      req('bob', 'POST', '/api/iptv/playlist/token', { body: '{}' }),
      req('bob', 'POST', '/api/iptv/stream/vod/5/grant', { body: '{}' }),
      get('bob', '/api/iptv/stream/vod/5/grant'),
      req('admin', 'POST', '/api/iptv/playlist/token', { body: '{}' }),
    ],
  },
  {
    name: 'iptv live section',
    policies: { alice: NO_LIVE },
    upstream: [json('GET', '/iptv/api/iptv/sessions', 200, []), json('GET', '/iptv/api/iptv/sessions/s1', 200, {}), json('DELETE', '/iptv/api/iptv/playlist/tokens/t1', 200, {}), json('GET', '/iptv/api/iptv/categories', 200, {})],
    steps: [
      get('alice', '/api/iptv/categories'),
      get('alice', '/api/iptv/sessions'),
      get('alice', '/api/iptv/sessions/s1'),
      req('alice', 'DELETE', '/api/iptv/playlist/tokens/t1'),
      get('alice', '/api/iptv/sessions/s1/extra'),
      get('admin', '/api/iptv/categories'),
    ],
  },
  {
    name: 'iptv tokened byte routes',
    upstream: [
      text('GET', '/iptv/api/iptv/stream/live/10.ts', 206, 'abcd', { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/100', 'x-accel-buffering': 'no' }),
      text('GET', '/iptv/api/iptv/stream/segment', 200, 'seg', { 'content-type': 'video/mp2t' }),
    ],
    steps: [
      { name: 'live bytes with range', path: '/api/iptv/stream/live/10.ts?t={token}', token: { kind: 'live', rid: '10', who: 'alice' }, headers: { range: 'bytes=0-3' } },
      { name: 'segment by ?u=', path: '/api/iptv/stream/segment?u={token}&n=1', token: { kind: 'segment' as Kind, rid: 'seg', who: 'alice' } },
      { name: 'forged ?u=', path: '/api/iptv/stream/segment?u=not-a-token' },
      { name: 'empty ?t= wins over ?u=', path: '/api/iptv/stream/segment?t=&u={token}', token: { kind: 'live', rid: '10', who: 'alice' } },
      { name: 'no token', path: '/api/iptv/stream/live/10.ts' },
      { name: 'bare sub', path: '/api/iptv/stream/live/10.ts?t={token}', token: { kind: 'live', rid: '10', who: '42' as Who } },
      { name: 'revoked holder', path: '/api/iptv/stream/live/10.ts?t={token}', token: { kind: 'live', rid: '10', who: 'bob' }, revoke: 'bob' },
    ],
  },
  {
    name: 'iptv playlist.m3u',
    policies: { bob: CAP_PG13 },
    upstream: [
      text('GET', '/iptv/api/iptv/playlist.m3u', 200, '#EXTM3U\n', { 'content-type': 'audio/x-mpegurl' }),
      json('POST', `/iptv/internal/members/${encodeURIComponent(MEMBERS.alice.sub)}/revoke-playlist-tokens`, 200, { revoked: 2 }),
    ],
    steps: [
      { name: 'allowed member', path: '/api/iptv/playlist.m3u?t={token}', token: { kind: 'playlist', rid: 'iptv-channels-all', who: 'admin' }, headers: { host: 'vlc.example' } },
      { name: 'capped member', path: '/api/iptv/playlist.m3u?t={token}', token: { kind: 'playlist', rid: 'iptv-channels-all', who: 'bob' } },
      { name: 'garbage token', path: '/api/iptv/playlist.m3u?t=garbage' },
      { name: 'revoked member revokes its tokens', path: '/api/iptv/playlist.m3u?t={token}', token: { kind: 'playlist', rid: 'iptv-channels-all', who: 'alice' }, revoke: 'alice' },
      { name: 'cookie POST is the session route', as: 'admin', method: 'POST', path: '/api/iptv/playlist.m3u', body: '{}' },
    ],
  },
  {
    name: 'iptv playlist.m3u section',
    policies: { alice: NO_LIVE },
    upstream: [],
    steps: [{ name: 'section blocked', path: '/api/iptv/playlist.m3u?t={token}', token: { kind: 'playlist', rid: 'iptv-channels-all', who: 'alice' } }],
  },
  {
    name: 'iptv service down',
    env: { IPTV_SERVICE_URL: 'http://127.0.0.1:9' },
    upstream: [],
    steps: [get('alice', '/api/iptv/categories')],
  },
  {
    name: 'iptv streams a multi-MB body',
    upstream: [{ method: 'GET', path: '/iptv/api/iptv/stream/vod/5.mp4', status: 200, headers: { 'content-type': 'video/mp4' }, body: '', bytes: 2 * MB + 5, seed: 11 }],
    steps: [{ name: 'vod bytes', path: '/api/iptv/stream/vod/5.mp4?t={token}', token: { kind: 'vod', rid: '5', who: 'alice' } }],
  },
  {
    name: 'iptv client abort closes the upstream socket',
    upstream: [{ method: 'GET', path: '/iptv/api/iptv/stream/live/10.ts', status: 200, headers: { 'content-type': 'video/mp2t' }, body: '', slow: true }],
    steps: [{ name: 'abort live bytes', path: '/api/iptv/stream/live/10.ts?t={token}', token: { kind: 'live', rid: '10', who: 'alice' }, abort: true }],
  },
  // --- /api/dvr ---
  {
    name: 'dvr gates',
    policies: { alice: KID, bob: NO_LIVE },
    upstream: [
      json('GET', '/iptv/api/dvr/recordings', 200, []),
      json('GET', '/iptv/api/dvr/recordings/rec-1', 200, { id: 'rec-1' }),
      json('POST', '/iptv/api/dvr/recordings', 201, { id: 'rec-2' }),
      json('DELETE', '/iptv/api/dvr/recordings/rec-1', 200, { ok: true }),
      json('POST', '/iptv/api/dvr/recordings/rec-1/grant', 200, { url: '/x' }),
      text('GET', '/iptv/api/dvr/recordings/rec-1/play', 206, 'rec', { 'content-type': 'video/mp2t', 'content-range': 'bytes 5-7/8' }),
    ],
    steps: [
      { name: 'tokened play', path: '/api/dvr/recordings/rec-1/play?t={token}', token: { kind: 'recording', rid: 'rec-1', who: 'alice' }, headers: { range: 'bytes=5-' } },
      get('alice', '/api/dvr/recordings/rec-1/play'),
      get('alice', '/api/dvr/recordings'),
      get('alice', '/api/dvr/recordings/rec-1'),
      req('alice', 'POST', '/api/dvr/recordings/rec-1/grant', { body: '{}' }),
      req('alice', 'POST', '/api/dvr/recordings', { body: '{}' }),
      req('alice', 'DELETE', '/api/dvr/recordings/rec-1'),
      get('bob', '/api/dvr/recordings'),
      get('bob', '/api/dvr/recordings/rec-1/play'),
      get(undefined, '/api/dvr/recordings'),
      req(undefined, 'POST', '/api/dvr/recordings', { body: '{}' }),
      req('admin', 'POST', '/api/dvr/recordings', { headers: { 'content-type': 'application/json' }, body: '{"channel":1}' }),
      req('admin', 'DELETE', '/api/dvr/recordings/rec-1'),
      req('admin', 'POST', '/api/dvr/recordings/rec-1/grant', { body: '{}' }),
      get('admin', '/api/dvr/recordings/rec-1/play'),
      { name: 'garbage token', path: '/api/dvr/recordings/rec-1/play?t=garbage' },
      { name: 'empty token falls back to the session', path: '/api/dvr/recordings/rec-1/play?t=' },
    ],
  },
  // --- /api/account ---
  {
    name: 'account deletion erases every step',
    seed_sql: ACCOUNT_SEED,
    state_sql: ACCOUNT_STATE,
    upstream: [
      json('DELETE', `/iptv/internal/members/${encodeURIComponent(MEMBERS.alice.sub)}`, 200, { ok: true }),
      text('DELETE', '/mc/api/media/watch', 204, ''),
    ],
    steps: [DELETE_SELF(undefined), DELETE_SELF('alice'), DELETE_SELF('alice'), get('alice', '/api/media/movies')],
  },
  {
    name: 'account deletion survives failed steps',
    seed_sql: ACCOUNT_SEED,
    state_sql: ACCOUNT_STATE,
    upstream: [
      json('DELETE', `/iptv/internal/members/${encodeURIComponent(MEMBERS.bob.sub)}`, 500, { error: 'boom' }),
      json('DELETE', '/mc/api/media/watch', 405, { error: 'method' }),
    ],
    steps: [DELETE_SELF('bob')],
  },
  {
    name: 'account deletion of the last admin',
    seed_sql: ACCOUNT_SEED,
    state_sql: ACCOUNT_STATE,
    upstream: [],
    steps: [DELETE_SELF('admin')],
  },
  // --- /api/telemetry ---
  {
    name: 'telemetry config not configured',
    upstream: [],
    steps: [get(undefined, '/api/telemetry/config'), TUNNEL(envelope('http://pubkey@x/42'))],
  },
  {
    name: 'telemetry config invalid',
    env: { EEX_TELEMETRY_DSN: 'not a url' },
    upstream: [],
    steps: [get(undefined, '/api/telemetry/config')],
  },
  {
    name: 'telemetry config bad scheme',
    env: { EEX_TELEMETRY_DSN: 'ftp://pubkey@glitch.example/42' },
    upstream: [],
    steps: [get(undefined, '/api/telemetry/config')],
  },
  {
    name: 'telemetry config and tunnel',
    env: { EEX_TELEMETRY_DSN: 'https://pubkey@glitch.example/42', EEX_TELEMETRY_DSN_INTERNAL: '{FAKE_DSN}' },
    upstream: [text('POST', '/api/42/envelope/', 200, '{"id":"e1"}', { 'content-type': 'application/json' })],
    steps: [
      get(undefined, '/api/telemetry/config'),
      get('alice', '/api/telemetry/config'),
      TUNNEL(envelope('https://pubkey@glitch.example/42')),
      TUNNEL(envelope('https://pubkey@elsewhere.example/42/')),
      TUNNEL(envelope('https://otherkey@glitch.example/42')),
      TUNNEL(envelope('https://pubkey@glitch.example/43')),
      TUNNEL('not json\n{}'),
      TUNNEL('{"dsn":5}'),
      TUNNEL({ head: '', ch: 'x', total: 256 * 1024 + 1 }),
      TUNNEL(atLimit(JSON.stringify({ dsn: 'https://pubkey@glitch.example/42' }))),
    ],
  },
  {
    name: 'telemetry tunnel upstream failure',
    env: { EEX_TELEMETRY_DSN: 'https://pubkey@glitch.example/42', EEX_TELEMETRY_DSN_INTERNAL: '{FAKE_DSN}' },
    upstream: [text('POST', '/api/42/envelope/', 500, 'down')],
    steps: [TUNNEL(envelope('https://pubkey@glitch.example/42'))],
  },
  {
    name: 'telemetry tunnel rate limit',
    env: { EEX_TELEMETRY_DSN: 'https://pubkey@glitch.example/42', EEX_TELEMETRY_DSN_INTERNAL: '{FAKE_DSN}' },
    upstream: [text('POST', '/api/42/envelope/', 200, '')],
    steps: Array.from({ length: 31 }, (_, i) => TUNNEL('not json', { name: `tunnel ${i + 1}` })),
  },
]

// media.db (media-core's schema, the columns these routes read).
const MEDIA_SQL = [
  'CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, title TEXT NOT NULL, year INTEGER)',
  'CREATE TABLE shows (id INTEGER PRIMARY KEY, tmdb_id INTEGER, tvdb_id INTEGER, title TEXT NOT NULL, year INTEGER)',
  'CREATE TABLE episodes (id INTEGER PRIMARY KEY, show_id INTEGER NOT NULL)',
  'CREATE TABLE media_watch_state (sub TEXT NOT NULL, media_kind TEXT NOT NULL, media_id INTEGER NOT NULL, position_secs INTEGER NOT NULL, duration_secs INTEGER, completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sub, media_kind, media_id))',
  "INSERT INTO movies VALUES (7, 550, 'Fight Club', 1999), (8, 551, 'Rated G', 2001), (9, NULL, 'No identity', 2002), (10, 552, 'No cert', 2003)",
  "INSERT INTO shows VALUES (1, 1399, 121361, 'GoT', 2011), (2, 1400, 999, 'Kids', 2020)",
  'INSERT INTO episodes VALUES (101, 1), (102, 2)',
  `INSERT INTO media_watch_state VALUES ('${MEMBERS.alice.sub}', 'movie', 8, 500, 1000, 0), ('${MEMBERS.alice.sub}', 'episode', 101, 100, 3000, 0)`,
]

// --- the fake ---------------------------------------------------------------------------

const RECORDED = [
  'range',
  'if-range',
  'if-none-match',
  'if-modified-since',
  'user-agent',
  'accept-encoding',
  'content-type',
  'cf-connecting-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-sentry-auth',
  'x-recommender-secret',
]
type Call = { method: string; path: string; query: string; principal: unknown; headers: Record<string, string>; body: string }
const calls: Call[] = []
let routes: Route[] = []
let open = 0
const sockets = new Set<Socket>()
const pending: Array<Promise<void>> = []

const principalKey = (await import(path.join(server, 'services/keyDerivation.js'))).deriveKey(
  ENV.INTERNAL_PRINCIPAL_SECRET,
  'eex/internal-principal/v1',
)
async function principalOf(auth: string | undefined): Promise<unknown> {
  if (!auth) return null
  const m = /^Bearer (.+)$/.exec(auth)
  if (!m || m[1].split('.').length !== 5) return auth
  try {
    const { plaintext } = await compactDecrypt(m[1], principalKey)
    const c = JSON.parse(new TextDecoder().decode(plaintext)) as { sub: string; role: string; auth_mode: string }
    return { sub: c.sub, role: c.role, auth_mode: c.auth_mode }
  } catch {
    return 'undecryptable'
  }
}

const fake = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const done = (async () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? ''
      const headers: Record<string, string> = {}
      for (const k of RECORDED) {
        const v = req.headers[k]
        if (typeof v === 'string') headers[k] = v
      }
      if (headers['user-agent'] === 'node' || headers['user-agent'] === 'undici') delete headers['user-agent']
      calls.push({
        method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ''),
        principal: await principalOf(req.headers.authorization),
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const hit = routes.find((r) => r.method === method && r.path === url.pathname)
      if (!hit) {
        if (url.pathname.startsWith('/rec/')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end('{}')
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end('{"error":"no fixture"}')
      }
      if (hit.slow) {
        res.writeHead(hit.status, hit.headers)
        const timer = setInterval(() => res.write(Buffer.alloc(1024, 0x47)), 50)
        res.on('close', () => clearInterval(timer))
        return
      }
      if (hit.bytes !== undefined) {
        res.writeHead(hit.status, hit.headers)
        for (let at = 0; at < hit.bytes; at += 65536) {
          const n = Math.min(65536, hit.bytes - at)
          const chunk = Buffer.alloc(n)
          for (let i = 0; i < n; i++) chunk[i] = (at + i + (hit.seed ?? 0)) & 0xff
          if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok))
        }
        return res.end()
      }
      res.writeHead(hit.status, hit.headers)
      res.end(hit.body)
    })()
    pending.push(done)
  })
})
fake.on('connection', (s: Socket) => {
  open += 1
  sockets.add(s)
  s.on('close', () => {
    open -= 1
    sockets.delete(s)
  })
})
await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
const FAKE_DSN = `http://pubkey@127.0.0.1:${(fake.address() as AddressInfo).port}/42`

const realSetTimeout = globalThis.setTimeout
const sleep = (ms: number) => new Promise((ok) => realSetTimeout(ok, ms))

/** Wait out requests still in flight (no new call for 150 ms). */
async function quiet(): Promise<void> {
  let seen = -1
  while (calls.length !== seen) {
    seen = calls.length
    await sleep(150)
  }
  await Promise.all(pending.splice(0))
}

// --- env, the TS app --------------------------------------------------------------------

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-goldens-')))
const mediaDb = path.join(dir, 'media.db')
{
  const db = new Database(mediaDb)
  for (const sql of MEDIA_SQL) db.exec(sql)
  db.close()
}
Object.assign(process.env, ENV, {
  SERVER_DB_PATH: path.join(dir, 'server.db'),
  MEDIA_DB_PATH: mediaDb,
  MEDIA_CORE_URL: `${fakeUrl}/mc`,
  MEDIA_TRANSCODER_URL: `${fakeUrl}/tc`,
  IPTV_SERVICE_URL: `${fakeUrl}/iptv`,
  RADARR_URL: `${fakeUrl}/radarr`,
  SONARR_URL: `${fakeUrl}/sonarr`,
  RECOMMENDER_URL: `${fakeUrl}/rec`,
})
delete process.env.NODE_ENV
delete process.env.IPTV_DISABLED
delete process.env.EEX_TELEMETRY_DSN
delete process.env.EEX_TELEMETRY_DSN_INTERNAL
delete process.env.TRUST_CLIENT_IP_HEADERS
process.chdir(dir)

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!url.startsWith(fakeUrl) && !url.startsWith('http://127.0.0.1:9/')) throw new Error(`gen-proxy-goldens: no network (${url})`)
  return realFetch(input, init)
}) as typeof fetch
const log = console.log
console.log = () => {}
console.warn = () => {}
console.error = () => {}

const { app } = await import(path.join(server, 'app.js'))
const { createMemberSession } = await import(path.join(server, 'test/authFixture.js'))
const { serverDb } = await import(path.join(server, 'services/serverDb.js'))
const { env } = await import(path.join(server, 'env.js'))
const { signStreamToken } = await import(path.join(server, 'services/iptvStreamToken.js'))
const { _setUserPoliciesPathForTests } = await import(path.join(server, 'services/userPolicies.js'))
const { _setUserFeedbackPathForTests } = await import(path.join(server, 'services/userFeedback.js'))
const { _setUserWatchlistPathForTests } = await import(path.join(server, 'services/userWatchlist.js'))
const { _setCertificationResolverForTests } = await import(path.join(server, 'services/parentalRating.js'))
const { __resetRateLimitsForTests } = await import(path.join(server, 'middleware/rateLimit.js'))
const { serve } = await import('@hono/node-server')

const cookies: Record<string, string> = {}
for (const [who, m] of Object.entries(MEMBERS)) {
  cookies[who] = `eex.session=${await createMemberSession({ sub: m.sub, username: m.username, role: m.role })}`
}

const ENV_KEYS: Record<string, string> = Object.fromEntries([
  ['MEDIA_CORE_URL', 'mediaCoreUrl'],
  ['IPTV_SERVICE_URL', 'iptvServiceUrl'],
  ['EEX_TELEMETRY_DSN', 'EEX_TELEMETRY_DSN'],
  ['EEX_TELEMETRY_DSN_INTERNAL', 'EEX_TELEMETRY_DSN_INTERNAL'],
])
const TOKEN_RE = /([?&]t=|[?&]u=)[A-Za-z0-9_.-]{20,}/g
const norm = (s: string) =>
  s.split(fakeUrl).join('{FAKE}').replace(TOKEN_RE, '$1<token>').replace(/127\.0\.0\.1:\d+/g, '<loopback>')
const KEPT_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'x-accel-buffering', 'content-encoding', 'set-cookie', 'retry-after', 'x-secret']
const isText = (ct: string | null, len: number) => len <= 65536 && (ct === null || /json|text|mpegurl|vtt/.test(ct))

/** Serve the app on a socket, read one chunk, hang up; count the fake's sockets. */
async function abortRun(p: string, headers: Record<string, string>) {
  const srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as http.Server
  await new Promise<void>((ok) => (srv.listening ? ok() : srv.once('listening', () => ok())))
  const port = (srv.address() as AddressInfo).port
  const r = await new Promise<{ status: number; open_during: number }>((ok, bad) => {
    const cr = http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.once('data', () => {
        const during = open
        cr.destroy()
        ok({ status: res.statusCode ?? 0, open_during: during })
      })
    })
    cr.on('error', (e) => (e.message.includes('socket hang up') ? undefined : bad(e)))
  })
  let waited = 0
  while (open > 0 && waited < 3000) {
    await sleep(50)
    waited += 50
  }
  const result = { status: r.status, open_during: r.open_during, open_after: open }
  srv.closeAllConnections()
  await new Promise<void>((ok) => srv.close(() => ok()))
  return result
}

const storeFiles = (scDir: string) => ({
  policies: path.join(scDir, 'policies.json'),
  feedback: path.join(scDir, 'feedback.json'),
  watchlist: path.join(scDir, 'watchlist.json'),
})
const readJson = (p: string) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

const out = []
for (const [n, sc] of SCENARIOS.entries()) {
  const scDir = path.join(dir, `sc-${n}`)
  fs.mkdirSync(scDir)
  const files = storeFiles(scDir)
  const policies = Object.fromEntries(Object.entries(sc.policies ?? {}).map(([who, p]) => [MEMBERS[who as Who].sub, p]))
  if (sc.seed_sql) {
    fs.writeFileSync(files.policies, JSON.stringify(ACCOUNT_STORES.policies))
    fs.writeFileSync(files.feedback, JSON.stringify(ACCOUNT_STORES.feedback))
    fs.writeFileSync(files.watchlist, JSON.stringify(ACCOUNT_STORES.watchlist))
  } else if (Object.keys(policies).length) {
    fs.writeFileSync(files.policies, JSON.stringify(policies))
  }
  _setUserPoliciesPathForTests(files.policies)
  _setUserFeedbackPathForTests(files.feedback)
  _setUserWatchlistPathForTests(files.watchlist)
  _setCertificationResolverForTests(null)
  __resetRateLimitsForTests()
  const db = serverDb().raw
  db.exec('DELETE FROM device_token_revocations; DELETE FROM device_tokens; DELETE FROM invites; DELETE FROM webauthn_credentials; DELETE FROM user_api_keys; DELETE FROM members;')
  for (const m of Object.values(MEMBERS)) {
    db.prepare('INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)').run(m.sub, m.username, m.role, m.sub.split(':')[0], '2026-01-01T00:00:00.000Z')
  }
  for (const sql of sc.seed_sql ?? []) db.exec(sql)
  const saved: Record<string, unknown> = {}
  const overrides: Array<[string, string | null]> = [...Object.entries(sc.env ?? {}), ...(sc.unset ?? []).map((k): [string, null] => [k, null])]
  for (const [k, v] of overrides) {
    const key = ENV_KEYS[k]
    if (!key) throw new Error(`unmapped env ${k}`)
    saved[key] = env[key]
    env[key] = v === '{FAKE_DSN}' ? FAKE_DSN : v
  }
  routes = sc.upstream
  const steps = []
  let lastUrl: string | null = null
  for (const st of sc.steps) {
    if (st.revoke) db.prepare("UPDATE members SET revoked_at = '2026-01-02T00:00:00.000Z' WHERE sub = ?").run(MEMBERS[st.revoke].sub)
    let p = st.path ?? ''
    if (st.token) {
      const sub = (MEMBERS as Record<string, { sub: string }>)[st.token.who]?.sub ?? st.token.who
      p = p.replace('{token}', signStreamToken(env.streamTokenSecret, { kind: st.token.kind, resourceId: st.token.rid, sub, ttlSecs: 300 }))
    }
    if (st.from_url) {
      if (!lastUrl) throw new Error(`${st.name}: no previous url`)
      p = lastUrl
    }
    const headers: Record<string, string> = { Origin: 'https://app.example', ...(st.headers ?? {}) }
    if (st.as) headers.Cookie = cookies[st.as]
    if (st.abort) {
      const r = await abortRun(p, headers)
      await quiet()
      steps.push({ name: st.name, ...stepEcho(st), abort: r, calls: calls.splice(0).map((c) => normCall(c, st)) })
      continue
    }
    const body = st.fill ? st.fill.head + st.fill.ch.repeat(st.fill.total - st.fill.head.length) : st.body
    const res: Response = await app.request(new Request(`http://localhost${p}`, { method: st.method ?? 'GET', headers, body }))
    const buf = Buffer.from(await res.arrayBuffer())
    await quiet()
    const ct = res.headers.get('content-type')
    const textBody = isText(ct, buf.length) ? buf.toString('utf8') : null
    if (textBody && res.status === 200) {
      try {
        const parsed = JSON.parse(textBody) as { url?: unknown }
        if (typeof parsed.url === 'string') lastUrl = parsed.url
      } catch {
        // not JSON
      }
    }
    const kept: Record<string, string> = {}
    for (const h of KEPT_HEADERS) {
      const v = res.headers.get(h)
      if (v !== null) kept[h] = norm(v)
    }
    steps.push({
      name: st.name,
      ...stepEcho(st),
      status: res.status,
      headers: kept,
      body: textBody === null ? null : norm(textBody),
      body_len: buf.length,
      body_sum: buf.reduce((a, b) => (a + b) % 4294967296, 0),
      calls: calls.splice(0).map((c) => normCall(c, st)),
    })
  }
  for (const [k, v] of Object.entries(saved)) env[k] = v
  const state = sc.state_sql
    ? {
        sql: sc.state_sql.map((q) => (db.prepare(q).pluck().get() as string | null) ?? null),
        policies: readJson(files.policies),
        feedback: readJson(files.feedback),
        watchlist: readJson(files.watchlist),
      }
    : null
  out.push({ name: sc.name, env: sc.env ?? {}, unset: sc.unset ?? [], policies, upstream: sc.upstream, seed_sql: sc.seed_sql ?? [], state_sql: sc.state_sql ?? [], steps, state })
}

function stepEcho(st: Step) {
  return {
    ...(st.as ? { as: st.as } : {}),
    ...(st.method ? { method: st.method } : {}),
    ...(st.path ? { path: st.path } : {}),
    ...(st.token ? { token: st.token } : {}),
    ...(st.from_url ? { from_url: true } : {}),
    ...(st.headers ? { headers_in: st.headers } : {}),
    ...(st.body !== undefined ? { body_in: st.body } : {}),
    ...(st.fill ? { fill: st.fill } : {}),
    ...(st.revoke ? { revoke: st.revoke } : {}),
  }
}
/** undici's own Accept-Encoding is not the client's; large bodies as length + sum. */
function normCall(c: Call, st: Step) {
  const headers = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, norm(v)]))
  if (!Object.keys(st.headers ?? {}).some((k) => k.toLowerCase() === 'accept-encoding')) delete headers['accept-encoding']
  const big = c.body.length > 4096
  return {
    ...c,
    path: norm(c.path),
    query: norm(`?${c.query}`).slice(1),
    body: big ? null : norm(c.body),
    ...(big ? { body_len: Buffer.byteLength(c.body), body_sum: Buffer.from(c.body).reduce((a, b) => (a + b) % 4294967296, 0) } : {}),
    headers,
  }
}

console.log = log
for (const s of sockets) s.destroy()
fake.close()
fs.writeFileSync(
  path.join(here, 'proxy-goldens.json'),
  JSON.stringify({ env: ENV, members: MEMBERS, media_sql: MEDIA_SQL, account_stores: ACCOUNT_STORES, scenarios: out }, null, 2) + '\n',
)
fs.rmSync(dir, { recursive: true, force: true })
process.exit(0)
