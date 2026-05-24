// Allow-list of Sonarr endpoints. Anything not declared here returns
// 404 — the backend will not blanket-forward arbitrary paths, even
// for admins.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { sonarrFetch, sonarrRootFolders } from '../services/sonarr.js'
import { appendGrabEvent } from '../services/grabLog.js'
import { postFeedback } from '../services/recommender.js'
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
//  - Releases get rejected:true for two reasons: profile-quality
//    rejection (Choose Me doesn't allow 2160p, etc.) and indexer-level
//    issues. We *prefer* non-rejected releases so we don't accidentally
//    pick a 4K HDR pack the user's profile excludes — and so we stay
//    inside the same release pool Sonarr's auto-retry walks. Fallback
//    to the broader pool only when the profile rejects everything that
//    fits the cap (rare, but possible for niche shows).
async function grabTvUnderCap(
  seriesId: number,
  monitoredSeasons: number[],
  title?: string,
): Promise<void> {
  const base = { app: 'sonarr' as const, itemId: seriesId, title, capGb: env.maxTvGbPerEpisode }
  await appendGrabEvent({ ...base, type: 'grab_started' })

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
      await appendGrabEvent({ ...base, type: 'search_failed', status: res.status })
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
  // that aren't temporarily rejected (blocklisted, age, etc.). Falling
  // back to the broader pool keeps things working for niche shows where
  // the profile rejects every cap-eligible release.
  const accepted = within.filter((r) => !r.rejected && !r.temporarilyRejected)
  const eligible = accepted.length > 0 ? accepted : within
  if (within.length > 0 && accepted.length === 0) {
    // Informational: every cap-eligible release was profile-rejected.
    // Pipeline still continues against the broader pool so niche shows
    // don't get stuck — log this so the admin can spot a misconfigured
    // profile (e.g. Choose Me with no available quality tier).
    await appendGrabEvent({
      ...base,
      type: 'all_rejected_by_profile',
      scanned: all.length,
      eligible: within.length,
    })
  }

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
    await appendGrabEvent({
      ...base,
      type: all.length === 0 ? 'no_releases' : 'all_rejected_by_cap',
      scanned: all.length,
      eligible: within.length,
    })
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
    const ec = effectiveEpisodeCount(pick) ?? 1
    console.log(
      `[tv-cap] grab "${pick.title.slice(0, 80)}" ${(pick.size / 1024 ** 3).toFixed(2)}GB ` +
        `(~${(pick.size / ec / 1024 ** 3).toFixed(2)}GB/ep, ${ec} ep) ` +
        `series=${seriesId} → ${grabRes.status}`,
    )
    await appendGrabEvent({
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

async function materializeNonAdminSeriesBody(raw: SonarrAddBody): Promise<
  { ok: true; body: SonarrAddBody } | { ok: false; reason: string }
> {
  // Profile selection prefers env.defaultProfileName (defaults to
  // "choose me" to mirror the frontend modal). For TV this matters
  // even more than for movies — Sonarr's ongoing RSS sweep against
  // monitored series is gated by the quality profile, NOT by our
  // per-episode size cap (defense in depth lives in the profile's
  // own size restrictions). Landing on Sonarr's default Any profile
  // would silently let 4K HDR packs through on RSS auto-grabs.
  const [folders, profileRes] = await Promise.all([
    sonarrRootFolders(),
    sonarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
  ])
  if (!profileRes.ok) {
    return { ok: false, reason: 'qualityprofile_unreachable' }
  }
  const profiles = (await profileRes.json()) as Array<{ id: number; name?: string }>
  const folder = folders[0]
  const namedProfile = profiles.find((p) => p.name?.toLowerCase() === env.defaultProfileName)
  const profile = namedProfile ?? profiles[0]
  if (!folder) {
    return { ok: false, reason: 'admin_must_configure_upstream' }
  }
  if (!profile) {
    return { ok: false, reason: 'default_quality_profile_missing' }
  }
  const safe: SonarrAddBody = {}
  for (const key of NON_ADMIN_SONARR_ALLOW) {
    if (raw[key] !== undefined) safe[key] = raw[key]
  }
  safe.rootFolderPath = folder.path
  safe.qualityProfileId = profile.id
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
  return { ok: true, body: safe }
}

sonarr.post('/api/v3/series', async (c) => {
  const session = c.get('session')
  const parsedBody = await c.req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const rawBody = parsedBody as SonarrAddBody
  let body: SonarrAddBody
  if (session.role === 'admin') {
    body = rawBody
  } else {
    // Non-admins can't dictate policy. Replace policy fields with
    // server-derived defaults so a direct-POST can't bypass the
    // curated quality profile, root folder, or monitor mode.
    const materialized = await materializeNonAdminSeriesBody(rawBody)
    if (!materialized.ok) {
      return c.json({ error: materialized.reason }, 503)
    }
    body = materialized.body
  }
  // Hard disk-space gate. Fail closed on every "we couldn't actually
  // measure free space" case — the prior implementation only blocked
  // when rootFolderPath was supplied AND the folder matched AND
  // freeSpace was a number, so a missing path, an unknown path, or a
  // Sonarr response without freeSpace all silently bypassed the cap.
  if (!body.rootFolderPath) {
    return c.json(
      { error: 'rootFolderPath_required' },
      400,
    )
  }
  const folders = await sonarrRootFolders()
  const folder = folders.find((f) => f.path === body.rootFolderPath)
  if (!folder) {
    return c.json(
      { error: 'unknown_root_folder', path: body.rootFolderPath },
      400,
    )
  }
  if (typeof folder.freeSpace !== 'number' || !Number.isFinite(folder.freeSpace)) {
    return c.json(
      { error: 'free_space_unknown', path: folder.path },
      507,
    )
  }
  if (folder.freeSpace < env.minFreeBytes) {
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
      })
    }
  }

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
      let monitored = (body.seasons ?? created.seasons ?? [])
        .filter((s) => s.monitored)
        .map((s) => s.seasonNumber)

      // Race-tolerant re-read for the non-admin / 'monitor': 'firstSeason'
      // path. The non-admin body has no explicit seasons[] — we rely on
      // created.seasons to know what Sonarr actually monitored after the
      // add pipeline applied addOptions.monitor. For shows whose metadata
      // is still being fetched at POST-response time (especially brand-new
      // series), Sonarr can echo an empty or pre-monitor seasons array,
      // leaving monitored.length === 0 even though firstSeason will land
      // S1 monitored a moment later. Without this re-read, grabTvUnderCap
      // is silently skipped and the user gets an apparently-successful
      // add with no download — exactly the regression Round 23's fix
      // was meant to close.
      //
      // Guard: only re-read when body.seasons is undefined (no explicit
      // admin intent) AND monitored.length is 0 (we have nothing to act
      // on yet). Single GET, no retry loop — if Sonarr still hasn't
      // resolved metadata, skipping the grab is the safer outcome than
      // looping in the request handler.
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
        const itemId = id
        const itemTitle = (created as { title?: string }).title
        void grabTvUnderCap(itemId, monitored, itemTitle).catch((e) => {
          console.error('[tv-cap] grab failed:', e)
          void appendGrabEvent({
            app: 'sonarr',
            itemId,
            title: itemTitle,
            type: 'grab_failed',
            error: e instanceof Error ? e.message : String(e),
          })
        })
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
  void grabTvUnderCap(id, [n], series.title).catch((e) => {
    console.error('[tv-monitor-season] grab failed:', e)
    void appendGrabEvent({
      app: 'sonarr',
      itemId: id,
      title: series.title,
      type: 'grab_failed',
      error: e instanceof Error ? e.message : String(e),
    })
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
