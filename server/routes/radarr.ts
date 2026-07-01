// Allow-list of Radarr endpoints. Mirrors sonarr.ts.

import { Hono, type Context } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { requireSection } from '../services/userPolicies.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { radarrFetch, radarrRootFolders } from '../services/radarr.js'
import { SEARCH_TIMEOUT_MS } from '../services/upstream.js'
import {
  createGrabEventRecorder,
  createReservationLedger,
  type CappedGrabResult,
  type RootFolderSpaceSnapshot,
} from '../services/arrGrab.js'
import {
  addResolveStatus,
  gateRootFolderSpace,
  materializeFailurePayload,
  materializeNonAdminAddBody,
  validateHonoredAddBody,
  type Release,
  type SpaceGateFailure,
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

export const radarr = new Hono<Env>()

radarr.use('*', requireAuth)
// Section gate: a policy that denies `arr` blocks add/manage mutations
// (POST/PUT/DELETE) while leaving reads open. Admins are never blocked.
radarr.use('*', requireSection('arr', { mutationsOnly: true }))

// Per-session token bucket on the release-search-bearing mutate routes
// (finding 4-0). Each add/upgrade triggers a real upstream indexer search;
// without this an authenticated member could loop them to burn the indexer
// budget and flood the grab log. Defined once and reused on every mutate route.
const radarrMutateLimit = rateLimit({
  name: 'radarr-mutate',
  capacity: env.arrMutateRateCapacity,
  refill: env.arrMutateRateRefill,
  intervalMs: env.arrMutateRateIntervalMs,
})

type RadarrSpaceGateFailure = SpaceGateFailure | { status: 502; body: Record<string, unknown> }

// Finding 4-1: in-flight disk-space reservations against root-folder
// free space. Mechanism + rationale live in services/arrGrab.ts; this
// instance is Radarr's own ledger (Sonarr keeps a separate one).
const radarrReservations = createReservationLedger('radarr')

const recordRadarrGrabEvent = createGrabEventRecorder('radarr')

// STEP: space gate. Folder loading (and its 502 wiring) is Radarr's; the
// fail-closed free-space/reservation logic is shared (services/arrAdd.ts).
async function validateRadarrRootFolderSpace(rootFolderPath?: string): Promise<
  { ok: true; folder: RootFolderSpaceSnapshot } | { ok: false; failure: RadarrSpaceGateFailure }
> {
  let folders: Awaited<ReturnType<typeof radarrRootFolders>>
  try {
    folders = await radarrRootFolders()
  } catch (err) {
    console.error('[radarr] rootfolder lookup failed:', err)
    return { ok: false, failure: { status: 502, body: { error: 'rootfolder_unreachable' } } }
  }
  return gateRootFolderSpace({ rootFolderPath, folders, ledger: radarrReservations })
}

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

// ===========================================================================
// Advanced options (admin-only power-user actions). Contract: R1–R6 in
// docs/superpowers/specs/2026-06-22-arr-advanced-options-design.md. Mirrors
// the Sonarr S1–S7 surface (no episode/monitor — movies have no episodes).
// ===========================================================================

// R1 allowlist. RefreshMovie/MoviesSearch operate on movie ids; RenameMovie
// applies a rename for the movie's files. Any other name → 400.
const RADARR_COMMANDS: Record<string, CommandSpec> = {
  RefreshMovie: { requires: ['movieIds'], passthrough: ['movieIds'] },
  MoviesSearch: { requires: ['movieIds'], passthrough: ['movieIds'] },
  RenameMovie: { requires: ['movieIds'], passthrough: ['movieIds', 'files'] },
}

// Per-release movie byte ceiling: a flat cap (env.maxMovieBytes) for every
// movie release.
const movieCapBytesFor = (): number => env.maxMovieBytes

// R1: POST /api/v3/command — fire an allowlisted Radarr command.
radarr.post('/api/v3/command', requireAdmin, radarrMutateLimit, async (c) => {
  const built = buildCommandBody(await c.req.json().catch(() => null), RADARR_COMMANDS)
  if (!built.ok) {
    return c.json({ error: built.error }, 400)
  }
  const r = await radarrFetch('/api/v3/command', {
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

// R2: GET /api/v3/release?movieId= — interactive search.
radarr.get('/api/v3/release', requireAdmin, radarrMutateLimit, async (c) => {
  const movieId = Number(c.req.query('movieId'))
  if (!Number.isSafeInteger(movieId) || movieId <= 0) {
    return c.json({ error: 'bad_movieId' }, 400)
  }
  const r = await radarrFetch(
    '/api/v3/release',
    { method: 'GET' },
    new URLSearchParams({ movieId: String(movieId) }),
    SEARCH_TIMEOUT_MS,
  )
  if (!r.ok) return c.json({ error: 'release_search_failed', status: r.status }, 502)
  const releases = (await r.json().catch(() => [])) as UpstreamRelease[]
  const projected: ClientRelease[] = releases.map((rel) => projectRelease(rel, movieCapBytesFor))
  return c.json(projected)
})

// R3: POST /api/v3/release — grab a hand-picked movie release.
radarr.post('/api/v3/release', requireAdmin, radarrMutateLimit, async (c) => {
  const parsed = parseInteractiveGrab(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: 'invalid_body' }, 400)
  const movieId = Number(c.req.query('movieId'))
  if (!Number.isSafeInteger(movieId) || movieId <= 0) {
    return c.json({ error: 'bad_movieId' }, 400)
  }
  const query = new URLSearchParams({ movieId: String(movieId) })
  const result = await executeInteractiveGrab({
    itemId: movieId,
    sub: c.get('session').sub,
    req: parsed.req,
    capGb: env.maxMovieGb,
    capBytesFor: movieCapBytesFor,
    listReleases: async () => {
      const res = await radarrFetch('/api/v3/release', { method: 'GET' }, query, SEARCH_TIMEOUT_MS)
      if (!res.ok) return null
      return (await res.json().catch(() => [])) as UpstreamRelease[]
    },
    postGrab: async (guid, indexerId) => {
      const res = await radarrFetch('/api/v3/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid, indexerId }),
      })
      return { ok: res.ok, status: res.status }
    },
    recordEvent: recordRadarrGrabEvent,
  })
  return interactiveGrabResponse(c, result)
})

// R4: GET /api/v3/rename?movieId= — preview the rename diff.
radarr.get('/api/v3/rename', requireAdmin, async (c) => {
  const movieId = Number(c.req.query('movieId'))
  if (!Number.isSafeInteger(movieId) || movieId <= 0) {
    return c.json({ error: 'bad_movieId' }, 400)
  }
  const r = await radarrFetch(
    '/api/v3/rename',
    { method: 'GET' },
    new URLSearchParams({ movieId: String(movieId) }),
  )
  if (!r.ok) return c.json({ error: 'rename_preview_failed', status: r.status }, 502)
  const rows = (await r.json().catch(() => [])) as Array<{
    movieFileId?: number
    existingPath?: string
    newPath?: string
  }>
  return c.json(
    rows.map((row) => ({
      movieFileId: row.movieFileId,
      existingPath: row.existingPath,
      newPath: row.newPath,
    })),
  )
})

// R5: GET /api/v3/history/movie?movieId= — newest-first history.
radarr.get('/api/v3/history/movie', requireAdmin, async (c) => {
  const movieId = Number(c.req.query('movieId'))
  if (!Number.isSafeInteger(movieId) || movieId <= 0) {
    return c.json({ error: 'bad_movieId' }, 400)
  }
  const r = await radarrFetch(
    '/api/v3/history/movie',
    { method: 'GET' },
    new URLSearchParams({ movieId: String(movieId) }),
  )
  if (!r.ok) return c.json({ error: 'history_failed', status: r.status }, 502)
  return c.json(mapHistory(await r.json().catch(() => [])))
})

// R6: PUT /api/v3/movie/:id — edit (monitored/qualityProfileId/
// rootFolderPath only). Fetch the full movie, overlay the allowlisted fields,
// PUT the whole object back. Never blind-passthrough the client body.
radarr.put('/api/v3/movie/:id', requireAdmin, radarrMutateLimit, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const patch = extractEditPatch(await c.req.json().catch(() => null))
  const getRes = await radarrFetch(`/api/v3/movie/${id}`, { method: 'GET' })
  if (!getRes.ok) return c.json({ error: 'movie_lookup_failed', status: getRes.status }, 502)
  const full = (await getRes.json()) as Record<string, unknown>
  const merged = mergeEdit(full, patch)
  const putRes = await radarrFetch(`/api/v3/movie/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(merged),
  })
  if (!putRes.ok) return c.json({ error: 'movie_update_failed', status: putRes.status }, 502)
  return new Response(await putRes.text(), {
    status: putRes.status,
    headers: { 'Content-Type': putRes.headers.get('Content-Type') ?? 'application/json' },
  })
})

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
async function grabBestUnderCap(
  movieId: number,
  rootFolder: RootFolderSpaceSnapshot,
  title?: string,
  sub?: string,
): Promise<CappedGrabResult> {
  // `sub` rides on `base` so every {...base} event below is attributed to
  // the user who triggered the add — mirrors grabTvUnderCap. Without it,
  // readEventsForItem's legacy allowance (undefined sub matches everyone)
  // made every Radarr grab event visible to every caller of /by-item.
  const base = { itemId: movieId, title, capGb: env.maxMovieGb, sub }
  await recordRadarrGrabEvent({ ...base, type: 'grab_started' })

  // Brief delay so Radarr finishes wiring the new movie record before
  // we hit the release endpoint.
  await new Promise((r) => setTimeout(r, 1500))
  const releaseRes = await radarrFetch(`/api/v3/release?movieId=${movieId}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    console.error(`[movie-cap] release search ${releaseRes.status} for movie ${movieId}`)
    await recordRadarrGrabEvent({ ...base, type: 'search_failed', status: releaseRes.status })
    return { status: 'search_failed', upstreamStatus: releaseRes.status }
  }
  const all = (await releaseRes.json()) as Release[]
  // Finding 4-1: filter against free space MINUS in-flight reservations, not
  // the raw snapshot, so two concurrent adds don't both pass against the same
  // figure.
  const availableBytes = radarrReservations.availableBytes(rootFolder)
  // Releases Radarr ITSELF accepts: parsed, title-matched, wanted quality,
  // not rejected. A release Radarr marks rejected/temporarilyRejected (e.g.
  // "Unable to parse release", wrong movie) is not grabbable for reasons
  // that have nothing to do with our size cap — splitting it out here lets
  // the caller distinguish "every candidate is over the cap" (roll back)
  // from "Radarr rejected everything" (keep monitored, like no_releases).
  const radarrAccepted = all.filter(
    (r) => !r.rejected && !r.temporarilyRejected && r.size > 0,
  )
  const eligible = radarrAccepted
    .filter(
      (r) =>
        r.size <= env.maxMovieBytes &&
        availableBytes - r.size >= env.minFreeBytes,
    )
    .sort((a, b) => b.qualityWeight - a.qualityWeight)
  if (eligible.length === 0) {
    // Three distinct "nothing to grab" cases:
    //   no_releases          — indexers returned nothing at all.
    //   no_matching_releases — releases exist but Radarr rejected every one
    //                          (parse/title/quality); the cap never applied.
    //   all_rejected_by_cap  — Radarr-accepted releases exist, but every one
    //                          exceeds the size cap / free-space gate.
    const status =
      all.length === 0
        ? 'no_releases'
        : radarrAccepted.length === 0
          ? 'no_matching_releases'
          : 'all_rejected_by_cap'
    console.log(
      `[movie-cap] ${status} for movie ${movieId} ` +
        `(${all.length} scanned, ${radarrAccepted.length} matched, 0 ≤ ${env.maxMovieGb}GB)`,
    )
    await recordRadarrGrabEvent({
      ...base,
      type: status,
      scanned: all.length,
      eligible: 0,
    })
    return { status, scanned: all.length }
  }
  const best = eligible[0]
  // Finding 4-1: reserve the planned bytes BEFORE issuing the grab so a
  // concurrent add sees the reduced availability immediately. If the reserve
  // itself fails (another in-flight add already committed the remaining
  // headroom in the race window), refuse rather than overcommit the disk.
  if (!radarrReservations.reserve(rootFolder, best.size)) {
    await recordRadarrGrabEvent({
      ...base,
      type: 'all_rejected_by_cap',
      scanned: all.length,
      eligible: eligible.length,
      error: `planned movie grab would overcommit pending reservations for ${rootFolder.path}`,
    })
    return { status: 'all_rejected_by_cap', scanned: all.length }
  }
  let grabRes: Awaited<ReturnType<typeof radarrFetch>>
  try {
    grabRes = await radarrFetch('/api/v3/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }),
    })
  } catch (err) {
    // Egress failed entirely — nothing was grabbed, so free the reservation.
    radarrReservations.release(rootFolder, best.size)
    throw err
  }
  // The grab is queued; SAB/Radarr now owns the on-disk accounting. Release
  // our in-flight reservation either way: on success the bytes are committed
  // downstream (and the next add's gate will reflect them once SAB reports
  // them), and on failure nothing landed. Holding the reservation past this
  // point would leak headroom until restart.
  radarrReservations.release(rootFolder, best.size)
  console.log(
    `[movie-cap] grab "${best.title}" ${(best.size / 1024 ** 3).toFixed(2)}GB ` +
      `for movie ${movieId} → ${grabRes.status}`,
  )
  await recordRadarrGrabEvent({
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
  if (!grabRes.ok) {
    return { status: 'grab_failed', upstreamStatus: grabRes.status }
  }
  return { status: 'grab_succeeded' }
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

// Honoured-policy allow-list: identifying metadata PLUS the controls the Add
// dialog now exposes to every household member (monitored + searchForMovie via
// addOptions). rootFolderPath + qualityProfileId are validated against the live
// lists and stamped by validateHonoredAddBody; tags stay admin-only.
const HONORED_RADARR_ALLOW: ReadonlyArray<string> = [
  ...NON_ADMIN_RADARR_ALLOW,
  'monitored',
  'addOptions',
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

type CreatedRadarrMovie = RadarrAddBody & { id?: number; title?: string }

async function deleteCreatedMovie(movie: CreatedRadarrMovie): Promise<{ ok: true } | { ok: false; status: number }> {
  if (!movie.id) return { ok: false, status: 0 }
  const res = await radarrFetch(`/api/v3/movie/${movie.id}`, { method: 'DELETE' })
  if (!res.ok) {
    console.error(`[movie-cap] failed to roll back movie ${movie.id}: ${res.status}`)
    return { ok: false, status: res.status }
  }
  return { ok: true }
}

// Flip a just-added movie to monitored so Radarr's RSS sync downloads it
// automatically once a release appears. Used when the cap-aware search found
// NO releases yet (e.g. an unreleased/future film) — rather than discarding
// the add with a dead-end 424, we keep it and let it grab when available,
// which is what "add and monitor" is supposed to mean. PUT the full movie
// resource back (Radarr expects the whole object) with monitored overridden.
async function setMovieMonitored(
  movie: CreatedRadarrMovie,
  monitored: boolean,
): Promise<{ ok: boolean; status: number }> {
  if (!movie.id) return { ok: false, status: 0 }
  const res = await radarrFetch(`/api/v3/movie/${movie.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...movie, monitored }),
  })
  if (!res.ok) {
    console.error(`[movie-cap] failed to set monitored on movie ${movie.id}: ${res.status}`)
  }
  return { ok: res.ok, status: res.status }
}

// Radarr can 201 the add while returning a body we can't use (non-JSON
// proxy interjection, or a record echoed without a title). The movie DOES
// exist upstream — created unmonitored by the cap rewrite — so skipping the
// grab on a bad body would strand a dead movie that neither downloads nor
// monitors. Recover the canonical record by tmdbId before giving up.
// Radarr's /movie?tmdbId= filter returns at most one record.
async function lookupMovieByTmdbId(tmdbId: unknown): Promise<CreatedRadarrMovie | null> {
  if (typeof tmdbId !== 'number' || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null
  try {
    const res = await radarrFetch(`/api/v3/movie?tmdbId=${tmdbId}`, { method: 'GET' })
    if (!res.ok) return null
    const list = (await res.json()) as CreatedRadarrMovie[]
    const movie = Array.isArray(list) ? list[0] : undefined
    return movie?.id ? movie : null
  } catch (err) {
    console.error('[movie-cap] tmdbId recovery lookup failed:', err)
    return null
  }
}

function isUsableCreatedMovie(
  m: CreatedRadarrMovie | null,
): m is CreatedRadarrMovie & { id: number; title: string } {
  return Boolean(m?.id && typeof m.title === 'string' && m.title.trim().length > 0)
}

// STEP: non-admin policy materialization. The allowlist + policy stamping
// is Radarr's; the folder/profile resolution machinery (incl. pickProfile's
// preference chain) is shared with Sonarr in services/arrAdd.ts. Profile
// selection prefers env.defaultProfileName (case-insensitive — defaults to
// "choose me" to mirror the frontend modals) and fails closed if missing;
// without it, Radarr's default Any profile is sometimes id 1 and a
// non-admin direct-POST would land on the most permissive setting.
function materializeNonAdminMovieBody(raw: RadarrAddBody) {
  return materializeNonAdminAddBody({
    app: 'radarr',
    raw,
    allowKeys: NON_ADMIN_RADARR_ALLOW,
    loadFolders: radarrRootFolders,
    fetchProfiles: () => radarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
    configuredFolderPath: env.defaultRadarrRootFolderPath,
    applyPolicy: (safe, picked) => {
      safe.rootFolderPath = picked.folderPath
      safe.qualityProfileId = picked.profileId
      safe.monitored = true
      // searchForMovie:true gates the cap-aware grab for non-admins who'd
      // otherwise just want "add and start." The cap rewrite still forces
      // searchForMovie:false on the actual upstream call so the grab path
      // is the only download trigger.
      safe.addOptions = { searchForMovie: true }
      safe.tags = []
    },
  })
}

// STEP: parse + policy. Pass through full admin policy only when the client
// actually sent policy fields. An admin previewing-as-user (auth.tsx makes
// isAdmin viewAs-aware) sends the slim user-shape body { tmdbId, title, year }
// through AddMovieModal — without this branch that body would skip
// materialize and trip the rootFolderPath_required gate in 2ms, surfacing as
// the cryptic "Radarr /movie: 400" toast. Non-admins (and admins-in-preview)
// can't dictate quality / folder / monitor / tag / searchForMovie policy —
// those are admin-curated; materialization replaces them with server-derived
// defaults so a direct-POST can't bypass the curated profile.
async function resolveMovieAddBody(
  session: { role: string },
  parsedBody: unknown,
): Promise<{ ok: true; body: RadarrAddBody } | { ok: false; payload: Record<string, unknown>; status: 400 | 503 }> {
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return { ok: false, payload: { error: 'invalid_body' }, status: 400 }
  }
  const rawBody = parsedBody as RadarrAddBody
  // Admin sending policy → trusted, pass the full body through verbatim.
  if (session.role === 'admin' && rawBody.rootFolderPath !== undefined) {
    return { ok: true, body: rawBody }
  }
  // Non-admin sending policy: the Add dialog now shows EVERY household member
  // the quality/folder/search controls, so honour their choices — but validate
  // each field against the live upstream lists first (no path/profile
  // injection). Per-title size caps are enforced downstream regardless.
  if (rawBody.rootFolderPath !== undefined) {
    const honored = await validateHonoredAddBody({
      app: 'radarr',
      raw: rawBody,
      allowKeys: HONORED_RADARR_ALLOW,
      loadFolders: radarrRootFolders,
      fetchProfiles: () => radarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
      configuredFolderPath: env.defaultRadarrRootFolderPath,
    })
    if (!honored.ok) {
      return { ok: false, payload: materializeFailurePayload(honored), status: addResolveStatus(honored.reason) }
    }
    return { ok: true, body: honored.body }
  }
  // No policy fields at all (legacy slim body / admin-preview) → curated defaults.
  const materialized = await materializeNonAdminMovieBody(rawBody)
  if (!materialized.ok) {
    return { ok: false, payload: materializeFailurePayload(materialized), status: 503 }
  }
  return { ok: true, body: materialized.body }
}

radarr.post('/api/v3/movie', radarrMutateLimit, async (c) => {
  const session = c.get('session')
  // STEP 1 — parse + policy.
  const resolved = await resolveMovieAddBody(session, await c.req.json().catch(() => null))
  if (!resolved.ok) {
    return c.json(resolved.payload, resolved.status)
  }
  const body = resolved.body
  // STEP 2 — hard disk-space gate. Fail closed on every "we couldn't
  // actually measure free space" case (missing path, unknown path, response
  // without freeSpace) — see gateRootFolderSpace in services/arrAdd.ts.
  const spaceGate = await validateRadarrRootFolderSpace(body.rootFolderPath)
  if (!spaceGate.ok) {
    return c.json(spaceGate.failure.body, spaceGate.failure.status)
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

  // Mirror a successful add to the recommender as a strong 'added' conversion
  // signal — the user turned a suggestion into a real library entry. The
  // sidecar maps signal:'added' to outcome:'added' and ties it to the most
  // recent rec_log row for the same (sub, kind, tmdb_id), so the optimizer
  // learns from real conversions, not just the dot-feedback subset. tmdbId
  // survives the non-admin materialize step (NON_ADMIN_RADARR_ALLOW).
  //
  // CRITICAL: only fire this where the movie is actually KEPT (called at the
  // keep-success returns below), NOT here up-front. Firing before the
  // cap-aware grab — as this used to — recorded a false 'added' even when the
  // grab then rolled the movie back out with a 424 (over-cap, search/grab
  // failure, or every release Radarr-rejected), poisoning the optimizer with
  // conversions for titles that no longer exist. Gated on useLocalRecommender
  // so disabled/direct-backend deployments emit no sidecar traffic.
  const signalAdded = () => {
    if (!(r.ok && env.useLocalRecommender)) return
    const tmdbId = typeof body.tmdbId === 'number' ? body.tmdbId : undefined
    if (tmdbId === undefined) return
    void postFeedback(
      { sub: session.sub, kind: 'movie', tmdb_id: tmdbId, signal: 'added' },
      recommenderCallerFromSession(session),
    )
  }

  // Body returned to the SPA on the keep paths below. Replaced by the
  // re-fetched record when the 201 body was unparseable, so the client always
  // receives the movie JSON it expects rather than the raw upstream bytes.
  let keepBody = out
  let keepContentType = r.headers.get('Content-Type') ?? 'application/json'

  // STEP 4+5 — recover the created record, then AWAIT the size-capped grab
  // before returning ordinary success. The movie is intentionally added
  // unmonitored on this path, so a failed capped search has no Radarr retry
  // safety net unless we surface it here. (This is deliberately synchronous
  // where Sonarr's TV grab is fire-and-forget — see the contrast note on
  // grabTvUnderCap's spawn site in sonarr.ts: the movie path has rollback
  // semantics the SPA turns into capped_grab_* toasts.)
  if (r.ok && wantedSearch) {
    const recovered = await recoverCreatedMovie(out, body.tmdbId)
    if (recovered.refetchedBody !== null) {
      keepBody = recovered.refetchedBody
      keepContentType = 'application/json'
    }
    const created = recovered.created
    if (!isUsableCreatedMovie(created)) {
      return await rejectUnverifiedAdd(c, created, body.title, session.sub)
    }
    const settled = await settleCappedMovieGrab(c, {
      created,
      folder: spaceGate.folder,
      sub: session.sub,
      signalAdded,
    })
    if (settled) return settled
  }

  // Reached on: a successful capped grab (grab_succeeded) or the "Just
  // monitor" path (!wantedSearch) — both KEEP the movie, so the conversion
  // signal is real. (Every rollback path above returned before here.)
  signalAdded()
  return new Response(keepBody, {
    status: r.status,
    headers: { 'Content-Type': keepContentType },
  })
})

// STEP 4 — recover the created record. Radarr can 201 the add while
// returning a body we can't use; the movie DOES exist upstream (created
// unmonitored by the cap rewrite), so silently skipping the grab on a bad
// body would strand a dead movie. Re-fetch the canonical record by tmdbId;
// when that succeeds the refetched JSON also replaces the response body the
// SPA receives.
async function recoverCreatedMovie(
  out: string,
  tmdbId: unknown,
): Promise<{ created: CreatedRadarrMovie | null; refetchedBody: string | null }> {
  let created = (() => {
    try {
      return JSON.parse(out) as CreatedRadarrMovie
    } catch {
      return null
    }
  })()
  let refetchedBody: string | null = null
  if (!isUsableCreatedMovie(created)) {
    const refetched = await lookupMovieByTmdbId(tmdbId)
    if (refetched) {
      created = refetched
      refetchedBody = JSON.stringify(refetched)
    }
  }
  return { created, refetchedBody }
}

// STEP 5 (failure leg) — the 201 body was unusable AND the tmdbId re-fetch
// couldn't identify the movie. The cap grab and the monitor fallback are both
// impossible, so don't claim success: roll back if an id survived parsing,
// record why for the admin panel, and surface a distinct error to the UI.
async function rejectUnverifiedAdd(
  c: Context<Env>,
  created: CreatedRadarrMovie | null,
  bodyTitle: unknown,
  sub: string,
): Promise<Response> {
  const rollback = created?.id ? await deleteCreatedMovie(created) : null
  await recordRadarrGrabEvent({
    itemId: created?.id ?? 0,
    title: typeof bodyTitle === 'string' ? bodyTitle : undefined,
    sub,
    type: 'grab_failed',
    error:
      'Radarr add returned success but the created movie could not be identified ' +
      '(unparseable/untitled response body and tmdbId re-fetch failed); cap-aware grab skipped',
  })
  return c.json(
    {
      error: 'add_unverified',
      message:
        'Radarr accepted the add but did not identify the created movie, so no download was started. ' +
        'Check Radarr directly, then retry.',
      rollbackStatus: rollback && !rollback.ok ? rollback.status || undefined : undefined,
    },
    502,
  )
}

// STEP 5 — map the capped-grab outcome to a response. Returns null when the
// movie is KEPT with a successful grab (the handler then falls through to the
// ordinary-success response + conversion signal).
async function settleCappedMovieGrab(
  c: Context<Env>,
  opts: {
    created: CreatedRadarrMovie & { id: number; title: string }
    folder: RootFolderSpaceSnapshot
    sub: string
    signalAdded: () => void
  },
): Promise<Response | null> {
  const { created, folder, sub, signalAdded } = opts
  const itemId = created.id
  const itemTitle = created.title
  try {
    const grab = await grabBestUnderCap(itemId, folder, itemTitle, sub)
    if (grab.status === 'search_failed' || grab.status === 'grab_failed') {
      const rollback = await deleteCreatedMovie(created)
      return c.json(
        {
          error: 'capped_grab_failed',
          status: grab.upstreamStatus,
          phase: grab.status === 'search_failed' ? 'search' : 'grab',
          rollbackStatus: rollback.ok ? undefined : rollback.status || undefined,
          movie: created,
        },
        424,
      )
    }
    if (grab.status === 'no_releases' || grab.status === 'no_matching_releases') {
      // Nothing GRABBABLE yet — either an unreleased/future film with no
      // releases at all (no_releases), or releases exist but Radarr
      // rejected every one for parse/title/quality reasons unrelated to
      // our size cap (no_matching_releases — e.g. an obscure short whose
      // only releases have unparseable names). In BOTH cases the size cap
      // never applied, so do NOT discard the add: flip it to monitored so
      // Radarr's RSS sync grabs it the moment a usable release appears.
      // This is the "add it and it'll come when available" behavior, and
      // avoids the dead-end 424 on titles that simply have no clean
      // release right now.
      const monitored = await setMovieMonitored(created, true)
      if (!monitored.ok) {
        return c.json(
          {
            error: 'monitor_enable_failed',
            status: monitored.status || undefined,
            phase: grab.status,
            scanned: grab.scanned,
            movie: created,
          },
          502,
        )
      }
      signalAdded() // kept + monitored → a real conversion
      return c.json(
        {
          status: 'monitoring',
          phase: grab.status,
          scanned: grab.scanned,
          monitored: true,
          movie: created,
        },
        200,
      )
    }
    if (grab.status === 'all_rejected_by_cap') {
      // Releases DO exist but every one exceeds the size cap. Honor the
      // cap and roll back rather than leave a monitored item that RSS
      // would later auto-grab uncapped.
      const rollback = await deleteCreatedMovie(created)
      return c.json(
        {
          error: 'capped_grab_not_started',
          phase: grab.status,
          scanned: grab.scanned,
          capGb: env.maxMovieGb,
          rollbackStatus: rollback.ok ? undefined : rollback.status || undefined,
          movie: created,
        },
        424,
      )
    }
  } catch (e) {
    console.error('[movie-cap] grab failed:', e)
    await recordRadarrGrabEvent({
      itemId,
      title: itemTitle,
      sub,
      type: 'grab_failed',
      error: e instanceof Error ? e.message : String(e),
    })
    const rollback = await deleteCreatedMovie(created)
    return c.json(
      {
        error: 'capped_grab_failed',
        phase: 'exception',
        message: e instanceof Error ? e.message : String(e),
        rollbackStatus: rollback.ok ? undefined : rollback.status || undefined,
      },
      424,
    )
  }
  return null // grab_succeeded → keep
}

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
radarr.post('/api/v3/movie/:id/upgrade', requireAdmin, radarrMutateLimit, async (c) => {
  const id = Number(c.req.param('id'))
  // Radarr movie ids are positive integers; rejecting decimals /
  // negatives / unsafe-large numbers up front avoids a wasted Radarr
  // round-trip on a junk path.
  if (!Number.isSafeInteger(id) || id <= 0) {
    return c.json({ error: 'bad_id' }, 400)
  }
  const movieRes = await radarrFetch(`/api/v3/movie/${id}`, {
    method: 'GET',
  })
  if (!movieRes.ok) {
    return c.json({ error: 'movie_lookup_failed', status: movieRes.status }, 502)
  }
  const movie = (await movieRes.json()) as { rootFolderPath?: unknown }
  const rootFolderPath = typeof movie.rootFolderPath === 'string' ? movie.rootFolderPath : undefined
  const spaceGate = await validateRadarrRootFolderSpace(rootFolderPath)
  if (!spaceGate.ok) {
    return c.json(spaceGate.failure.body, spaceGate.failure.status)
  }
  const releaseRes = await radarrFetch(`/api/v3/release?movieId=${id}`, {
    method: 'GET',
  })
  if (!releaseRes.ok) {
    return c.json({ error: 'release_search_failed', status: releaseRes.status }, 502)
  }
  const all = (await releaseRes.json()) as Release[]
  if (all.length === 0) {
    return c.json({ status: 'no_releases_found' })
  }
  // Finding 4-1: reservation-aware availability on the upgrade path too, so a
  // concurrent add + upgrade against the same root folder can't both pass the
  // gate against one stale snapshot.
  const availableUpgradeBytes = radarrReservations.availableBytes(spaceGate.folder)
  const eligible = all
    .filter((r) =>
      !r.rejected &&
      !r.temporarilyRejected &&
      r.size > 0 &&
      r.size <= env.maxMovieBytes &&
      availableUpgradeBytes - r.size >= env.minFreeBytes
    )
    .sort((a, b) => b.qualityWeight - a.qualityWeight)
  if (eligible.length === 0) {
    return c.json({
      status: 'no_upgrade_available',
      scanned: all.length,
      capGb: env.maxMovieGb,
    })
  }
  const best = eligible[0]
  if (!radarrReservations.reserve(spaceGate.folder, best.size)) {
    return c.json({
      status: 'no_upgrade_available',
      scanned: all.length,
      capGb: env.maxMovieGb,
    })
  }
  let grabRes: Awaited<ReturnType<typeof radarrFetch>>
  try {
    grabRes = await radarrFetch('/api/v3/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid: best.guid, indexerId: best.indexerId }),
    })
  } catch (err) {
    radarrReservations.release(spaceGate.folder, best.size)
    throw err
  }
  radarrReservations.release(spaceGate.folder, best.size)
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
