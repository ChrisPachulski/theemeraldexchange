// HTTP client for the local recommender sidecar.
//
// The recommender lives in the same docker-compose stack (service name
// `recommender`, port 8000) and is reachable only inside the Docker
// network. env.ts switches the default URL on NODE_ENV:
//   - production → http://recommender:8000 (compose hostname)
//   - dev / test → http://localhost:8000 (matches the readme quickstart
//     for hand-running the sidecar with `uvicorn app.main:app`)
// In dev the call fails fast if the developer hasn't started the
// sidecar, and the route handler falls back to TMDB trending.
//
// Schema mirrors recommender/app/schemas.py: keep them in sync.

import { env } from '../env.js'
import { fetchWithTimeout } from './upstream.js'
import { mintInternalPrincipal, type InternalPrincipalInput } from './internalPrincipal.js'
import { reportServerEvent } from './serverTelemetry.js'

export type RecommenderKind = 'movie' | 'tv'

export type RecommenderProvenance = 'personalized' | 'discover' | 'trending'

export type RecommenderLibraryItem = {
  tmdb_id?: number
  title?: string
  source?: 'sonarr' | 'radarr'
}

export type RecommenderFeedback = {
  tmdb_id: number
  signal: 'like' | 'dislike' | 'reject'
}

export type RecommenderScoreRequest = {
  sub: string
  kind: RecommenderKind
  n: number
  exclude_recently_shown?: boolean
  library?: RecommenderLibraryItem[]
  feedback?: RecommenderFeedback[]
  household_rejections?: number[]
}

export type RecommenderScoredItem = {
  tmdb_id: number
  title: string | null
  year: number | null
  poster_path: string | null
  overview: string | null
  score: number
  provenance: RecommenderProvenance
  reason: string | null
}

export type RecommenderScoreResponse = {
  items: RecommenderScoredItem[]
  model_version: string
  recipe: string
  diag: Record<string, unknown>
}

// 5s was set when /score was a trivial lookup. The production `fused` recipe
// (co-engagement retrieval-union + cast/crew fusion) plus a cold model/vec
// index right after a deploy restart can push a real full-library scoring call
// past 5s, which aborted → silently degraded EVERY user to trending ("broken
// everywhere" after a deploy). Warm calls return in ~1s so this ceiling only
// engages on a genuinely slow call, where waiting for a personalized result
// beats failing closed to trending. A truly-down sidecar fails fast (connection
// refused), not a 15s hang, so the larger budget costs nothing in that case.
const REQUEST_TIMEOUT_MS = 15_000

// Fire-and-forget mirror posts to the recommender sidecar still have
// to be bounded so a hung sidecar doesn't leak sockets every time the
// user clicks a dot. 3 s is more than enough for the recommender's
// event endpoints (SQLite INSERT + return); anything past that, just
// drop the event — the next interaction will resend converging state.
const MIRROR_TIMEOUT_MS = 3_000

/** Caller identity for the internal-principal JWE (§4 Hybrid D).
 *  When provided, the recommender request carries
 *  `Authorization: Bearer <jwe>` alongside the existing
 *  `x-recommender-secret` header. The recommender service does not
 *  enforce the principal yet (waiting on the PyO3 wheel landing in
 *  its container image); the wire-up is in place so M3 cutover is a
 *  one-line recommender-side enforcement flip. */
export type RecommenderCaller = InternalPrincipalInput

function recommenderHeaders(caller?: RecommenderCaller): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (env.recommenderEventSecret) {
    headers['x-recommender-secret'] = env.recommenderEventSecret
  }
  // Attach the principal only when we have a caller identity AND the
  // INTERNAL_PRINCIPAL_SECRET is configured. Dev installs without the
  // secret keep working; prod has it required at boot.
  if (caller && env.internalPrincipalSecret) {
    try {
      headers['authorization'] = `Bearer ${mintInternalPrincipal(caller)}`
    } catch (e) {
      // mintInternalPrincipal only throws on missing secret, which we
      // already guarded above. Log and proceed without the header so a
      // transient mint failure doesn't break the call.
      console.warn('[recommender] failed to mint internal-principal:', e)
    }
  }
  return headers
}

async function mirrorPost(
  path: string,
  body: unknown,
  label: string,
  caller?: RecommenderCaller,
): Promise<void> {
  let res: Response
  try {
    res = await fetchWithTimeout(
      `${env.recommenderUrl}${path}`,
      {
        method: 'POST',
        headers: recommenderHeaders(caller),
        body: JSON.stringify(body),
      },
      MIRROR_TIMEOUT_MS,
      label,
    )
  } catch (err) {
    // Timeout / network error — the sidecar is unreachable. This mirror
    // is the only path for click/feedback attribution, so a drop is
    // silent training-signal loss. Emit to the mandatory (§15) telemetry
    // pipeline before re-throwing so callers' existing error handling is
    // unchanged.
    void reportServerEvent({
      level: 'warning',
      message: `recommender mirror error: ${label}`,
      context: { label, path, error: err instanceof Error ? err.message : String(err) },
    })
    throw err
  }
  const responseBody = await res.text().catch(() => '')
  if (!res.ok) {
    console.warn('[recommender] mirror POST failed', {
      label,
      path,
      status: res.status,
      body: responseBody.slice(0, 200),
    })
    // Non-ok HTTP response (sidecar reachable but rejected the event).
    // Same silent-signal-loss concern; route it through telemetry too.
    // Handling both branches in mirrorPost covers every caller (click,
    // /feedback, radarr added, impressions, library sync) in one place.
    void reportServerEvent({
      level: 'warning',
      message: `recommender mirror non-ok: ${label}`,
      context: { label, path, status: res.status },
    })
  }
}

export class RecommenderError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'RecommenderError'
  }
}

export async function scoreOnce(
  req: RecommenderScoreRequest,
  caller?: RecommenderCaller,
): Promise<RecommenderScoreResponse> {
  const url = `${env.recommenderUrl}/score`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: recommenderHeaders(caller),
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new RecommenderError(
        `recommender /score ${r.status}: ${body.slice(0, 200)}`,
        r.status,
      )
    }
    return (await r.json()) as RecommenderScoreResponse
  } catch (e) {
    if (e instanceof RecommenderError) throw e
    throw new RecommenderError(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(t)
  }
}

export async function postFeedback(
  ev: {
    sub: string
    kind: RecommenderKind
    tmdb_id: number
    signal: 'like' | 'dislike' | 'reject' | 'shown' | 'clicked' | 'added' | 'watched'
  },
  caller?: RecommenderCaller,
): Promise<void> {
  await mirrorPost('/events/feedback', ev, 'recommender.postFeedback', caller)
}

// Read-only funnel metrics for the admin observability surface. Unlike the
// fire-and-forget mirrors, the caller needs the payload, so this throws on
// failure rather than swallowing it.
export async function getFunnelMetrics(
  windowDays = 30,
  caller?: RecommenderCaller,
): Promise<unknown> {
  const wd = Number.isFinite(windowDays) ? Math.max(1, Math.min(365, Math.floor(windowDays))) : 30
  const url = `${env.recommenderUrl}/metrics/funnel?window_days=${wd}`
  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: recommenderHeaders(caller) },
    REQUEST_TIMEOUT_MS,
    'recommender.getFunnelMetrics',
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new RecommenderError(`funnel metrics ${res.status}: ${body.slice(0, 200)}`, res.status)
  }
  return res.json()
}

export async function postRejection(
  ev: { kind: RecommenderKind; tmdb_id: number },
  caller?: RecommenderCaller,
): Promise<void> {
  await mirrorPost('/events/rejection', ev, 'recommender.postRejection', caller)
}

// Recommender INSERTs feedback by (sub, kind, tmdb_id, signal), so a
// toggle (dislike → like) without an explicit clear leaves both rows;
// load_user_context unions them. These cancel rows so the recommender
// converges to Hono's source-of-truth state.
export async function postClearFeedback(
  ev: {
    sub: string
    kind: RecommenderKind
    tmdb_id: number
    signal?: 'like' | 'dislike' | 'reject'
  },
  caller?: RecommenderCaller,
): Promise<void> {
  await mirrorPost('/events/feedback/clear', ev, 'recommender.postClearFeedback', caller)
}

export async function postClearRejection(
  ev: {
    kind: RecommenderKind
    tmdb_id: number
  },
  caller?: RecommenderCaller,
): Promise<void> {
  await mirrorPost('/events/rejection/clear', ev, 'recommender.postClearRejection', caller)
}

export async function postLibrarySync(
  kind: RecommenderKind,
  items: RecommenderLibraryItem[],
  caller?: RecommenderCaller,
): Promise<void> {
  await mirrorPost('/events/library/sync', { kind, items }, 'recommender.postLibrarySync', caller)
}

// Server-appended trending-fill items aren't picked by the sidecar's
// /score, so they don't land in recently_shown automatically. Mirror
// them here so the next refresh's exclude_recently_shown filter sees
// them and the fill rotates instead of repeating the same trending
// cards every poll.
export async function postShown(
  sub: string,
  kind: RecommenderKind,
  tmdbIds: number[],
  caller?: RecommenderCaller,
): Promise<void> {
  if (tmdbIds.length === 0) return
  await mirrorPost('/events/shown', { sub, kind, tmdb_ids: tmdbIds }, 'recommender.postShown', caller)
}

export async function postImpressions(
  sub: string,
  kind: RecommenderKind,
  items: Array<{
    tmdb_id: number
    rank: number
    score: number
    provenance: RecommenderProvenance
    model_version: string
  }>,
  caller?: RecommenderCaller,
): Promise<void> {
  if (items.length === 0) return
  await mirrorPost('/events/impressions', { sub, kind, items }, 'recommender.postImpressions', caller)
}
