// Minimal HTTP stubs for every upstream the backend talks to during the
// REAL-integration e2e tier (playwright project `integration` +
// `playback-chrome`). One listener hosts all upstreams under path
// prefixes; the backend is pointed at them via SONARR_URL / RADARR_URL /
// SAB_URL / PLEX_SERVER_URL / MEDIA_CORE_URL / MEDIA_TRANSCODER_URL in
// tests/e2e/helpers/integrationServer.ts.
//
// The point of this tier is exercising the REAL Hono routes, middleware,
// session crypto and proxies end-to-end from a browser — the stubs only
// replace the third-party services at the HTTP boundary, with the
// smallest response shapes the routes actually consume.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { dirname, join, normalize, resolve } from 'path'
import { fileURLToPath } from 'url'

// ESM-safe __dirname (the repo is type:module; tsx runs this as ESM).
const HELPERS_DIR = dirname(fileURLToPath(import.meta.url))

export const STUB_MOVIE = {
  tmdbId: 999_001,
  title: 'Integration Test Movie',
  year: 2024,
  overview: 'A movie that exists only in the e2e stub indexer.',
  studio: 'StubCo',
  status: 'released',
  runtime: 100,
  images: [],
}

// Radarr's view of the movie once added. id is what the cap-aware grab
// uses for the follow-up /api/v3/release?movieId= search.
const CREATED_MOVIE = {
  ...STUB_MOVIE,
  id: 42,
  qualityProfileId: 1,
  rootFolderPath: '/movies',
  monitored: false,
  hasFile: false,
  added: '2026-06-11T00:00:00Z',
}

// One Radarr-accepted release comfortably under the 10 GB movie cap and
// the 100 GB min-free gate (root folder advertises 500 GB free).
const STUB_RELEASE = {
  guid: 'stub-release-guid-1',
  indexerId: 7,
  size: 2 * 1024 ** 3,
  qualityWeight: 100,
  title: 'Integration.Test.Movie.2024.1080p.WEB-DL',
  rejected: false,
  temporarilyRejected: false,
}

const SAB_QUEUE = {
  queue: {
    status: 'Downloading',
    speedlimit: '0',
    speed: '5.5',
    sizeleft: '1.0 GB',
    size: '2.0 GB',
    eta: 'soon',
    timeleft: '0:10:00',
    paused: false,
    diskspace1: '500',
    diskspacetotal1: '1000',
    slots: [
      {
        nzo_id: 'SABnzbd_nzo_e2e1',
        filename: 'Integration.Test.Movie.2024.1080p.WEB-DL',
        cat: 'movies',
        status: 'Downloading',
        size: '2.0 GB',
        sizeleft: '1.0 GB',
        percentage: '50',
        timeleft: '0:10:00',
        index: 0,
      },
    ],
  },
}

const SAB_HISTORY = {
  history: { slots: [], total_size: '0 B', month_size: '0 B', week_size: '0 B', day_size: '0 B' },
}

export type StubState = {
  /** Bodies of every POST the backend made to Radarr /api/v3/movie. */
  radarrMovieAdds: unknown[]
  /** Bodies of every POST to Radarr /api/v3/release (the capped grab). */
  radarrGrabs: unknown[]
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

/** Directory the transcoder stub serves HLS files from
 *  (tests/fixtures/hls — the committed real-codec fixture). */
const HLS_FIXTURE_DIR = resolve(HELPERS_DIR, '../../fixtures/hls')

async function serveHlsFixture(subpath: string, res: ServerResponse): Promise<void> {
  // subpath is e.g. "index.m3u8" or "index0.ts". Resolve inside the
  // fixture dir only — this is a test stub, but path traversal hygiene
  // is free.
  const file = normalize(join(HLS_FIXTURE_DIR, subpath))
  if (!file.startsWith(HLS_FIXTURE_DIR)) {
    res.writeHead(403)
    return void res.end()
  }
  try {
    const data = await fs.readFile(file)
    // Segments use a .mpegts extension (NOT .ts) so eslint's TypeScript
    // parser never tries to lint MPEG-TS binaries; hls.js doesn't care
    // about segment extensions, only the manifest's URIs.
    const type = subpath.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp2t'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"error":"fixture_not_found"}')
  }
}

/** Start the all-upstreams stub on `port`. Returns the live state record
 *  so callers can assert on what the backend actually sent upstream. */
export function startStubUpstreams(port: number): Promise<{ server: Server; state: StubState }> {
  const state: StubState = { radarrMovieAdds: [], radarrGrabs: [] }

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      console.error('[stub-upstreams] handler error:', err)
      if (!res.headersSent) json(res, 500, { error: 'stub_error' })
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // ── Radarr ─────────────────────────────────────────────────────────
    if (path.startsWith('/radarr/')) {
      const p = path.slice('/radarr'.length)
      if (p === '/api/v3/qualityprofile') return json(res, 200, [{ id: 1, name: 'Choose Me' }])
      if (p === '/api/v3/rootfolder')
        return json(res, 200, [{ id: 1, path: '/movies', freeSpace: 500 * 1024 ** 3 }])
      if (p === '/api/v3/movie/lookup') return json(res, 200, [STUB_MOVIE])
      if (p === '/api/v3/movie' && method === 'GET') {
        // Library list (and the ?tmdbId= recover-refetch, which our
        // usable 201 body means is never strictly needed).
        if (url.searchParams.get('tmdbId')) return json(res, 200, [CREATED_MOVIE])
        return json(res, 200, [])
      }
      if (p === '/api/v3/movie' && method === 'POST') {
        state.radarrMovieAdds.push(JSON.parse(await readBody(req)))
        return json(res, 201, CREATED_MOVIE)
      }
      if (p === '/api/v3/release' && method === 'GET') return json(res, 200, [STUB_RELEASE])
      if (p === '/api/v3/release' && method === 'POST') {
        state.radarrGrabs.push(JSON.parse(await readBody(req)))
        return json(res, 200, { ok: true })
      }
      if (p === '/api/v3/queue') return json(res, 200, { records: [] })
      if (p === '/api/v3/system/status') return json(res, 200, { version: '5.0.0-stub' })
      return json(res, 404, { error: 'radarr_stub_unhandled', path: p })
    }

    // ── Sonarr ─────────────────────────────────────────────────────────
    if (path.startsWith('/sonarr/')) {
      const p = path.slice('/sonarr'.length)
      if (p === '/api/v3/series') return json(res, 200, [])
      if (p === '/api/v3/queue') return json(res, 200, { records: [] })
      if (p === '/api/v3/qualityprofile') return json(res, 200, [{ id: 1, name: 'Choose Me' }])
      if (p === '/api/v3/rootfolder')
        return json(res, 200, [{ id: 1, path: '/tv', freeSpace: 500 * 1024 ** 3 }])
      if (p === '/api/v3/system/status') return json(res, 200, { version: '4.0.0-stub' })
      return json(res, 404, { error: 'sonarr_stub_unhandled', path: p })
    }

    // ── SABnzbd ────────────────────────────────────────────────────────
    if (path === '/sab/api') {
      const mode = url.searchParams.get('mode')
      if (mode === 'queue') return json(res, 200, SAB_QUEUE)
      if (mode === 'history') return json(res, 200, SAB_HISTORY)
      return json(res, 200, { status: true })
    }

    // ── Plex Media Server (link resolver etc.) ─────────────────────────
    // The SPA's Plex deep-link queries are best-effort chrome; an empty
    // container keeps the resolver happy without modelling PMS.
    if (path.startsWith('/plex') || path === '/identity' || path.startsWith('/library')) {
      return json(res, 200, { MediaContainer: {} })
    }

    // ── Transcoder (HLS surface behind /api/transcode proxy) ──────────
    // Mirrors the real transcoder's URL space: the backend proxies
    // /api/transcode/<subpath> → <transcoderUrl>/api/transcode/<subpath>.
    const hls = path.match(/^\/transcoder\/api\/transcode\/session\/e2e-fixture\/(.+)$/)
    if (hls) return serveHlsFixture(hls[1], res)

    // ── Introspection for specs ────────────────────────────────────────
    // The stub runs in the webServer process; specs run elsewhere. This
    // endpoint lets a spec assert what the BACKEND actually sent upstream
    // (e.g. that the add-movie flow really issued the capped grab).
    if (path === '/__stub/state') return json(res, 200, state)

    return json(res, 404, { error: 'stub_unhandled', path })
  }

  return new Promise((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveStart({ server, state }))
  })
}
