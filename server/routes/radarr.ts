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

radarr.post('/api/v3/movie', async (c) => {
  const body = (await c.req.json()) as { rootFolderPath?: string }
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
  const r = await radarrFetch('/api/v3/movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await r.text()
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
