// Fixture-backed mock of the Rust media-core HTTP surface, for SPA/UI
// development WITHOUT the real Rust stack or a real /media library.
//
// The backend proxy (server/routes/media.ts) is intentionally mock-agnostic:
// it reaches media-core through MEDIA_CORE_URL. Point that env var at this
// process and the existing Hono proxy forwards to it unchanged. This stub
// speaks media-core's surface (the routes media.ts actually calls) and serves
// the committed sample.mp4 (server/mocks/fixtures/sample.mp4) for every
// playable title.
//
// SCOPE: direct-play only. There is no transcode/HLS handoff here — the grant
// always answers `{ directPlay: true }`, so the backend proxy mints a
// progressive stream token and the bytes flow through /stream. The HLS path is
// a deliberate, documented scope cut (see plan 005 + maintenance notes).
//
// AUTH: this mock ignores Authorization entirely. That is the dev fail-open
// double of a fail-closed prod boundary — acceptable ONLY because it binds to
// 127.0.0.1 and serves fixtures. NEVER bind it to 0.0.0.0 or reference it from
// docker-compose.

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
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

// media-core clamps `limit` to 1..=200 and defaults to 50 when omitted; the
// SPA's fetchAllPages relies on that contract (src/lib/api/media.ts). Mirror
// it so paging neither loops forever nor undercounts.
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Parse a clamped, defaulted `limit`/`offset` pair from a query string. */
function pageParams(c: { req: { query: (k: string) => string | undefined } }): {
  limit: number
  offset: number
} {
  const rawLimit = Number(c.req.query('limit'))
  const rawOffset = Number(c.req.query('offset'))
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

/** Case-insensitive substring filter on `title`. */
function filterByQuery<T extends { title: string }>(rows: T[], q: string | undefined): T[] {
  if (!q) return rows
  const needle = q.toLowerCase()
  return rows.filter((r) => r.title.toLowerCase().includes(needle))
}

/** In-memory watch store, seeded from the fixtures so continue-watching has
 *  data on first load. One row per (kind, id), matching the SPA's upsert
 *  identity. Module-level so it survives across requests within a process; the
 *  test imports a fresh module per file so cross-test bleed isn't a concern. */
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

export const app = new Hono()

// ── List routes ───────────────────────────────────────────────────────

app.get('/api/media/movies', (c) => {
  const filtered = filterByQuery(MOVIES, c.req.query('q'))
  const { limit, offset } = pageParams(c)
  const items = filtered.slice(offset, offset + limit)
  return c.json({ items, total: filtered.length })
})

app.get('/api/media/shows', (c) => {
  const filtered = filterByQuery(SHOWS, c.req.query('q'))
  const { limit, offset } = pageParams(c)
  const items = filtered.slice(offset, offset + limit)
  return c.json({ items, total: filtered.length })
})

app.get('/api/media/shows/:id/episodes', (c) => {
  const showId = Number(c.req.param('id'))
  const items = EPISODES.filter((e) => e.show_id === showId)
  return c.json({ items, total: items.length })
})

// ── Scan ──────────────────────────────────────────────────────────────

app.post('/api/media/scan', (c) => c.json({ status: 'started' }))

// ── Watch progress ────────────────────────────────────────────────────

app.get('/api/media/watch', (c) => {
  // Newest first, mirroring how a real store would order by watched_at desc.
  const items = [...watchStore.values()].sort((a, b) =>
    b.watched_at.localeCompare(a.watched_at),
  )
  return c.json({ items })
})

app.post('/api/media/watch', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as WatchUpsertBody
  const kind = body.media_kind
  const id = Number(body.media_id)
  if ((kind !== 'movie' && kind !== 'episode') || !Number.isFinite(id)) {
    return c.json({ error: 'invalid_watch_body' }, 400)
  }
  const position = Number(body.position_secs)
  const duration =
    body.duration_secs == null ? null : Number(body.duration_secs)
  const row: MockWatchRow = {
    media_kind: kind,
    media_id: id,
    position_secs: Number.isFinite(position) ? Math.max(0, Math.floor(position)) : 0,
    duration_secs:
      duration != null && Number.isFinite(duration) ? Math.floor(duration) : null,
    watched_at: new Date().toISOString(),
    completed: body.completed ? 1 : 0,
  }
  watchStore.set(watchKey(kind, id), row)
  return c.json({ ok: true })
})

// ── Playback grant ────────────────────────────────────────────────────
//
// Always direct-play. The backend proxy (media.ts:209) then mints a
// progressive stream token and returns { delivery: 'progressive', url }.
// Unknown id → 404 JSON, which media.ts:197 maps to `not_found`.

app.post('/api/media/play/:kind/:id/grant', (c) => {
  const kind = c.req.param('kind')
  const id = Number(c.req.param('id'))
  const playable = Number.isFinite(id) ? findPlayable(kind, id) : null
  if (!playable) {
    return c.json({ error: 'not_found' }, 404)
  }
  return c.json({
    directPlay: true,
    file: { duration_secs: playable.durationSecs },
  })
})

// ── Direct-play stream bytes ──────────────────────────────────────────
//
// Serve the single committed sample.mp4 with real HTTP Range support — a
// <video> element's seek issues `Range: bytes=a-b` and needs a true 206 +
// Content-Range, not a faked full body. A single `bytes=a-b` (or open-ended
// `bytes=a-`) range is honored; anything else falls back to a 200 full body.

app.get('/api/media/stream/:kind/:id', async (c) => {
  const kind = c.req.param('kind')
  const id = Number(c.req.param('id'))
  const playable = Number.isFinite(id) ? findPlayable(kind, id) : null
  if (!playable) {
    return c.json({ error: 'not_found' }, 404)
  }

  let file: Buffer
  try {
    file = await readFile(SAMPLE_PATH)
  } catch {
    // The sample is committed; a missing file is a setup error, surfaced
    // loudly rather than silently serving an empty body.
    return c.json({ error: 'sample_missing', path: SAMPLE_PATH }, 500)
  }
  const total = file.length

  const rangeHeader = c.req.header('range')
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/)
  if (match && (match[1] !== '' || match[2] !== '')) {
    const start = match[1] === '' ? 0 : Number(match[1])
    const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1)
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      // Unsatisfiable range — RFC 7233 §4.4.
      return c.body(null, 416, {
        'content-range': `bytes */${total}`,
        'accept-ranges': 'bytes',
      })
    }
    const chunk = file.subarray(start, end + 1)
    return c.body(toArrayBuffer(chunk), 206, {
      'content-type': 'video/mp4',
      'content-length': String(chunk.length),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
    })
  }

  return c.body(toArrayBuffer(file), 200, {
    'content-type': 'video/mp4',
    'content-length': String(total),
    'accept-ranges': 'bytes',
  })
})

/** Copy a Buffer's exact byte window into a standalone ArrayBuffer (a Node
 *  Buffer view may span a larger pooled allocation; handing its raw
 *  `.buffer` to Response would leak neighbouring bytes). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buf.length)
  new Uint8Array(out).set(buf)
  return out
}

// ── Everything else: loud 404 ─────────────────────────────────────────
//
// A gap (a media-core route this mock hasn't implemented) is surfaced as a
// distinct error so it's loud, not silently swallowed by the backend proxy.

app.all('/*', (c) =>
  c.json({ error: 'mock_unimplemented', path: new URL(c.req.url).pathname }, 404),
)

// ── Listener (only when run directly, not when imported by tests) ──────

const PORT = Number(process.env.MEDIA_CORE_MOCK_PORT) || 8095

function isMain(): boolean {
  // Started via `tsx server/mocks/mediaCoreMock.ts`? process.argv[1] is this
  // file. Tests import the module instead, so they skip the listener.
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return fileURLToPath(import.meta.url) === entry || entry.endsWith('mediaCoreMock.ts')
  } catch {
    return false
  }
}

if (isMain()) {
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
    console.log(
      `[media-core-mock] listening on http://127.0.0.1:${info.port} ` +
        `(${MOVIES.length} movies, ${SHOWS.length} shows, ${EPISODES.length} episodes) — ` +
        `point MEDIA_CORE_URL here`,
    )
  })
}
