// Allow-list of Radarr endpoints. Mirrors sonarr.ts.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { radarrFetch, radarrRootFolders } from '../services/radarr.js'
import { appendGrabEvent } from '../services/grabLog.js'
import { postFeedback } from '../services/recommender.js'
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
// Read-only — mirrors the Sonarr queue forwarder. The DownloadsTab
// uses Radarr's queue to surface movie "indexer working" / pending
// states while SAB has no active slot. Without this in the allow-list
// the SPA polled /api/radarr/api/v3/queue every few seconds and
// silently 404'd in prod, leaving movie pending states invisible.
forwardRead('/api/v3/queue')

// Hard size cap. Radarr's auto-search and RSS sync can grab whatever
// wins profile scoring — that includes 50 GB 4K HDR rips. We force
// searchForMovie:false on the add, then drive our own release search
// and filter to releases under env.maxMovieBytes before grabbing.
//
// Monitor policy mirrors the user's "Search" choice:
//   - "Start search now" (default) → searchForMovie:true incoming →
//     we run the cap-enforced grab AND set monitored:false on the add,
//     so Radarr's RSS sync can't bypass the cap with an oversized
//     release later. Future upgrades go through the explicit
//     /api/v3/movie/:id/upgrade endpoint (also cap-enforced).
//   - "Just monitor" → searchForMovie:false incoming → we skip the
//     cap-aware grab and leave monitored:true. The user explicitly
//     asked for RSS-driven monitoring; the eventual auto-grab is
//     gated by Radarr's quality profile, NOT env.maxMovieBytes.
async function grabBestUnderCap(movieId: number, title?: string): Promise<void> {
  const base = { app: 'radarr' as const, itemId: movieId, title, capGb: env.maxMovieGb }
  await appendGrabEvent({ ...base, type: 'grab_started' })

  // Brief delay so Radarr finishes wiring the new movie record before
  // we hit the release endpoint.
  await new Promise((r) => setTimeout(r, 1500))
  const releaseRes = await radarrFetch(`/api/v3/release?movieId=${movieId}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    console.error(`[movie-cap] release search ${releaseRes.status} for movie ${movieId}`)
    await appendGrabEvent({ ...base, type: 'search_failed', status: releaseRes.status })
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
    await appendGrabEvent({
      ...base,
      type: all.length === 0 ? 'no_releases' : 'all_rejected_by_cap',
      scanned: all.length,
      eligible: 0,
    })
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
  await appendGrabEvent({
    ...base,
    type: grabRes.ok ? 'grab_succeeded' : 'grab_failed',
    status: grabRes.status,
    scanned: all.length,
    eligible: eligible.length,
    release: {
      title: best.title,
      sizeBytes: best.size,
      qualityWeight: best.qualityWeight,
    },
  })
}

// Identifying fields a non-admin add request may carry over to
// upstream. Anything outside this allowlist gets discarded and the
// server fills in policy fields from upstream defaults — see
// materializeNonAdminMovieBody. The list is descriptive metadata only
// (no qualityProfileId, no rootFolderPath, no monitored flag), so a
// direct-POST can't pin the household to a more permissive policy.
const NON_ADMIN_RADARR_ALLOW: ReadonlyArray<string> = [
  'title',
  'year',
  'tmdbId',
  'imdbId',
  'images',
  'titleSlug',
  'overview',
  'genres',
  'runtime',
  'status',
  'originalTitle',
  'originalLanguage',
]

type RadarrAddBody = {
  rootFolderPath?: string
  qualityProfileId?: number
  monitored?: boolean
  tags?: number[]
  minimumAvailability?: string
  addOptions?: { searchForMovie?: boolean; monitor?: string }
  [key: string]: unknown
}

async function materializeNonAdminMovieBody(raw: RadarrAddBody): Promise<
  { ok: true; body: RadarrAddBody } | { ok: false; reason: string }
> {
  // Pull the upstream's qualityprofile + rootfolder lists, then pick
  // the canonical "what the admin already curates" defaults. Profile
  // selection prefers env.defaultProfileName (case-insensitive exact
  // match — defaults to "choose me" to mirror the frontend modals)
  // and falls back to profiles[0]. Without this preference, Radarr's
  // default Any profile is sometimes id 1 and a non-admin direct-POST
  // would land on the most permissive setting instead of the curated
  // one.
  const [folders, profileRes] = await Promise.all([
    radarrRootFolders(),
    radarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
  ])
  if (!profileRes.ok) {
    return { ok: false, reason: 'qualityprofile_unreachable' }
  }
  const profiles = (await profileRes.json()) as Array<{ id: number; name?: string }>
  const folder = folders[0]
  const profile =
    profiles.find((p) => p.name?.toLowerCase() === env.defaultProfileName) ?? profiles[0]
  if (!folder || !profile) {
    return { ok: false, reason: 'admin_must_configure_upstream' }
  }
  const safe: RadarrAddBody = {}
  for (const key of NON_ADMIN_RADARR_ALLOW) {
    if (raw[key] !== undefined) safe[key] = raw[key]
  }
  safe.rootFolderPath = folder.path
  safe.qualityProfileId = profile.id
  safe.monitored = true
  // searchForMovie:true gates the cap-aware grab below for non-admins
  // who'd otherwise just want "add and start." The existing cap
  // rewrite still forces searchForMovie:false on the actual upstream
  // call so the grab path is the only download trigger.
  safe.addOptions = { searchForMovie: true }
  safe.tags = []
  return { ok: true, body: safe }
}

radarr.post('/api/v3/movie', async (c) => {
  const session = c.get('session')
  const rawBody = (await c.req.json()) as RadarrAddBody
  let body: RadarrAddBody
  if (session.role === 'admin') {
    body = rawBody
  } else {
    // Non-admins can't dictate quality / folder / monitor / tag /
    // searchForMovie policy — those are admin-curated. Replace the
    // policy fields with server-derived defaults so a direct-POST
    // can't bypass the curated profile or pin a different root folder.
    const materialized = await materializeNonAdminMovieBody(rawBody)
    if (!materialized.ok) {
      return c.json({ error: materialized.reason }, 503)
    }
    body = materialized.body
  }
  // Hard disk-space gate. Fail closed on every "we couldn't actually
  // measure free space" case — the prior implementation only blocked
  // when rootFolderPath was supplied AND the folder matched AND
  // freeSpace was a number, so a missing path, an unknown path, or a
  // Radarr response without freeSpace all silently bypassed the cap.
  if (!body.rootFolderPath) {
    return c.json(
      { error: 'rootFolderPath_required' },
      400,
    )
  }
  const folders = await radarrRootFolders()
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

  // Capture the user's intent then disable Radarr's built-in search.
  // When the user chose "Start search now" we also unmonitor so the
  // cap-aware grab below is the ONLY way a download starts; RSS sync
  // against monitored items would otherwise route through Radarr's
  // profile scorer with no size ceiling and defeat the cap.
  // When the user chose "Just monitor" (searchForMovie:false) we
  // respect that intent and leave monitored:true — they've explicitly
  // asked for RSS-driven monitoring, accepting that profile-side
  // rules (not env.maxMovieBytes) gate any eventual auto-grab.
  const wantedSearch = body.addOptions?.searchForMovie !== false
  const cappedBody = {
    ...body,
    ...(wantedSearch ? { monitored: false } : {}),
    addOptions: { ...(body.addOptions ?? {}), searchForMovie: false },
  }

  const r = await radarrFetch('/api/v3/movie', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cappedBody),
  })
  const out = await r.text()

  // Mirror the successful add to the recommender as a strong positive
  // signal — the user converted a suggestion into a real library
  // entry. The sidecar maps signal:'added' to outcome:'added' and ties
  // it back to the most recent rec_log row for the same (sub, kind,
  // tmdb_id), so the optimizer learns from real conversions, not just
  // the dot-feedback subset. tmdbId comes from the incoming body —
  // for non-admin adds the materialize step strips most fields but
  // preserves tmdbId per NON_ADMIN_RADARR_ALLOW. Fire-and-forget; the
  // mirror has its own bounded timeout in services/recommender.ts.
  if (r.ok) {
    const tmdbId = typeof body.tmdbId === 'number' ? body.tmdbId : undefined
    if (tmdbId !== undefined) {
      void postFeedback({
        sub: session.sub,
        kind: 'movie',
        tmdb_id: tmdbId,
        signal: 'added',
      })
    }
  }

  // Fire the size-capped grab in the background. Indexer search can be
  // slow; we don't want to block the modal close.
  if (r.ok && wantedSearch) {
    try {
      const created = JSON.parse(out) as { id?: number; title?: string }
      if (created.id) {
        const itemId = created.id
        const itemTitle = created.title
        void grabBestUnderCap(itemId, itemTitle).catch((e) => {
          console.error('[movie-cap] grab failed:', e)
          void appendGrabEvent({
            app: 'radarr',
            itemId,
            title: itemTitle,
            type: 'grab_failed',
            error: e instanceof Error ? e.message : String(e),
          })
        })
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

// Manually trigger an upgrade pass on an existing movie. Radarr's
// release search returns releases with `rejected: true` when they're
// equal-or-worse than the current file, so reusing the same filter
// chain as grabBestUnderCap naturally excludes non-upgrades. If the
// best non-rejected release fits the cap, grab it; Radarr's import
// logic then decides whether to replace the existing file.
//
// Returns:
//   { status: 'grabbing', ...best }  on success
//   { status: 'no_upgrade_available' } when nothing non-rejected was
//                                       found under the cap
//   { status: 'no_releases_found' }   when the indexer returned nothing
radarr.post('/api/v3/movie/:id/upgrade', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  // Radarr movie ids are positive integers; rejecting decimals /
  // negatives / unsafe-large numbers up front avoids a wasted Radarr
  // round-trip on a junk path.
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const releaseRes = await radarrFetch(`/api/v3/release?movieId=${id}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    return c.json({ error: 'release_search_failed', status: releaseRes.status }, 502)
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
  if (all.length === 0) {
    return c.json({ status: 'no_releases_found' })
  }
  const eligible = all
    .filter((r) => !r.rejected && r.size > 0 && r.size <= env.maxMovieBytes)
    .sort((a, b) => b.qualityWeight - a.qualityWeight)
  if (eligible.length === 0) {
    return c.json({
      status: 'no_upgrade_available',
      scanned: all.length,
      capGb: env.maxMovieGb,
    })
  }
  const best = eligible[0]
  const grabRes = await radarrFetch('/api/v3/release', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }),
  })
  if (!grabRes.ok) {
    return c.json({ error: 'grab_failed', status: grabRes.status }, 502)
  }
  console.log(
    `[movie-upgrade] grabbed "${best.title}" ${(best.size / 1024 ** 3).toFixed(2)}GB ` +
      `for movie ${id}`,
  )
  return c.json({
    status: 'grabbing',
    title: best.title,
    sizeGb: Number((best.size / 1024 ** 3).toFixed(2)),
    qualityWeight: best.qualityWeight,
  })
})

radarr.delete('/api/v3/movie/:id', requireAdmin, async (c) => {
  // The :id param is URL-decoded by Hono BEFORE we use it, so an
  // attacker who passes `..%2Frootfolder%2F1` ends up with the literal
  // string `../rootfolder/1`. Once that hits the `new URL(base + path)`
  // construction in radarrFetch, the WHATWG URL parser normalizes the
  // `..` segment and the DELETE silently retargets a different Radarr
  // endpoint (e.g. /api/v3/rootfolder/1). Constraining :id to a
  // positive safe integer kills the traversal and matches how Radarr
  // actually models movie ids.
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const search = new URL(c.req.url).searchParams
  const r = await radarrFetch(`/api/v3/movie/${id}`, { method: 'DELETE' }, search)
  return new Response(null, { status: r.status })
})
