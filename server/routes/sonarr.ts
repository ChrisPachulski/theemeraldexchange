// Allow-list of Sonarr endpoints. Anything not declared here returns
// 404 — the backend will not blanket-forward arbitrary paths, even
// for admins.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { sonarrFetch, sonarrRootFolders } from '../services/sonarr.js'
import { env } from '../env.js'

export const sonarr = new Hono<Env>()

// Reads — both roles
sonarr.use('*', requireAuth)

const forwardRead = (path: string) =>
  sonarr.get(path, async (c) => {
    const search = new URL(c.req.url).searchParams
    const r = await sonarrFetch(path, { method: 'GET' }, search)
    const body = await r.text()
    return new Response(body, {
      status: r.status,
      headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
    })
  })

forwardRead('/api/v3/system/status')
forwardRead('/api/v3/qualityprofile')
forwardRead('/api/v3/rootfolder')
forwardRead('/api/v3/series')
forwardRead('/api/v3/series/lookup')

// Add a series — both roles, but gated by free disk space on the
// chosen rootFolderPath.
sonarr.post('/api/v3/series', async (c) => {
  const body = (await c.req.json()) as { rootFolderPath?: string }
  if (body.rootFolderPath) {
    const folders = await sonarrRootFolders()
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
  const r = await sonarrFetch('/api/v3/series', {
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

// Delete a series — admin only.
sonarr.delete('/api/v3/series/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const search = new URL(c.req.url).searchParams
  const r = await sonarrFetch(`/api/v3/series/${id}`, { method: 'DELETE' }, search)
  return new Response(null, { status: r.status })
})
