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

// Per-episode size cap for TV grabs. Mirrors the movie cap. A release
// passes when (size / episodeCount) ≤ maxTvBytesPerEpisode. We disable
// Sonarr's built-in search-on-add so the only way a download starts is
// through this filter — keeps 4K HDR season packs out by default.
async function grabTvUnderCap(seriesId: number, monitoredSeasons: number[]): Promise<void> {
  // Brief delay so Sonarr finishes wiring the new series record.
  await new Promise((r) => setTimeout(r, 1500))

  type Release = {
    guid: string
    indexerId: number
    size: number
    qualityWeight: number
    title: string
    seasonNumber?: number
    episodeNumbers?: number[]
    fullSeason?: boolean
    rejected?: boolean
  }

  // Sonarr's series-scoped release endpoint triggers a search and
  // returns the union of single-ep and season-pack releases for every
  // monitored season.
  const releaseRes = await sonarrFetch(`/api/v3/release?seriesId=${seriesId}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    console.error(`[tv-cap] release search ${releaseRes.status} for series ${seriesId}`)
    return
  }
  const all = (await releaseRes.json()) as Release[]

  // We need episode counts per season to evaluate full-season packs.
  // Sonarr exposes episodeCount on the season-stats endpoint; cheaper
  // path is /api/v3/episode?seriesId=X which we group locally.
  const epRes = await sonarrFetch(`/api/v3/episode?seriesId=${seriesId}`, {
    method: 'GET',
  })
  type Episode = { seasonNumber: number; episodeNumber: number; hasFile: boolean }
  const eps = epRes.ok ? ((await epRes.json()) as Episode[]) : []
  const seasonEpCount = new Map<number, number>()
  for (const e of eps) seasonEpCount.set(e.seasonNumber, (seasonEpCount.get(e.seasonNumber) ?? 0) + 1)

  function effectiveEpisodeCount(r: Release): number {
    if (r.episodeNumbers && r.episodeNumbers.length > 0) return r.episodeNumbers.length
    if (r.fullSeason && r.seasonNumber !== undefined) {
      return seasonEpCount.get(r.seasonNumber) ?? 1
    }
    // Unknown shape — assume single episode so we err on the safe side
    // (treats unknown as the strictest possible cap).
    return 1
  }

  const monitored = new Set(monitoredSeasons)
  const eligible = all
    .filter((r) => !r.rejected && r.size > 0)
    .filter((r) => r.seasonNumber === undefined || monitored.has(r.seasonNumber))
    .filter((r) => r.size / effectiveEpisodeCount(r) <= env.maxTvBytesPerEpisode)

  // Group by (seasonNumber, episodeKey) so we grab the single best
  // release per chunk — not five copies of the same episode.
  const bestByChunk = new Map<string, Release>()
  for (const r of eligible) {
    const key =
      r.fullSeason && r.seasonNumber !== undefined
        ? `S${r.seasonNumber}-pack`
        : `S${r.seasonNumber}E${(r.episodeNumbers ?? []).join('-')}`
    const existing = bestByChunk.get(key)
    if (!existing || r.qualityWeight > existing.qualityWeight) {
      bestByChunk.set(key, r)
    }
  }

  if (bestByChunk.size === 0) {
    console.log(
      `[tv-cap] no releases ≤ ${env.maxTvGbPerEpisode}GB/ep for series ${seriesId} ` +
        `(${all.length} scanned)`,
    )
    return
  }

  // Prefer season packs over individual episodes for the same season —
  // fewer NZBs through SAB, faster post-processing.
  const packs = [...bestByChunk.values()].filter((r) => r.fullSeason)
  const packSeasons = new Set(packs.map((r) => r.seasonNumber))
  const finalPicks = [
    ...packs,
    ...[...bestByChunk.values()].filter((r) => !r.fullSeason && !packSeasons.has(r.seasonNumber)),
  ]

  for (const pick of finalPicks) {
    const grabRes = await sonarrFetch('/api/v3/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: pick.guid, indexerId: pick.indexerId }),
    })
    const ec = effectiveEpisodeCount(pick)
    console.log(
      `[tv-cap] grab "${pick.title}" ${(pick.size / 1024 ** 3).toFixed(2)}GB ` +
        `(~${(pick.size / ec / 1024 ** 3).toFixed(2)}GB/ep, ${ec} ep) ` +
        `series=${seriesId} → ${grabRes.status}`,
    )
  }
}

// Add a series — both roles, but gated by free disk space on the
// chosen rootFolderPath. Search-on-add is forced off so our cap filter
// is the only path that starts a download.
sonarr.post('/api/v3/series', async (c) => {
  const body = (await c.req.json()) as {
    rootFolderPath?: string
    addOptions?: { searchForMissingEpisodes?: boolean; searchForCutoffUnmetEpisodes?: boolean }
    seasons?: Array<{ seasonNumber: number; monitored: boolean }>
  }
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

  const wantedSearch =
    body.addOptions?.searchForMissingEpisodes !== false ||
    body.addOptions?.searchForCutoffUnmetEpisodes === true
  const cappedBody = {
    ...body,
    addOptions: {
      ...(body.addOptions ?? {}),
      searchForMissingEpisodes: false,
      searchForCutoffUnmetEpisodes: false,
    },
  }

  const r = await sonarrFetch('/api/v3/series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cappedBody),
  })
  const out = await r.text()

  if (r.ok && wantedSearch) {
    try {
      const created = JSON.parse(out) as {
        id?: number
        seasons?: Array<{ seasonNumber: number; monitored: boolean }>
      }
      const id = created.id
      // Use the seasons in the request body (pre-add intent) when
      // available — Sonarr's response sometimes lags monitor flags.
      const monitored = (body.seasons ?? created.seasons ?? [])
        .filter((s) => s.monitored)
        .map((s) => s.seasonNumber)
      if (id && monitored.length > 0) {
        void grabTvUnderCap(id, monitored).catch((e) =>
          console.error('[tv-cap] grab failed:', e),
        )
      }
    } catch {
      // Pass through; series was added if r.ok.
    }
  }

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
