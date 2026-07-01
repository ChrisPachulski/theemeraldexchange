// Allow-list of Sonarr endpoints. Anything not declared here returns
// 404 — the backend will not blanket-forward arbitrary paths, even
// for admins.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { requireSection } from '../services/userPolicies.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { sonarrFetch, sonarrRootFolders } from '../services/sonarr.js'
import { SEARCH_TIMEOUT_MS } from '../services/upstream.js'
import {
  createGrabEventRecorder,
  createReservationLedger,
  type RootFolderSpaceSnapshot,
} from '../services/arrGrab.js'
import {
  addResolveStatus,
  gateRootFolderSpace,
  materializeFailurePayload,
  materializeNonAdminAddBody,
  validateHonoredAddBody,
  type Release,
} from '../services/arrAdd.js'
import {
  buildCommandBody,
  executeInteractiveGrab,
  extractEditPatch,
  interactiveGrabResponse,
  mapHistory,
  mergeEdit,
  parseInteractiveGrab,
  projectRelease,
  type ClientRelease,
  type CommandSpec,
  type UpstreamRelease,
} from '../services/arrAdvanced.js'
import { postFeedback } from '../services/recommender.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { env } from '../env.js'

export const sonarr = new Hono<Env>()

// Reads — both roles
sonarr.use('*', requireAuth)
// Section gate: a policy that denies `arr` blocks add/manage mutations
// (POST/PUT/DELETE) while leaving reads open. Admins are never blocked.
sonarr.use('*', requireSection('arr', { mutationsOnly: true }))

// Per-session token bucket on the release-search-bearing mutate routes
// (finding 4-0). Series add + season-monitor each kick a real per-season
// interactive indexer search; cap the rate to stop an authenticated loop
// from burning the indexer/usenet budget.
const sonarrMutateLimit = rateLimit({
  name: 'sonarr-mutate',
  capacity: env.arrMutateRateCapacity,
  refill: env.arrMutateRateRefill,
  intervalMs: env.arrMutateRateIntervalMs,
})

// In-flight disk-space reservations against root-folder free space.
// Mechanism + rationale live in services/arrGrab.ts; this instance is
// Sonarr's own ledger (Radarr keeps a separate one).
const sonarrReservations = createReservationLedger('sonarr')

const recordSonarrGrabEvent = createGrabEventRecorder('sonarr')

async function loadSonarrRootFolders(): Promise<
  | { ok: true; folders: Awaited<ReturnType<typeof sonarrRootFolders>> }
  | { ok: false; response: Response }
> {
  try {
    return { ok: true, folders: await sonarrRootFolders() }
  } catch (err) {
    console.error('[sonarr] rootfolder lookup failed:', err)
    const message = err instanceof Error ? err.message : String(err)
    const status = /\b50[34]\b/.test(message) ? 503 : 502
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'rootfolder_unreachable' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
  }
}

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

// Admin-only: clear downloads jammed in Sonarr's import stage
// (trackedDownloadState importPending/importBlocked). These are completed
// downloads Sonarr can't move into the library; left alone they pile up in
// the queue forever and the Downloads tab can't act on them. Removes from
// the client, blocklists the bad release, and lets Sonarr re-search for a
// parseable replacement. Rate-limited because each removal kicks a search.
sonarr.post('/api/v3/queue/clear-stuck', requireAdmin, sonarrMutateLimit, async (c) => {
  const qr = await sonarrFetch(
    '/api/v3/queue',
    { method: 'GET' },
    new URLSearchParams({ pageSize: '2000' }),
  )
  if (!qr.ok) return c.json({ error: 'queue_unreachable' }, 502)
  const page = (await qr.json()) as {
    records?: Array<{ id: number; trackedDownloadState?: string }>
  }
  const ids = (page.records ?? [])
    .filter(
      (r) =>
        r.trackedDownloadState === 'importPending' ||
        r.trackedDownloadState === 'importBlocked',
    )
    .map((r) => r.id)
  if (ids.length === 0) return c.json({ removed: 0 })
  const del = await sonarrFetch(
    '/api/v3/queue/bulk',
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    },
    new URLSearchParams({
      removeFromClient: 'true',
      blocklist: 'true',
      skipRedownload: 'false',
    }),
  )
  if (!del.ok) return c.json({ error: 'bulk_delete_failed', status: del.status }, 502)
  return c.json({ removed: ids.length })
})

// ===========================================================================
// Advanced options (admin-only power-user actions). Contract: S1–S7 in
// docs/superpowers/specs/2026-06-22-arr-advanced-options-design.md. The web
// SPA and the Apple client are thin consumers of these handlers.
// ===========================================================================

// S1 allowlist. RefreshSeries/SeriesSearch operate on the series as a whole;
// EpisodeSearch needs the episode ids; RenameFiles needs the series id + the
// episode-file ids. Any other name → 400 (command_not_allowed).
const SONARR_COMMANDS: Record<string, CommandSpec> = {
  RefreshSeries: { passthrough: ['seriesId'] },
  SeriesSearch: { passthrough: ['seriesId'] },
  EpisodeSearch: { requires: ['episodeIds'], passthrough: ['episodeIds'] },
  RenameFiles: { requires: ['seriesId', 'files'], passthrough: ['seriesId', 'files'] },
}

// Per-season episode counts for a series, used to compute the per-release TV
// cap (maxTvBytesPerEpisode × episodeCount). Returns an empty map on failure
// — callers fail open (treat the release as within cap) rather than block an
// admin's hand-picked grab on a metadata hiccup.
async function seasonEpisodeCounts(seriesId: number): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  const res = await sonarrFetch(`/api/v3/episode?seriesId=${seriesId}`, { method: 'GET' })
  if (!res.ok) return counts
  const eps = (await res.json().catch(() => [])) as Array<{ seasonNumber?: number }>
  for (const e of eps) {
    if (typeof e.seasonNumber === 'number') {
      counts.set(e.seasonNumber, (counts.get(e.seasonNumber) ?? 0) + 1)
    }
  }
  return counts
}

// Per-release TV byte ceiling: maxTvBytesPerEpisode × the release's episode
// count (full-season packs use the season episode count; otherwise the
// number of episodes in the release, defaulting to 1). null when we can't
// determine the count — projectRelease treats null as "not over cap".
function tvCapBytesFor(r: UpstreamRelease, counts: Map<number, number>): number | null {
  let epCount: number | null
  if (r.fullSeason && typeof r.seasonNumber === 'number') {
    epCount = counts.get(r.seasonNumber) ?? null
  } else if (r.episodeNumbers && r.episodeNumbers.length > 0) {
    epCount = r.episodeNumbers.length
  } else {
    epCount = 1
  }
  return epCount === null ? null : env.maxTvBytesPerEpisode * epCount
}

// S1: POST /api/v3/command — fire an allowlisted Sonarr command.
sonarr.post('/api/v3/command', requireAdmin, sonarrMutateLimit, async (c) => {
  const built = buildCommandBody(await c.req.json().catch(() => null), SONARR_COMMANDS)
  if (!built.ok) {
    return c.json({ error: built.error }, 400)
  }
  const r = await sonarrFetch('/api/v3/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(built.body),
  })
  if (!r.ok) {
    return c.json({ error: 'command_failed', status: r.status }, 502)
  }
  const cmd = (await r.json().catch(() => ({}))) as { id?: number; name?: string; status?: string }
  return c.json({ id: cmd.id, name: cmd.name, status: cmd.status })
})

// S2: GET /api/v3/release?seriesId=&seasonNumber= — interactive search.
// Projects upstream releases to the client shape, computing sizeGb + overCap.
sonarr.get('/api/v3/release', requireAdmin, sonarrMutateLimit, async (c) => {
  const seriesId = Number(c.req.query('seriesId'))
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return c.json({ error: 'bad_seriesId' }, 400)
  }
  const seasonNumber = c.req.query('seasonNumber')
  const query = new URLSearchParams({ seriesId: String(seriesId) })
  if (seasonNumber !== undefined && seasonNumber !== '') {
    const n = Number(seasonNumber)
    if (!Number.isSafeInteger(n) || n < 0) return c.json({ error: 'bad_seasonNumber' }, 400)
    query.set('seasonNumber', String(n))
  }
  const [releaseRes, counts] = await Promise.all([
    sonarrFetch('/api/v3/release', { method: 'GET' }, query, SEARCH_TIMEOUT_MS),
    seasonEpisodeCounts(seriesId),
  ])
  if (!releaseRes.ok) {
    return c.json({ error: 'release_search_failed', status: releaseRes.status }, 502)
  }
  const releases = (await releaseRes.json().catch(() => [])) as UpstreamRelease[]
  const projected: ClientRelease[] = releases.map((r) =>
    projectRelease(r, (rel) => tvCapBytesFor(rel, counts)),
  )
  return c.json(projected)
})

// S3: POST /api/v3/release — grab a hand-picked release under (or over, with
// allowOverCap) the per-episode cap. Reuses the grab-event recorder.
sonarr.post('/api/v3/release', requireAdmin, sonarrMutateLimit, async (c) => {
  const parsed = parseInteractiveGrab(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: 'invalid_body' }, 400)
  const seriesId = Number(c.req.query('seriesId'))
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return c.json({ error: 'bad_seriesId' }, 400)
  }
  const seasonNumber = c.req.query('seasonNumber')
  const query = new URLSearchParams({ seriesId: String(seriesId) })
  if (seasonNumber !== undefined && seasonNumber !== '') {
    const n = Number(seasonNumber)
    if (Number.isSafeInteger(n) && n >= 0) query.set('seasonNumber', String(n))
  }
  const counts = await seasonEpisodeCounts(seriesId)
  const result = await executeInteractiveGrab({
    itemId: seriesId,
    sub: c.get('session').sub,
    req: parsed.req,
    capGb: env.maxTvGbPerEpisode,
    capBytesFor: (rel) => tvCapBytesFor(rel, counts),
    listReleases: async () => {
      const res = await sonarrFetch('/api/v3/release', { method: 'GET' }, query, SEARCH_TIMEOUT_MS)
      if (!res.ok) return null
      return (await res.json().catch(() => [])) as UpstreamRelease[]
    },
    postGrab: async (guid, indexerId) => {
      const res = await sonarrFetch('/api/v3/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, indexerId }),
      })
      return { ok: res.ok, status: res.status }
    },
    recordEvent: recordSonarrGrabEvent,
  })
  return interactiveGrabResponse(c, result)
})

// S4: GET /api/v3/rename?seriesId= — preview the rename diff.
sonarr.get('/api/v3/rename', requireAdmin, async (c) => {
  const seriesId = Number(c.req.query('seriesId'))
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return c.json({ error: 'bad_seriesId' }, 400)
  }
  const r = await sonarrFetch(
    '/api/v3/rename',
    { method: 'GET' },
    new URLSearchParams({ seriesId: String(seriesId) }),
  )
  if (!r.ok) return c.json({ error: 'rename_preview_failed', status: r.status }, 502)
  const rows = (await r.json().catch(() => [])) as Array<{
    episodeFileId?: number
    seasonNumber?: number
    existingPath?: string
    newPath?: string
  }>
  return c.json(
    rows.map((row) => ({
      episodeFileId: row.episodeFileId,
      seasonNumber: row.seasonNumber,
      existingPath: row.existingPath,
      newPath: row.newPath,
    })),
  )
})

// S5: PUT /api/v3/episode/monitor — batch monitor toggle.
sonarr.put('/api/v3/episode/monitor', requireAdmin, sonarrMutateLimit, async (c) => {
  const raw = (await c.req.json().catch(() => null)) as
    | { episodeIds?: unknown; monitored?: unknown }
    | null
  const episodeIds = Array.isArray(raw?.episodeIds)
    ? raw!.episodeIds.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n))
    : []
  if (episodeIds.length === 0 || typeof raw?.monitored !== 'boolean') {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const r = await sonarrFetch('/api/v3/episode/monitor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodeIds, monitored: raw.monitored }),
  })
  if (!r.ok) return c.json({ error: 'monitor_update_failed', status: r.status }, 502)
  return c.json({ ok: true, updated: episodeIds.length })
})

// S6: GET /api/v3/history/series?seriesId= — newest-first history.
sonarr.get('/api/v3/history/series', requireAdmin, async (c) => {
  const seriesId = Number(c.req.query('seriesId'))
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return c.json({ error: 'bad_seriesId' }, 400)
  }
  const r = await sonarrFetch(
    '/api/v3/history/series',
    { method: 'GET' },
    new URLSearchParams({ seriesId: String(seriesId) }),
  )
  if (!r.ok) return c.json({ error: 'history_failed', status: r.status }, 502)
  return c.json(mapHistory(await r.json().catch(() => [])))
})

// S7: PUT /api/v3/series/:id — edit (monitored/qualityProfileId/
// rootFolderPath only). Fetch the full series, overlay the allowlisted
// fields, PUT the whole object back. Never blind-passthrough the client body.
sonarr.put('/api/v3/series/:id', requireAdmin, sonarrMutateLimit, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const patch = extractEditPatch(await c.req.json().catch(() => null))
  const getRes = await sonarrFetch(`/api/v3/series/${id}`, { method: 'GET' })
  if (!getRes.ok) return c.json({ error: 'series_lookup_failed', status: getRes.status }, 502)
  const full = (await getRes.json()) as Record<string, unknown>
  const merged = mergeEdit(full, patch)
  const putRes = await sonarrFetch(`/api/v3/series/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merged),
  })
  if (!putRes.ok) return c.json({ error: 'series_update_failed', status: putRes.status }, 502)
  return new Response(await putRes.text(), {
    status: putRes.status,
    headers: { 'Content-Type': putRes.headers.get('Content-Type') ?? 'application/json' },
  })
})

// Per-episode size cap for TV grabs. Mirrors the movie cap. A release
// passes when (size / episodeCount) ≤ maxTvBytesPerEpisode. We disable
// Sonarr's built-in search-on-add so the initial grab is forced through
// this filter — keeps 4K HDR season packs out by default.
//
// SCOPE OF THE CAP: it applies to the initial add-time grab and to the
// manual /api/v3/series/:id/seasons/:n/monitor route. It does NOT
// apply to Sonarr's ongoing RSS sweep for new episodes of monitored
// series, because hard-unmonitoring would break the airing-season
// auto-download that's a primary reason to use Sonarr. Defense in
// depth for the RSS path lives in the quality profile (the curated
// "Choose Me" profile excludes 2160p tiers); if you swap profiles,
// configure that profile's size restrictions accordingly.
//
// Important Sonarr quirks discovered while wiring this:
//  - GET /api/v3/release?seriesId=X (no seasonNumber) returns
//    RSS-cached recent results across the whole indexer — NOT a search
//    for that series. To actually search, we have to scope per season.
//  - Releases get rejected:true for profile-quality rejection
//    (Choose Me doesn't allow 2160p, etc.) and indexer-level issues.
//    Automatic grabs only use non-rejected releases so we stay inside
//    the same safety decisions Sonarr made upstream.
async function grabTvUnderCap(
  seriesId: number,
  monitoredSeasons: number[],
  title?: string,
  rootFolder?: RootFolderSpaceSnapshot,
  sub?: string,
): Promise<void> {
  // `sub` rides on `base` so every {...base} event below is attributed
  // to the user who triggered the add (enables /by-item per-user scoping
  // in grabs.ts without threading the field through each call site).
  const base = { itemId: seriesId, title, capGb: env.maxTvGbPerEpisode, sub }
  await recordSonarrGrabEvent({ ...base, type: 'grab_started' })

  // Brief delay so Sonarr finishes wiring the new series record.
  await new Promise((r) => setTimeout(r, 2000))

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
      await recordSonarrGrabEvent({ ...base, type: 'search_failed', status: res.status })
      continue
    }
    const chunk = (await res.json()) as Release[]
    all.push(...chunk)
  }

  function effectiveEpisodeCount(r: Release): number | null {
    if (r.fullSeason && r.seasonNumber !== undefined) {
      return seasonEpCount.get(r.seasonNumber) ?? null
    }
    if (r.episodeNumbers && r.episodeNumbers.length > 0) return r.episodeNumbers.length
    return 1
  }

  const monitored = new Set(monitoredSeasons)
  const within = all
    .filter((r) => r.size > 0)
    .filter((r) => r.seasonNumber === undefined || monitored.has(r.seasonNumber))
    .filter((r) => {
      const episodeCount = effectiveEpisodeCount(r)
      return episodeCount !== null && r.size / episodeCount <= env.maxTvBytesPerEpisode
    })

  // Prefer releases that Sonarr's profile accepts (Choose Me is curated
  // to match what the user's usenet provider can actually deliver) and
  // that aren't temporarily rejected (blocklisted, age, etc.).
  const accepted = within.filter((r) => !r.rejected && !r.temporarilyRejected)
  if (within.length > 0 && accepted.length === 0) {
    await recordSonarrGrabEvent({
      ...base,
      type: 'all_rejected_by_profile',
      scanned: all.length,
      eligible: within.length,
    })
    return
  }

  // Group by (seasonNumber, episodeKey) so we grab the single best
  // release per chunk — not five copies of the same episode. Tie-break
  // qualityWeight on smaller size: same tier on Eweka, the smaller
  // release is more likely to have intact articles (the 50 GB 2160p
  // release is the first to take a DMCA hit on HBO content).
  const bestByChunk = new Map<string, Release>()
  for (const r of accepted) {
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
    await recordSonarrGrabEvent({
      ...base,
      type: all.length === 0 ? 'no_releases' : 'all_rejected_by_cap',
      scanned: all.length,
      eligible: within.length,
    })
    return
  }

  const ranked = [...bestByChunk.values()].sort((a, b) => {
    if (a.fullSeason !== b.fullSeason) return a.fullSeason ? -1 : 1
    return b.qualityWeight - a.qualityWeight || a.size - b.size
  })
  // Prefer season packs over individual episodes for the same season,
  // then avoid overlapping partial packs and single-episode releases.
  const packs = ranked.filter((r) => r.fullSeason)
  const packSeasons = new Set(packs.map((r) => r.seasonNumber))
  const coveredEpisodes = new Map<number, Set<number>>()
  const finalPicks: Release[] = [...packs]
  for (const r of ranked) {
    if (r.fullSeason || packSeasons.has(r.seasonNumber)) continue
    const seasonNumber = r.seasonNumber
    const episodeNumbers = r.episodeNumbers ?? []
    if (seasonNumber === undefined || episodeNumbers.length === 0) {
      finalPicks.push(r)
      continue
    }
    const covered = coveredEpisodes.get(seasonNumber) ?? new Set<number>()
    if (episodeNumbers.some((episodeNumber) => covered.has(episodeNumber))) continue
    finalPicks.push(r)
    for (const episodeNumber of episodeNumbers) covered.add(episodeNumber)
    coveredEpisodes.set(seasonNumber, covered)
  }
  const plannedBytes = finalPicks.reduce((sum, pick) => sum + pick.size, 0)
  if (rootFolder && sonarrReservations.availableBytes(rootFolder) - plannedBytes < env.minFreeBytes) {
    await recordSonarrGrabEvent({
      ...base,
      type: 'planned_size_exceeds_free_space',
      scanned: all.length,
      eligible: accepted.length,
      plannedBytes,
      freeBytes: sonarrReservations.availableBytes(rootFolder),
      thresholdBytes: env.minFreeBytes,
      error: `planned TV grab would leave ${rootFolder.path} below minimum free-space reserve`,
    })
    return
  }
  if (rootFolder && !sonarrReservations.reserve(rootFolder, plannedBytes)) {
    await recordSonarrGrabEvent({
      ...base,
      type: 'planned_size_exceeds_free_space',
      scanned: all.length,
      eligible: accepted.length,
      plannedBytes,
      freeBytes: sonarrReservations.availableBytes(rootFolder),
      thresholdBytes: env.minFreeBytes,
      error: `planned TV grab would overcommit pending reservations for ${rootFolder.path}`,
    })
    return
  }

  // The reservation guards the PLANNING window only — the gap where a second
  // concurrent add could clear the free-space gate against the same stale
  // snapshot. Once every grab POST has a final outcome, SAB/Sonarr own the
  // real on-disk accounting (mirrors grabBestUnderCap in radarr.ts), so the
  // FULL reservation settles in `finally` whatever happened. The prior code
  // only released when grabbedBytes < plannedBytes: a fully-successful grab
  // released nothing and the leaked reservation 409'd every later add to the
  // same root folder until restart.
  try {
    for (const pick of finalPicks) {
      const grabRes = await sonarrFetch('/api/v3/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid: pick.guid, indexerId: pick.indexerId }),
      })
      const ec = effectiveEpisodeCount(pick) ?? 1
      console.log(
        `[tv-cap] grab "${pick.title.slice(0, 80)}" ${(pick.size / 1024 ** 3).toFixed(2)}GB ` +
          `(~${(pick.size / ec / 1024 ** 3).toFixed(2)}GB/ep, ${ec} ep) ` +
          `series=${seriesId} → ${grabRes.status}`,
      )
      await recordSonarrGrabEvent({
        ...base,
        type: grabRes.ok ? 'grab_succeeded' : 'grab_failed',
        status: grabRes.status,
        release: {
          title: pick.title,
          sizeBytes: pick.size,
          qualityWeight: pick.qualityWeight,
          seasonNumber: pick.seasonNumber,
        },
      })
    }
  } finally {
    // Always settle the whole reservation — success, partial failure, or a
    // thrown egress error. release() floors at zero, so this is idempotent.
    if (rootFolder) sonarrReservations.release(rootFolder, plannedBytes)
  }
}

// Add a series — both roles, but gated by free disk space on the
// chosen rootFolderPath. Search-on-add is forced off so our cap filter
// is the only path that starts a download.
// Identifying-metadata allowlist for non-admin add requests. Anything
// outside this list (qualityProfileId, rootFolderPath, monitored,
// seasonFolder, languageProfileId, seriesType, seasons[].monitored,
// tags, addOptions.*) is discarded and the server fills in policy
// fields from upstream defaults — see materializeNonAdminSeriesBody.
const NON_ADMIN_SONARR_ALLOW: ReadonlyArray<string> = [
  'title',
  'year',
  'tvdbId',
  'imdbId',
  'tmdbId',
  'images',
  'titleSlug',
  'overview',
  'genres',
  'runtime',
  'status',
  'originalLanguage',
]

// Honoured-policy allow-list: identifying metadata PLUS the controls the Add
// dialog now exposes to every household member (monitored, addOptions, the
// season selection). rootFolderPath + qualityProfileId are validated against
// the live lists and stamped by validateHonoredAddBody; tags stay admin-only.
const HONORED_SONARR_ALLOW: ReadonlyArray<string> = [
  ...NON_ADMIN_SONARR_ALLOW,
  'monitored',
  'addOptions',
  'seasons',
  'seasonFolder',
]

type SonarrAddBody = {
  rootFolderPath?: string
  qualityProfileId?: number
  monitored?: boolean
  seasonFolder?: boolean
  seriesType?: string
  languageProfileId?: number
  tags?: number[]
  addOptions?: {
    searchForMissingEpisodes?: boolean
    searchForCutoffUnmetEpisodes?: boolean
    monitor?: string
    ignoreEpisodesWithFiles?: boolean
    ignoreEpisodesWithoutFiles?: boolean
  }
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>
  [key: string]: unknown
}

// STEP: non-admin policy materialization. The allowlist + policy stamping is
// Sonarr's; the folder/profile resolution machinery (incl. pickProfile's
// preference chain) is shared with Radarr in services/arrAdd.ts. Profile
// selection prefers env.defaultProfileName (defaults to "choose me" to
// mirror the frontend modal). For TV this matters even more than for movies
// — Sonarr's ongoing RSS sweep against monitored series is gated by the
// quality profile, NOT by our per-episode size cap (defense in depth lives
// in the profile's own size restrictions). Landing on Sonarr's default Any
// profile would silently let 4K HDR packs through on RSS auto-grabs.
function materializeNonAdminSeriesBody(raw: SonarrAddBody) {
  return materializeNonAdminAddBody({
    app: 'sonarr',
    raw,
    allowKeys: NON_ADMIN_SONARR_ALLOW,
    loadFolders: sonarrRootFolders,
    fetchProfiles: () => sonarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
    configuredFolderPath: env.defaultSonarrRootFolderPath,
    applyPolicy: (safe, picked) => {
      safe.rootFolderPath = picked.folderPath
      safe.qualityProfileId = picked.profileId
      safe.monitored = true
      safe.seasonFolder = true
      // monitor: 'firstSeason' = Sonarr marks only season 1 monitored at
      // add-time (or, for shows without a season 1, the lowest-numbered
      // season — Sonarr's own resolution). Two reasons over the prior
      // 'future':
      //
      // 1. 'future' leaves zero historical seasons monitored, which means
      //    grabTvUnderCap (the cap-aware downloader gated on
      //    `monitored.length > 0`) never fires for a completed show. The
      //    user gets an apparently-successful add with nothing
      //    downloaded — silent failure.
      //
      // 2. The HomeTab copy and the AddSeriesModal default both promise
      //    "Season 1 by default." Non-admins don't see the picker, so
      //    the server-materialized default IS the user-facing default.
      //    'firstSeason' makes the docs match reality.
      //
      // Sonarr's RSS sweep against monitored seasons still respects the
      // quality profile (load-bearing — that's why we mirrored Choose Me
      // above), so this doesn't open a 4K HDR sluice; it just makes the
      // first season actually get fetched.
      safe.addOptions = {
        searchForMissingEpisodes: true,
        searchForCutoffUnmetEpisodes: false,
        monitor: 'firstSeason',
      }
      safe.tags = []
    },
  })
}

// STEP: parse + policy (mirrors radarr's resolveMovieAddBody). Pass through
// full admin policy only when the client actually sent policy fields. An
// admin previewing-as-user (auth.tsx makes isAdmin viewAs-aware) sends the
// slim user-shape body through AddSeriesModal — without this branch that body
// would skip materialize and trip the rootFolderPath_required gate in 2ms,
// surfacing as the cryptic "Sonarr /series: 400" toast. Non-admins (and
// admins-in-preview) can't dictate policy: materialization replaces policy
// fields with server-derived defaults so a direct-POST can't bypass the
// curated quality profile, root folder, or monitor mode.
async function resolveSeriesAddBody(
  session: { role: string },
  parsedBody: unknown,
): Promise<{ ok: true; body: SonarrAddBody } | { ok: false; payload: Record<string, unknown>; status: 400 | 503 }> {
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return { ok: false, payload: { error: 'invalid_body' }, status: 400 }
  }
  const rawBody = parsedBody as SonarrAddBody
  // Admin sending policy → trusted, pass the full body through verbatim.
  if (session.role === 'admin' && rawBody.rootFolderPath !== undefined) {
    return { ok: true, body: rawBody }
  }
  // Non-admin sending policy: the Add dialog now shows EVERY household member
  // the quality/folder/monitor controls, so honour their choices — but validate
  // each field against the live upstream lists first (no path/profile
  // injection). Per-episode size caps are enforced downstream regardless.
  if (rawBody.rootFolderPath !== undefined) {
    const honored = await validateHonoredAddBody({
      app: 'sonarr',
      raw: rawBody,
      allowKeys: HONORED_SONARR_ALLOW,
      loadFolders: sonarrRootFolders,
      fetchProfiles: () => sonarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
      configuredFolderPath: env.defaultSonarrRootFolderPath,
    })
    if (!honored.ok) {
      return { ok: false, payload: materializeFailurePayload(honored), status: addResolveStatus(honored.reason) }
    }
    return { ok: true, body: honored.body }
  }
  // No policy fields at all (legacy slim body / admin-preview) → curated defaults.
  const materialized = await materializeNonAdminSeriesBody(rawBody)
  if (!materialized.ok) {
    return { ok: false, payload: materializeFailurePayload(materialized), status: 503 }
  }
  return { ok: true, body: materialized.body }
}

sonarr.post('/api/v3/series', sonarrMutateLimit, async (c) => {
  const session = c.get('session')
  // STEP 1 — parse + policy.
  const resolved = await resolveSeriesAddBody(session, await c.req.json().catch(() => null))
  if (!resolved.ok) {
    return c.json(resolved.payload, resolved.status)
  }
  const body = resolved.body
  const wantedSearch =
    body.addOptions?.searchForMissingEpisodes !== false ||
    body.addOptions?.searchForCutoffUnmetEpisodes === true

  // STEP 2 — hard disk-space gate. Fail closed on every "we couldn't
  // actually measure free space" case (missing path, unknown path, response
  // without freeSpace) — shared logic in services/arrAdd.ts — plus Sonarr's
  // own reservation-in-flight refusal (the TV grab is asynchronous, so a
  // second search-bearing add against the same folder must wait for the
  // in-flight plan to settle rather than double-spend the same headroom).
  if (!body.rootFolderPath) {
    return c.json(
      { error: 'rootFolderPath_required' },
      400,
    )
  }
  const rootFolders = await loadSonarrRootFolders()
  if (!rootFolders.ok) return rootFolders.response
  const gate = gateRootFolderSpace({
    rootFolderPath: body.rootFolderPath,
    folders: rootFolders.folders,
    ledger: sonarrReservations,
  })
  if (!gate.ok) {
    return c.json(gate.failure.body, gate.failure.status)
  }
  const folderSnapshot = gate.folder
  const reservedBytes = sonarrReservations.pendingBytes(folderSnapshot)
  if (wantedSearch && reservedBytes > 0) {
    return c.json(
      {
        error: 'root_folder_reservation_in_flight',
        reserved_bytes: reservedBytes,
        free_bytes: gate.availableBytes,
        path: folderSnapshot.path,
      },
      409,
    )
  }

  // STEP 3 — create upstream with search-on-add forced off, so the cap
  // filter is the only path that starts a download.
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

  // Mirror successful adds to the recommender as a strong positive
  // signal so the optimizer learns from real conversions, not just
  // dot-feedback. Sonarr lookups carry tmdbId as secondary metadata
  // (primary id is tvdbId for TV), and tmdbId is what the
  // recommender's catalog is keyed on. Skip the mirror if tmdbId is
  // absent — better silence than an attributed event against the
  // wrong id. Fire-and-forget; bounded timeout in services/recommender.ts.
  // Gated on env.useLocalRecommender so disabled/direct-backend
  // deployments don't generate sidecar traffic or timeout log noise —
  // mirrors the gate at /api/feedback.
  if (r.ok && env.useLocalRecommender) {
    const tmdbId = typeof body.tmdbId === 'number' ? body.tmdbId : undefined
    if (tmdbId !== undefined) {
      void postFeedback({
        sub: session.sub,
        kind: 'tv',
        tmdb_id: tmdbId,
        signal: 'added',
      }, recommenderCallerFromSession(session))
    }
  }

  // STEP 4+5 — reconcile what Sonarr actually monitored, then spawn the
  // cap-enforced grab in the background.
  if (r.ok && wantedSearch) {
    await reconcileMonitorsAndSpawnGrab(out, body, folderSnapshot, session.sub)
  }

  return new Response(out, {
    status: r.status,
    headers: { 'Content-Type': r.headers.get('Content-Type') ?? 'application/json' },
  })
})

type CreatedSeries = {
  id?: number
  monitored?: boolean
  seasons?: Array<{ seasonNumber: number; monitored: boolean }>
  title?: string
  [key: string]: unknown
}

// STEP 4 — resolve which seasons ended up monitored, with a race-tolerant
// re-read for the non-admin / 'monitor': 'firstSeason' path. The non-admin
// body has no explicit seasons[] — we rely on created.seasons to know what
// Sonarr actually monitored after the add pipeline applied
// addOptions.monitor. For shows whose metadata is still being fetched at
// POST-response time (especially brand-new series), Sonarr can echo an empty
// or pre-monitor seasons array, leaving monitored.length === 0 even though
// firstSeason will land S1 monitored a moment later. Without this re-read,
// grabTvUnderCap is silently skipped and the user gets an apparently-
// successful add with no download — exactly the regression Round 23's fix
// was meant to close.
//
// Guard: only re-read when body.seasons is undefined (no explicit admin
// intent) AND monitored.length is 0 (we have nothing to act on yet). Single
// GET, no retry loop — if Sonarr still hasn't resolved metadata, skipping
// the grab is the safer outcome than looping in the request handler.
async function resolveMonitoredSeasons(body: SonarrAddBody, created: CreatedSeries): Promise<number[]> {
  const id = created.id
  let monitored =
    body.addOptions?.monitor === 'all' && body.seasons
      ? body.seasons.map((s) => s.seasonNumber)
      : (body.seasons ?? created.seasons ?? [])
          .filter((s) => s.monitored)
          .map((s) => s.seasonNumber)

  if (id && monitored.length === 0 && !body.seasons) {
    try {
      const fresh = await sonarrFetch(`/api/v3/series/${id}`, { method: 'GET' })
      if (fresh.ok) {
        const refreshed = (await fresh.json()) as {
          seasons?: Array<{ seasonNumber: number; monitored: boolean }>
        }
        monitored = (refreshed.seasons ?? [])
          .filter((s) => s.monitored)
          .map((s) => s.seasonNumber)
      }
    } catch (e) {
      console.warn(
        `[tv-monitor] re-read series ${id} for monitored seasons failed: ` +
          (e instanceof Error ? e.message : String(e)),
      )
    }
  }
  return monitored
}

// STEP 5 (reconcile leg) — the modal's single-season picker sends
// `addOptions.monitor: 'none'` plus an explicit seasons[] with only the
// chosen season monitored. Sonarr's add pipeline applies
// `addOptions.monitor` *after* the seasons[] array, so 'none' ends up wiping
// every season's monitored flag — even the one the user picked. Without this
// PUT-back, the series is silently dropped from Sonarr's RSS sweep: our
// initial cap grab fires once (because we use body.seasons), but on failure
// there's nothing monitored to recover, and the user sees a permanently
// empty library entry. Detect the case and reconcile.
async function reconcileExplicitSeasonPick(
  id: number,
  monitored: number[],
  created: CreatedSeries,
): Promise<void> {
  let seriesForPatch = created
  if (!seriesForPatch.seasons || seriesForPatch.seasons.length === 0) {
    try {
      const fresh = await sonarrFetch(`/api/v3/series/${id}`, { method: 'GET' })
      if (fresh.ok) {
        const refreshed = (await fresh.json()) as CreatedSeries
        if (refreshed.seasons && refreshed.seasons.length > 0) {
          seriesForPatch = refreshed
        }
      }
    } catch (e) {
      console.warn(
        `[tv-monitor] re-read series ${id} for season reconciliation failed: ` +
          (e instanceof Error ? e.message : String(e)),
      )
    }
  }
  if (seriesForPatch.seasons && seriesForPatch.seasons.length > 0) {
    const desired = new Set(monitored)
    const patched = {
      ...seriesForPatch,
      monitored: true,
      seasons: seriesForPatch.seasons.map((s) => ({
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
}

// STEP 5 (spawn leg) — fire the cap-enforced grab WITHOUT awaiting it.
//
// DELIBERATE divergence from Radarr (which awaits grabBestUnderCap and maps
// the outcome to 424/rollback responses): a TV grab runs one interactive
// indexer search PER monitored season plus Sonarr metadata polling, with
// multi-second settle delays baked in — awaiting it would pin the add
// request for tens of seconds and time out at proxies, and there is no
// rollback semantic on this path (the series is kept and monitored whatever
// the grab outcome). The SPA matches this contract: movie adds surface
// synchronous capped_grab_* toasts (src/lib/api/errors.ts), while TV
// outcomes arrive via the GrabActivityPanel's 10s /api/grabs/by-item
// polling of the grab-event log this function writes to.
function spawnCappedTvGrab(opts: {
  itemId: number
  monitored: number[]
  title?: string
  folder: RootFolderSpaceSnapshot
  sub: string
}): void {
  const { itemId, monitored, title, folder, sub } = opts
  void grabTvUnderCap(itemId, monitored, title, folder, sub).catch((e) => {
    console.error('[tv-cap] grab failed:', e)
    void recordSonarrGrabEvent({
      itemId,
      title,
      sub,
      type: 'grab_failed',
      error: e instanceof Error ? e.message : String(e),
    })
  })
}

// STEPs 4+5 composed: parse the created series, work out the monitored
// seasons, repair the monitor:'none' wipe, then spawn the background grab.
// Never throws — a parse failure passes through (the series was added if
// the upstream call was ok).
async function reconcileMonitorsAndSpawnGrab(
  out: string,
  body: SonarrAddBody,
  folderSnapshot: RootFolderSpaceSnapshot,
  sub: string,
): Promise<void> {
  try {
    const created = JSON.parse(out) as CreatedSeries
    const id = created.id
    const monitored = await resolveMonitoredSeasons(body, created)

    if (id && monitored.length > 0 && body.addOptions?.monitor === 'none') {
      await reconcileExplicitSeasonPick(id, monitored, created)
    }

    if (id && monitored.length > 0) {
      spawnCappedTvGrab({ itemId: id, monitored, title: created.title, folder: folderSnapshot, sub })
    }
  } catch {
    // Pass through; series was added if the upstream POST was ok.
  }
}

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
sonarr.post('/api/v3/series/:id/seasons/:n/monitor', requireAdmin, sonarrMutateLimit, async (c) => {
  const id = Number(c.req.param('id'))
  const n = Number(c.req.param('n'))
  // Sonarr series ids are positive integers; season numbers are
  // non-negative integers (season 0 == "Specials"). Reject decimals,
  // negatives, and unsafe-large numbers up front so we don't issue a
  // PUT against a junk seasonNumber.
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(n) ||
    n < 0
  ) {
    return c.json({ error: 'bad_params' }, 400)
  }
  const getRes = await sonarrFetch(`/api/v3/series/${id}`, { method: 'GET' })
  if (!getRes.ok) {
    return new Response(await getRes.text(), { status: getRes.status })
  }
  const series = (await getRes.json()) as {
    title?: string
    rootFolderPath?: string
    seasons?: Array<{ seasonNumber: number; monitored: boolean }>
  }
  const seasons = series.seasons ?? []
  if (!seasons.some((s) => s.seasonNumber === n)) {
    return c.json({ error: 'season_not_found' }, 404)
  }
  if (!series.rootFolderPath) {
    return c.json(
      { error: 'rootFolderPath_required' },
      400,
    )
  }
  const rootFolders = await loadSonarrRootFolders()
  if (!rootFolders.ok) return rootFolders.response
  // Shared fail-closed space gate + Sonarr's reservation-in-flight refusal
  // (same pair as the add route).
  const gate = gateRootFolderSpace({
    rootFolderPath: series.rootFolderPath,
    folders: rootFolders.folders,
    ledger: sonarrReservations,
  })
  if (!gate.ok) {
    return c.json(gate.failure.body, gate.failure.status)
  }
  const folderSnapshot = gate.folder
  const reservedBytes = sonarrReservations.pendingBytes(folderSnapshot)
  if (reservedBytes > 0) {
    return c.json(
      {
        error: 'root_folder_reservation_in_flight',
        reserved_bytes: reservedBytes,
        free_bytes: gate.availableBytes,
        path: folderSnapshot.path,
      },
      409,
    )
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
  // Fire the cap-enforced grab in the background — same spawn path the add
  // flow uses (see spawnCappedTvGrab for why TV grabs are deliberately
  // fire-and-forget), so the new season comes in via the same size gate.
  spawnCappedTvGrab({
    itemId: id,
    monitored: [n],
    title: series.title,
    folder: folderSnapshot,
    sub: c.get('session').sub,
  })
  return c.json({ ok: true, seriesId: id, seasonNumber: n })
})

// Delete a series — admin only.
sonarr.delete('/api/v3/series/:id', requireAdmin, async (c) => {
  // Same encoded-slash defense as radarr's DELETE: Hono URL-decodes
  // :id before we read it, so `..%2Frootfolder%2F1` produces the
  // literal `../rootfolder/1`. Once that flows through the
  // `new URL(base + path)` builder in sonarrFetch, the WHATWG parser
  // normalizes the `..` and the DELETE retargets a different Sonarr
  // endpoint. Positive safe-integer ids only.
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const search = new URL(c.req.url).searchParams
  const r = await sonarrFetch(`/api/v3/series/${id}`, { method: 'DELETE' }, search)
  return new Response(null, { status: r.status })
})
