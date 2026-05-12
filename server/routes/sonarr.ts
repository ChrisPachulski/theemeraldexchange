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
// Per-series episode list — used by DetailModal to show episode air
// dates inside each season's disclosure. Takes ?seriesId=N.
forwardRead('/api/v3/episode')
// Read-only — used by DownloadsTab to detect season clusters
// (multiple Sonarr queue entries against the same series/season) so
// the active card can label totals as Season Size + Episode Size.
forwardRead('/api/v3/queue')
// Episodes airing in a window (start/end as ISO dates). Drives the
// Upcoming strip on the Downloads tab.
forwardRead('/api/v3/calendar')

// Per-episode size cap for TV grabs. Mirrors the movie cap. A release
// passes when (size / episodeCount) ≤ maxTvBytesPerEpisode. We disable
// Sonarr's built-in search-on-add so the only way a download starts is
// through this filter — keeps 4K HDR season packs out by default.
//
// Important Sonarr quirks discovered while wiring this:
//  - GET /api/v3/release?seriesId=X (no seasonNumber) returns
//    RSS-cached recent results across the whole indexer — NOT a search
//    for that series. To actually search, we have to scope per season.
//  - Releases get rejected:true for two reasons: profile-quality
//    rejection (Choose Me doesn't allow 2160p, etc.) and indexer-level
//    issues. We *prefer* non-rejected releases so we don't accidentally
//    pick a 4K HDR pack the user's profile excludes — and so we stay
//    inside the same release pool Sonarr's auto-retry walks. Fallback
//    to the broader pool only when the profile rejects everything that
//    fits the cap (rare, but possible for niche shows).
async function grabTvUnderCap(seriesId: number, monitoredSeasons: number[]): Promise<void> {
  // Brief delay so Sonarr finishes wiring the new series record.
  await new Promise((r) => setTimeout(r, 2000))

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
    temporarilyRejected?: boolean
  }

  // Episode counts per season — used to evaluate full-season packs.
  // Sonarr's /episode endpoint is populated lazily after series add;
  // we poll briefly so we don't run with empty metadata.
  type Episode = { seasonNumber: number; episodeNumber: number; hasFile: boolean }
  const seasonEpCount = new Map<number, number>()
  for (let attempt = 0; attempt < 5; attempt++) {
    const epRes = await sonarrFetch(`/api/v3/episode?seriesId=${seriesId}`, { method: 'GET' })
    if (epRes.ok) {
      const eps = (await epRes.json()) as Episode[]
      seasonEpCount.clear()
      for (const e of eps) seasonEpCount.set(e.seasonNumber, (seasonEpCount.get(e.seasonNumber) ?? 0) + 1)
      if (seasonEpCount.size > 0) break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  // For each monitored season, do a real interactive search.
  const all: Release[] = []
  for (const seasonNumber of monitoredSeasons) {
    const url = `/api/v3/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`
    const res = await sonarrFetch(url, { method: 'GET' })
    if (!res.ok) {
      console.error(`[tv-cap] release search ${res.status} S${seasonNumber} series=${seriesId}`)
      continue
    }
    const chunk = (await res.json()) as Release[]
    all.push(...chunk)
  }

  function effectiveEpisodeCount(r: Release): number {
    if (r.fullSeason && r.seasonNumber !== undefined) {
      // Optimistic fallback when episode metadata hasn't populated:
      // assume 10 episodes (typical streaming season). Errs toward
      // *letting* a season pack through rather than rejecting it.
      return seasonEpCount.get(r.seasonNumber) ?? 10
    }
    if (r.episodeNumbers && r.episodeNumbers.length > 0) return r.episodeNumbers.length
    return 1
  }

  const monitored = new Set(monitoredSeasons)
  const within = all
    .filter((r) => r.size > 0)
    .filter((r) => r.seasonNumber === undefined || monitored.has(r.seasonNumber))
    .filter((r) => r.size / effectiveEpisodeCount(r) <= env.maxTvBytesPerEpisode)

  // Prefer releases that Sonarr's profile accepts (Choose Me is curated
  // to match what the user's usenet provider can actually deliver) and
  // that aren't temporarily rejected (blocklisted, age, etc.). Falling
  // back to the broader pool keeps things working for niche shows where
  // the profile rejects every cap-eligible release.
  const accepted = within.filter((r) => !r.rejected && !r.temporarilyRejected)
  const eligible = accepted.length > 0 ? accepted : within

  // Group by (seasonNumber, episodeKey) so we grab the single best
  // release per chunk — not five copies of the same episode. Tie-break
  // qualityWeight on smaller size: same tier on Eweka, the smaller
  // release is more likely to have intact articles (the 50 GB 2160p
  // release is the first to take a DMCA hit on HBO content).
  const bestByChunk = new Map<string, Release>()
  for (const r of eligible) {
    const key =
      r.fullSeason && r.seasonNumber !== undefined
        ? `S${r.seasonNumber}-pack`
        : `S${r.seasonNumber}E${(r.episodeNumbers ?? []).join('-')}`
    const existing = bestByChunk.get(key)
    const better =
      !existing ||
      r.qualityWeight > existing.qualityWeight ||
      (r.qualityWeight === existing.qualityWeight && r.size < existing.size)
    if (better) bestByChunk.set(key, r)
  }

  if (bestByChunk.size === 0) {
    console.log(
      `[tv-cap] no releases ≤ ${env.maxTvGbPerEpisode}GB/ep for series ${seriesId} ` +
        `(${all.length} scanned, ${within.length} cap-eligible, ${accepted.length} accepted)`,
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
      `[tv-cap] grab "${pick.title.slice(0, 80)}" ${(pick.size / 1024 ** 3).toFixed(2)}GB ` +
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
    addOptions?: {
      searchForMissingEpisodes?: boolean
      searchForCutoffUnmetEpisodes?: boolean
      monitor?: string
    }
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
        monitored?: boolean
        seasons?: Array<{ seasonNumber: number; monitored: boolean }>
      }
      const id = created.id
      // Use the seasons in the request body (pre-add intent) when
      // available — Sonarr's response sometimes lags monitor flags.
      const monitored = (body.seasons ?? created.seasons ?? [])
        .filter((s) => s.monitored)
        .map((s) => s.seasonNumber)

      // The modal's single-season picker sends
      // `addOptions.monitor: 'none'` plus an explicit seasons[] with
      // only the chosen season monitored. Sonarr's add pipeline applies
      // `addOptions.monitor` *after* the seasons[] array, so 'none'
      // ends up wiping every season's monitored flag — even the one
      // the user picked. Without this PUT-back, the series is silently
      // dropped from Sonarr's RSS sweep: our initial cap grab fires
      // once (because we use body.seasons below), but on failure
      // there's nothing monitored to recover, and the user sees a
      // permanently empty library entry. Detect the case and reconcile.
      if (
        id &&
        monitored.length > 0 &&
        body.addOptions?.monitor === 'none' &&
        created.seasons
      ) {
        const desired = new Set(monitored)
        const patched = {
          ...created,
          monitored: true,
          seasons: created.seasons.map((s) => ({
            ...s,
            monitored: desired.has(s.seasonNumber),
          })),
        }
        const putRes = await sonarrFetch(`/api/v3/series/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patched),
        })
        if (!putRes.ok) {
          console.error(`[tv-monitor] PUT series ${id} failed: ${putRes.status}`)
        }
      }

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

// Flip a single season on an existing series to monitored=true, then
// auto-grab it under the per-episode size cap. Admin only.
//
// Why this exists: when Sonarr refreshes a series and discovers a new
// season (e.g. S5 just aired but the series was added at S1-S4), the
// new season is added to seasons[] but typically lands as
// monitored:false. There's no way to ask Sonarr to "grab the new
// season" from inside the dashboard without exposing the full series
// edit surface. This route does the targeted thing: PUT the series
// with that one season flipped, then kick the cap grab.
sonarr.post('/api/v3/series/:id/seasons/:n/monitor', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const n = Number(c.req.param('n'))
  if (!Number.isFinite(id) || !Number.isFinite(n)) {
    return c.json({ error: 'bad_params' }, 400)
  }
  const getRes = await sonarrFetch(`/api/v3/series/${id}`, { method: 'GET' })
  if (!getRes.ok) {
    return new Response(await getRes.text(), { status: getRes.status })
  }
  const series = (await getRes.json()) as {
    seasons?: Array<{ seasonNumber: number; monitored: boolean }>
  }
  const seasons = series.seasons ?? []
  if (!seasons.some((s) => s.seasonNumber === n)) {
    return c.json({ error: 'season_not_found' }, 404)
  }
  const patched = {
    ...series,
    monitored: true,
    seasons: seasons.map((s) =>
      s.seasonNumber === n ? { ...s, monitored: true } : s,
    ),
  }
  const putRes = await sonarrFetch(`/api/v3/series/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patched),
  })
  if (!putRes.ok) {
    return new Response(await putRes.text(), { status: putRes.status })
  }
  // Fire the cap-enforced grab in the background — same path the add
  // flow uses, so the new season comes in via the same size gate.
  void grabTvUnderCap(id, [n]).catch((e) =>
    console.error('[tv-monitor-season] grab failed:', e),
  )
  return c.json({ ok: true, seriesId: id, seasonNumber: n })
})

// Delete a series — admin only.
sonarr.delete('/api/v3/series/:id', requireAdmin, async (c) => {
  const id = c.req.param('id')
  const search = new URL(c.req.url).searchParams
  const r = await sonarrFetch(`/api/v3/series/${id}`, { method: 'DELETE' }, search)
  return new Response(null, { status: r.status })
})
