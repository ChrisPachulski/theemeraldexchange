// Allow-list of Radarr endpoints. Mirrors sonarr.ts.

import { Hono } from 'hono'
import { requireAuth, requireAdmin, type Env } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { radarrFetch, radarrRootFolders, type RootFolder } from '../services/radarr.js'
import { appendGrabEvent } from '../services/grabLog.js'
import { postFeedback } from '../services/recommender.js'
import { recommenderCallerFromSession } from '../services/recommenderCaller.js'
import { env } from '../env.js'

export const radarr = new Hono<Env>()

radarr.use('*', requireAuth)

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

type RadarrGrabEvent = Parameters<typeof appendGrabEvent>[0]
type RadarrSpaceGateFailure = {
  status: 400 | 502 | 507
  body: Record<string, unknown>
}
type RadarrFolderWithFreeSpace = RootFolder & { freeSpace: number }

// Finding 4-1: in-flight disk-space reservations keyed by root-folder path,
// mirroring sonarr.ts's pendingRootFolderReservations. Without this, two
// near-simultaneous movie adds both read the SAME stale folder.freeSpace
// snapshot, both clear the MIN_FREE_GB gate, and both grab up to
// env.maxMovieBytes — driving the disk below the reserve. We subtract the
// planned grab bytes from available space the moment a grab is committed and
// release the unused remainder afterward, so the second concurrent add sees
// the reduced figure and 507s when only one fits.
//
// SCOPE: in-process Map, single-instance (same caveat as the Sonarr
// reservation and the concurrency tracker). A restart drops reservations;
// at the M5 multi-replica work this moves to a shared DB-backed reservation
// reconciled against the SAB queue. Documented single-instance on purpose.
const pendingRadarrReservations = new Map<string, number>()

function availableRadarrFolderBytes(folder: RadarrFolderWithFreeSpace): number {
  return folder.freeSpace - (pendingRadarrReservations.get(folder.path) ?? 0)
}

function reserveRadarrFolderBytes(folder: RadarrFolderWithFreeSpace, bytes: number): boolean {
  if (!Number.isFinite(bytes) || bytes <= 0) return false
  const reserved = pendingRadarrReservations.get(folder.path) ?? 0
  if (folder.freeSpace - reserved - bytes < env.minFreeBytes) return false
  pendingRadarrReservations.set(folder.path, reserved + bytes)
  return true
}

function releaseRadarrFolderReservation(folder: RadarrFolderWithFreeSpace, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  const reserved = pendingRadarrReservations.get(folder.path) ?? 0
  const next = Math.max(0, reserved - bytes)
  if (next === 0) pendingRadarrReservations.delete(folder.path)
  else pendingRadarrReservations.set(folder.path, next)
}
type CappedGrabResult =
  | { status: 'grab_succeeded' }
  | { status: 'search_failed'; upstreamStatus: number }
  | { status: 'no_releases'; scanned: number }
  // Releases existed but Radarr rejected every one (parse/title/quality),
  // so the size cap never applied. Handled like no_releases (monitor),
  // not like all_rejected_by_cap (roll back).
  | { status: 'no_matching_releases'; scanned: number }
  | { status: 'all_rejected_by_cap'; scanned: number }
  | { status: 'grab_failed'; upstreamStatus: number }

async function recordRadarrGrabEvent(event: RadarrGrabEvent): Promise<void> {
  await appendGrabEvent(event).catch((err) => {
    console.error('[radarr] grab log write failed:', err)
  })
}

async function validateRadarrRootFolderSpace(rootFolderPath?: string): Promise<
  { ok: true; folder: RadarrFolderWithFreeSpace } | { ok: false; failure: RadarrSpaceGateFailure }
> {
  if (!rootFolderPath) {
    return { ok: false, failure: { status: 400, body: { error: 'rootFolderPath_required' } } }
  }
  let folders: Awaited<ReturnType<typeof radarrRootFolders>>
  try {
    folders = await radarrRootFolders()
  } catch (err) {
    console.error('[radarr] rootfolder lookup failed:', err)
    return { ok: false, failure: { status: 502, body: { error: 'rootfolder_unreachable' } } }
  }
  const folder = folders.find((f) => f.path === rootFolderPath)
  if (!folder) {
    return { ok: false, failure: { status: 400, body: { error: 'unknown_root_folder', path: rootFolderPath } } }
  }
  if (typeof folder.freeSpace !== 'number' || !Number.isFinite(folder.freeSpace)) {
    return { ok: false, failure: { status: 507, body: { error: 'free_space_unknown', path: folder.path } } }
  }
  const typedFolder = folder as RadarrFolderWithFreeSpace
  // Finding 4-1: gate against free space MINUS in-flight reservations so a
  // second concurrent add can't clear the gate against the same stale snapshot
  // the first add is already spending.
  const available = availableRadarrFolderBytes(typedFolder)
  if (available < env.minFreeBytes) {
    return {
      ok: false,
      failure: {
        status: 507,
        body: {
          error: 'insufficient_disk_space',
          free_bytes: available,
          threshold_bytes: env.minFreeBytes,
          path: folder.path,
        },
      },
    }
  }
  return { ok: true, folder: typedFolder }
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
  rootFolder: RadarrFolderWithFreeSpace,
  title?: string,
): Promise<CappedGrabResult> {
  const base = { app: 'radarr' as const, itemId: movieId, title, capGb: env.maxMovieGb }
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
  type Release = {
    guid: string
    indexerId: number
    size: number
    qualityWeight: number
    title: string
    rejected?: boolean
    temporarilyRejected?: boolean
  }
  const all = (await releaseRes.json()) as Release[]
  // Finding 4-1: filter against free space MINUS in-flight reservations, not
  // the raw snapshot, so two concurrent adds don't both pass against the same
  // figure.
  const availableBytes = availableRadarrFolderBytes(rootFolder)
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
  if (!reserveRadarrFolderBytes(rootFolder, best.size)) {
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
    releaseRadarrFolderReservation(rootFolder, best.size)
    throw err
  }
  // The grab is queued; SAB/Radarr now owns the on-disk accounting. Release
  // our in-flight reservation either way: on success the bytes are committed
  // downstream (and the next add's gate will reflect them once SAB reports
  // them), and on failure nothing landed. Holding the reservation past this
  // point would leak headroom until restart.
  releaseRadarrFolderReservation(rootFolder, best.size)
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

function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * Pick a quality profile by preference order. See sonarr.ts pickProfile
 * for the rationale — the Radarr version is identical so a curated
 * household with one "Choose Me" or one "HD-1080p" profile lands on it
 * automatically.
 */
function pickProfile(
  profiles: Array<{ id: number; name?: string }>,
  defaultName: string,
): { id: number; name?: string } | undefined {
  if (profiles.length === 0) return undefined
  const norm = (n?: string) => (n ?? '').trim().toLowerCase()
  const named = profiles.find((p) => norm(p.name) === defaultName)
  if (named) return named
  const has1080p = profiles.find((p) => norm(p.name).includes('1080p'))
  if (has1080p) return has1080p
  const startsHd = profiles.find((p) => norm(p.name).startsWith('hd'))
  if (startsHd) return startsHd
  const notAny = profiles.find((p) => norm(p.name) !== 'any')
  if (notAny) return notAny
  return profiles[0]
}

async function materializeNonAdminMovieBody(raw: RadarrAddBody): Promise<
  | { ok: true; body: RadarrAddBody }
  | {
      ok: false
      reason: string
      expected_name?: string
      available_names?: string[]
      expected_path?: string
      available_paths?: string[]
    }
> {
  // Pull the upstream's qualityprofile + rootfolder lists, then pick
  // the canonical "what the admin already curates" defaults. Profile
  // selection prefers env.defaultProfileName (case-insensitive exact
  // match — defaults to "choose me" to mirror the frontend modals)
  // and fails closed if that profile is missing. Without this
  // preference, Radarr's default Any profile is sometimes id 1 and a
  // non-admin direct-POST would land on the most permissive setting
  // instead of the curated one.
  const [folderResult, profileRes] = await Promise.all([
    radarrRootFolders()
      .then((folders) => ({ ok: true as const, folders }))
      .catch((err) => {
        console.error('[radarr] rootfolder lookup failed:', err)
        return { ok: false as const }
      }),
    radarrFetch('/api/v3/qualityprofile', { method: 'GET' }),
  ])
  if (!folderResult.ok) {
    return { ok: false, reason: 'rootfolder_unreachable' }
  }
  if (!profileRes.ok) {
    return { ok: false, reason: 'qualityprofile_unreachable' }
  }
  const profiles = (await profileRes.json()) as Array<{ id: number; name?: string }>
  const folders = folderResult.folders
  const configuredFolder = env.defaultRadarrRootFolderPath
  const folder = configuredFolder
    ? folders.find((f) => normalizePath(f.path) === normalizePath(configuredFolder))
    : folders[0]
  const profile = pickProfile(profiles, env.defaultProfileName)
  if (!folder) {
    return {
      ok: false,
      reason: configuredFolder ? 'default_root_folder_missing' : 'admin_must_configure_upstream',
      expected_path: configuredFolder ?? undefined,
      available_paths: folders.map((f) => f.path),
    }
  }
  if (!profile) {
    return {
      ok: false,
      reason: 'default_quality_profile_missing',
      expected_name: env.defaultProfileName,
      available_names: profiles.map((p) => p.name).filter((n): n is string => typeof n === 'string'),
    }
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

radarr.post('/api/v3/movie', radarrMutateLimit, async (c) => {
  const session = c.get('session')
  const parsedBody = await c.req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return c.json({ error: 'invalid_body' }, 400)
  }
  const rawBody = parsedBody as RadarrAddBody
  let body: RadarrAddBody
  // Pass through full admin policy only when the client actually sent
  // policy fields. An admin previewing-as-user (auth.tsx makes isAdmin
  // viewAs-aware) sends the slim user-shape body { tmdbId, title, year }
  // through AddMovieModal — without this branch that body would skip
  // materialize and trip the rootFolderPath_required gate below in 2ms,
  // surfacing as the cryptic "Radarr /movie: 400" toast.
  const adminSuppliedPolicy = session.role === 'admin' && rawBody.rootFolderPath !== undefined
  if (adminSuppliedPolicy) {
    body = rawBody
  } else {
    // Non-admins (and admins-in-preview) can't dictate quality / folder /
    // monitor / tag / searchForMovie policy — those are admin-curated.
    // Replace policy fields with server-derived defaults so a direct-POST
    // can't bypass the curated profile or pin a different root folder.
    const materialized = await materializeNonAdminMovieBody(rawBody)
    if (!materialized.ok) {
      const payload: Record<string, unknown> = { error: materialized.reason }
      if (materialized.expected_name) payload.expected_name = materialized.expected_name
      if (materialized.available_names) payload.available_names = materialized.available_names
      if (materialized.expected_path) payload.expected_path = materialized.expected_path
      if (materialized.available_paths) payload.available_paths = materialized.available_paths
      return c.json(payload, 503)
    }
    body = materialized.body
  }
  // Hard disk-space gate. Fail closed on every "we couldn't actually
  // measure free space" case — the prior implementation only blocked
  // when rootFolderPath was supplied AND the folder matched AND
  // freeSpace was a number, so a missing path, an unknown path, or a
  // Radarr response without freeSpace all silently bypassed the cap.
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

  // Wait for the size-capped grab before returning ordinary success.
  // The movie is intentionally added unmonitored on this path, so a failed
  // capped search has no Radarr retry safety net unless we surface it here.
  if (r.ok && wantedSearch) {
    const created = (() => {
      try {
        return JSON.parse(out) as CreatedRadarrMovie
      } catch {
        return null
      }
    })()
    if (created?.id && typeof created.title === 'string' && created.title.trim().length > 0) {
      const itemId = created.id
      const itemTitle = created.title
      try {
        const grab = await grabBestUnderCap(itemId, spaceGate.folder, itemTitle)
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
          app: 'radarr',
          itemId,
          title: itemTitle,
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
    }
  }

  // Reached on: a successful capped grab (grab_succeeded), the "Just monitor"
  // path (!wantedSearch), or r.ok with an unparseable add body — all KEEP the
  // movie, so the conversion signal is real. (Every rollback path above
  // returned a 424 before here.)
  signalAdded()
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
  type Release = {
    guid: string
    indexerId: number
    size: number
    qualityWeight: number
    title: string
    rejected?: boolean
    temporarilyRejected?: boolean
  }
  const all = (await releaseRes.json()) as Release[]
  if (all.length === 0) {
    return c.json({ status: 'no_releases_found' })
  }
  // Finding 4-1: reservation-aware availability on the upgrade path too, so a
  // concurrent add + upgrade against the same root folder can't both pass the
  // gate against one stale snapshot.
  const availableUpgradeBytes = availableRadarrFolderBytes(spaceGate.folder)
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
  if (!reserveRadarrFolderBytes(spaceGate.folder, best.size)) {
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
    releaseRadarrFolderReservation(spaceGate.folder, best.size)
    throw err
  }
  releaseRadarrFolderReservation(spaceGate.folder, best.size)
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
