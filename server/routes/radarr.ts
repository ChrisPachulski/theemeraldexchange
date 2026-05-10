// Allow-list of Radarr endpoints. Mirrors sonarr.ts.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { radarrFetch, radarrRootFolders } from '../services/radarr.js'
import { env } from '../env.js'

export const radarr = new Hono<Env>()

radarr.use('*', requireAuth)

const forwardRead = (path: string) =>
  radarr.get(path, async (c) => {
    const search = new URL(c.req.url).searchParams
    const r = await radarrFetch(path, { method: 'GET' }, search)
    const body = await r.text()
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
    })
  })

forwardRead('/api/v3/system/status')
forwardRead('/api/v3/qualityprofile')
forwardRead('/api/v3/rootfolder')
forwardRead('/api/v3/movie')
forwardRead('/api/v3/movie/lookup')

// Hard size cap. Radarr's auto-search can grab whatever wins its profile
// scoring — that includes 50 GB 4K HDR rips. Instead we force
// searchForMovie:false on the add, then drive our own release search
// and filter to releases under env.maxMovieBytes before grabbing.
// Fallback: if no release fits the cap, the movie stays monitored and
// Radarr's RSS sync keeps trying.
async function grabBestUnderCap(movieId: number): Promise<void> {
  // Brief delay so Radarr finishes wiring the new movie record before
  // we hit the release endpoint.
  await new Promise((r) => setTimeout(r, 1500))
  const releaseRes = await radarrFetch(`/api/v3/release?movieId=${movieId}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    console.error(`[movie-cap] release search ${releaseRes.status} for movie ${movieId}`)
    return
  }
  type Release = {
    guid: string
    indexerId: number
    size: number
    qualityWeight: number
    title: string
    rejected?: boolean
  }
  const all = (await releaseRes.json()) as Release[]
  const eligible = all
    .filter((r) => !r.rejected && r.size > 0 && r.size <= env.maxMovieBytes)
    .sort((a, b) => b.qualityWeight - a.qualityWeight)
  if (eligible.length === 0) {
    console.log(
      `[movie-cap] no releases ≤ ${env.maxMovieGb}GB for movie ${movieId} ` +
        `(${all.length} scanned)`,
    )
    return
  }
  const best = eligible[0]
  const grabRes = await radarrFetch('/api/v3/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }),
  })
  console.log(
    `[movie-cap] grab "${best.title}" ${(best.size / 1024 ** 3).toFixed(2)}GB ` +
      `for movie ${movieId} → ${grabRes.status}`,
  )
}

radarr.post('/api/v3/movie', async (c) => {
  const body = (await c.req.json()) as {
    rootFolderPath?: string
    addOptions?: { searchForMovie?: boolean }
  }
  if (body.rootFolderPath) {
    const folders = await radarrRootFolders()
    const folder = folders.find((f) => f.path === body.rootFolderPath)
    if (folder?.freeSpace !== undefined && folder.freeSpace < env.minFreeBytes) {
      return c.json(
        {
          error: 'insufficient_disk_space',
          free_bytes: folder.freeSpace,
          threshold_bytes: env.minFreeBytes,
          path: folder.path,
        },
        507,
      )
    }
  }

  // Capture the user's intent then disable Radarr's built-in search.
  // The only way a download starts is via grabBestUnderCap below, so
  // the size cap is unconditional.
  const wantedSearch = body.addOptions?.searchForMovie !== false
  const cappedBody = {
    ...body,
    addOptions: { ...(body.addOptions ?? {}), searchForMovie: false },
  }

  const r = await radarrFetch('/api/v3/movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cappedBody),
  })
  const out = await r.text()

  // Fire the size-capped grab in the background. Indexer search can be
  // slow; we don't want to block the modal close.
  if (r.ok && wantedSearch) {
    try {
      const created = JSON.parse(out) as { id?: number }
      if (created.id) {
        void grabBestUnderCap(created.id).catch((e) =>
          console.error('[movie-cap] grab failed:', e),
        )
      }
    } catch {
      // Radarr returned an unexpected body shape; pass through. The
      // movie was still added if r.ok was true.
    }
  }

  return new Response(out, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
  })
})

radarr.delete('/api/v3/movie/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const search = new URL(c.req.url).searchParams
  const r = await radarrFetch(`/api/v3/movie/${id}`, { method: 'DELETE' }, search)
  return new Response(null, { status: r.status })
})
