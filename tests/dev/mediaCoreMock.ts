// Fixture-backed mock of the Rust media-core HTTP surface, for SPA/UI
// development WITHOUT the real Rust stack or a real /media library.
//
// The gateway's media proxy (crates/gateway/src/proxy/media.rs) is
// mock-agnostic: it reaches media-core through MEDIA_CORE_URL. Point that env
// var at this process (with USE_MEDIA_CORE=1) and the gateway forwards to it
// unchanged. This stub speaks media-core's surface (the routes the proxy
// actually calls) and serves the committed sample.mp4
// (tests/dev/fixtures/sample.mp4) for every playable title.
//
// Run: npm run dev:media-mock
//
// SCOPE: direct-play only. There is no transcode/HLS handoff here — the grant
// always answers `{ directPlay: true }`, so the gateway mints a
// progressive stream token and the bytes flow through /stream. The HLS path is
// a deliberate, documented scope cut (see plan 005 + maintenance notes).
//
// AUTH: this mock ignores Authorization entirely. That is the dev fail-open
// double of a fail-closed prod boundary — acceptable ONLY because it binds to
// 127.0.0.1 and serves fixtures. NEVER bind it to 0.0.0.0 or reference it from
// docker-compose.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MOVIES,
  SHOWS,
  EPISODES,
  SEED_WATCH_ROWS,
  watchKey,
  findPlayable,
  type MockWatchRow,
} from './fixtures.js'

const SAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.mp4')
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#24332c"/></svg>'

// media-core clamps `limit` to 1..=200 and defaults to 50 when omitted; the
// SPA's fetchAllPages relies on that contract (src/lib/api/media.ts). Mirror
// it so paging neither loops forever nor undercounts.
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Parse a clamped, defaulted `limit`/`offset` pair from a query string. */
function pageParams(q: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = Number(q.get('limit') ?? undefined)
  const rawOffset = Number(q.get('offset') ?? undefined)
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

/** Case-insensitive substring filter on `title`. */
function filterByQuery<T extends { title: string }>(rows: T[], q: string | null): T[] {
  if (!q) return rows
  const needle = q.toLowerCase()
  return rows.filter((r) => r.title.toLowerCase().includes(needle))
}

/** In-memory watch store, seeded from the fixtures so continue-watching has
 *  data on first load. One row per (kind, id), matching the SPA's upsert
 *  identity. Module-level so it survives across requests within a process. */
const watchStore = new Map<string, MockWatchRow>()
for (const row of SEED_WATCH_ROWS) {
  watchStore.set(watchKey(row.media_kind, row.media_id), { ...row })
}

/** Body shape the SPA POSTs to /watch (WatchUpsertBody in
 *  src/lib/api/media.ts): snake_case, `completed` a boolean. */
type WatchUpsertBody = {
  media_kind?: unknown
  media_id?: unknown
  position_secs?: unknown
  duration_secs?: unknown
  completed?: unknown
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

/** Paged list body for one of the fixture tables. */
function list<T extends { title: string }>(rows: T[], q: URLSearchParams): Response {
  const filtered = filterByQuery(rows, q.get('q'))
  const { limit, offset } = pageParams(q)
  return json({ items: filtered.slice(offset, offset + limit), total: filtered.length })
}

/** The mock's whole surface as one Fetch handler (tests call it in-process). */
export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  let m: RegExpExecArray | null

  // ── List routes ─────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/media/movies') return list(MOVIES, url.searchParams)
  if (method === 'GET' && path === '/api/media/shows') return list(SHOWS, url.searchParams)
  if (method === 'GET' && (m = /^\/api\/media\/shows\/([^/]+)\/episodes$/.exec(path))) {
    const showId = Number(m[1])
    const items = EPISODES.filter((e) => e.show_id === showId)
    return json({ items, total: items.length })
  }

  // ── Scan ────────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/media/scan') return json({ status: 'started' })

  // ── Watch progress ──────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/media/watch') {
    // Newest first, mirroring how a real store would order by watched_at desc.
    const items = [...watchStore.values()].sort((a, b) =>
      b.watched_at.localeCompare(a.watched_at),
    )
    return json({ items })
  }
  if (method === 'POST' && path === '/api/media/watch') {
    const body = (await req.json().catch(() => ({}))) as WatchUpsertBody
    const kind = body.media_kind
    const id = Number(body.media_id)
    if ((kind !== 'movie' && kind !== 'episode') || !Number.isFinite(id)) {
      return json({ error: 'invalid_watch_body' }, 400)
    }
    const position = Number(body.position_secs)
    const duration = body.duration_secs == null ? null : Number(body.duration_secs)
    watchStore.set(watchKey(kind, id), {
      media_kind: kind,
      media_id: id,
      position_secs: Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0,
      duration_secs: duration != null && Number.isFinite(duration) ? Math.floor(duration) : null,
      watched_at: new Date().toISOString(),
      completed: body.completed ? 1 : 0,
    })
    return json({ ok: true })
  }

  // ── Playback grant ──────────────────────────────────────────────────
  //
  // Always direct-play: the gateway then mints a progressive stream token and
  // returns { delivery: 'progressive', url }. Unknown id → 404 JSON, which
  // the gateway maps to `not_found`.
  if (method === 'POST' && (m = /^\/api\/media\/play\/([^/]+)\/([^/]+)\/grant$/.exec(path))) {
    const id = Number(m[2])
    const playable = Number.isFinite(id) ? findPlayable(m[1], id) : null
    if (!playable) return json({ error: 'not_found' }, 404)
    return json({ directPlay: true, file: { duration_secs: playable.durationSecs } })
  }

  // ── Direct-play stream bytes ────────────────────────────────────────
  //
  // Serve the single committed sample.mp4 with real HTTP Range support — a
  // <video> element's seek issues `Range: bytes=a-b` and needs a true 206 +
  // Content-Range, not a faked full body. A single `bytes=a-b` (or open-ended
  // `bytes=a-`) range is honored; anything else falls back to a 200 full body.
  if (method === 'GET' && (m = /^\/api\/media\/stream\/([^/]+)\/([^/]+)$/.exec(path))) {
    const id = Number(m[2])
    const playable = Number.isFinite(id) ? findPlayable(m[1], id) : null
    if (!playable) return json({ error: 'not_found' }, 404)
    return streamSample(req.headers.get('range'))
  }

  // ── Artwork ─────────────────────────────────────────────────────────
  //
  // media-core answers /images/{kind}/{id}?w= with a resized WebP. The mock
  // has no artwork, so every poster, cover and photo is one flat SVG tile
  // (the gateway does not forward a redirect, so TMDB art cannot be relayed).
  if (method === 'GET' && /^\/api\/media\/images\/[^/]+\/[^/]+$/.test(path)) {
    return new Response(PLACEHOLDER_SVG, { headers: { 'content-type': 'image/svg+xml' } })
  }

  // ── Everything else: loud 404 ───────────────────────────────────────
  //
  // A gap (a media-core route this mock hasn't implemented) is surfaced as a
  // distinct error so it's loud, not silently swallowed by the proxy.
  return json({ error: 'mock_unimplemented', path }, 404)
}

async function streamSample(rangeHeader: string | null): Promise<Response> {
  let file: Buffer
  try {
    file = await readFile(SAMPLE_PATH)
  } catch {
    // The sample is committed; a missing file is a setup error, surfaced
    // loudly rather than silently serving an empty body.
    return json({ error: 'sample_missing', path: SAMPLE_PATH }, 500)
  }
  const total = file.length
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (match && (match[1] !== '' || match[2] !== '')) {
    const start = match[1] === '' ? 0 : Number(match[1])
    const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      // Unsatisfiable range — RFC 7233 §4.4.
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
      })
    }
    const chunk = file.subarray(start, end + 1)
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(chunk.length),
        'content-range': `bytes ${start}-${end}/${total}`,
        'accept-ranges': 'bytes',
      },
    })
  }
  return new Response(new Uint8Array(file), {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      'content-length': String(total),
      'accept-ranges': 'bytes',
    },
  })
}

// ── Listener (only when run directly, not when imported by tests) ──────

const PORT = Number(process.env.MEDIA_CORE_MOCK_PORT) || 8095

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === entry || entry.endsWith('mediaCoreMock.ts')
  } catch {
    return false
  }
}

if (isMain()) {
  createServer(async (nodeReq, nodeRes) => {
    const chunks: Buffer[] = []
    for await (const c of nodeReq) chunks.push(c as Buffer)
    const headers = new Headers()
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') headers.set(k, v)
    }
    const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD'
    const res = await handle(
      new Request(`http://127.0.0.1:${PORT}${nodeReq.url ?? '/'}`, {
        method: nodeReq.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }),
    )
    nodeRes.writeHead(res.status, Object.fromEntries(res.headers))
    nodeRes.end(Buffer.from(await res.arrayBuffer()))
  }).listen(PORT, '127.0.0.1', () => {
    console.log(
      `[media-core-mock] listening on http://127.0.0.1:${PORT} ` +
        `(${MOVIES.length} movies, ${SHOWS.length} shows, ${EPISODES.length} episodes) — ` +
        `point MEDIA_CORE_URL here`,
    )
  })
}
