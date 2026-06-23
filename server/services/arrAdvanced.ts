// Shared machinery for the Sonarr/Radarr "Advanced options" routes
// (interactive search + grab, command allowlist, history mapping, PUT
// field-allowlist merge). Both routes/{sonarr,radarr}.ts surface the same
// admin-only power-user actions; the client-observable contract is the
// single source of truth in
// docs/superpowers/specs/2026-06-22-arr-advanced-options-design.md.
//
// App-specific bits (which command names are allowed, how the per-release
// cap is computed for TV vs movies) are injected as small callbacks so the
// route files stay thin and the behavior is identical across apps where the
// spec says it should be.

import type { Context } from 'hono'
import type { Release } from './arrAdd.js'
import type { ArrGrabEvent, ReservationLedger, RootFolderSpaceSnapshot } from './arrGrab.js'
import type { Env } from '../middleware/auth.js'

// ---------------------------------------------------------------------------
// Interactive-search release shape returned to the client (S2 / R2).
//
// We DON'T blanket-forward Sonarr/Radarr's huge release record — we project
// the fields the release browser needs and add the two backend-computed
// convenience fields the spec mandates: `sizeGb` (size/1e9, 2dp) and
// `overCap` (size exceeds the per-item cap). `qualityWeight` rides along so
// the client can sort by quality then size without re-deriving it.
// ---------------------------------------------------------------------------

/** Raw upstream release record — a superset of the add-pipeline `Release`
 *  shape, carrying the extra display fields the interactive browser shows.
 *  Everything past guid/indexerId/size is best-effort (upstream may omit
 *  any of it), so the projection below defends every access. */
export type UpstreamRelease = Release & {
  seeders?: number
  protocol?: string
  indexer?: string
  ageHours?: number
  age?: number
  quality?: { quality?: { name?: string }; revision?: unknown }
  languages?: Array<{ name?: string }> | undefined
  rejections?: string[]
}

/** Projected release row sent to the client. Mirrors the spec's Release
 *  shape exactly. */
export type ClientRelease = {
  guid: string
  indexerId: number
  title: string
  size: number
  sizeGb: number
  seeders?: number
  protocol: string
  indexer?: string
  ageHours?: number
  quality: string
  qualityWeight: number
  languages: string[]
  fullSeason?: boolean
  seasonNumber?: number
  rejected: boolean
  rejections: string[]
  overCap: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Project one upstream release into the client shape, computing `overCap`
 * via the injected cap function. `capBytesFor` returns the byte ceiling for
 * THIS release (movies: a flat cap; TV: per-episode cap × episode count),
 * or null when the cap can't be determined — in which case the release is
 * treated as NOT over cap (fail open to "grabbable", matching the
 * interactive-search intent where an admin is making the call).
 */
export function projectRelease(
  r: UpstreamRelease,
  capBytesFor: (r: UpstreamRelease) => number | null,
): ClientRelease {
  const cap = capBytesFor(r)
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0
  return {
    guid: r.guid,
    indexerId: r.indexerId,
    title: r.title,
    size,
    sizeGb: round2(size / 1e9),
    seeders: typeof r.seeders === 'number' ? r.seeders : undefined,
    protocol: typeof r.protocol === 'string' ? r.protocol : 'unknown',
    indexer: typeof r.indexer === 'string' ? r.indexer : undefined,
    ageHours:
      typeof r.ageHours === 'number'
        ? r.ageHours
        : typeof r.age === 'number'
          ? r.age * 24
          : undefined,
    quality: r.quality?.quality?.name ?? 'Unknown',
    qualityWeight: typeof r.qualityWeight === 'number' ? r.qualityWeight : 0,
    languages: Array.isArray(r.languages)
      ? r.languages.map((l) => l?.name).filter((n): n is string => typeof n === 'string')
      : [],
    fullSeason: r.fullSeason,
    seasonNumber: r.seasonNumber,
    rejected: r.rejected === true || r.temporarilyRejected === true,
    rejections: Array.isArray(r.rejections)
      ? r.rejections.filter((s): s is string => typeof s === 'string')
      : [],
    overCap: cap !== null && size > cap,
  }
}

// ---------------------------------------------------------------------------
// Command allowlist (S1 / R1).
//
// We accept ONLY the named commands the spec lists, and only with the
// required companion fields. Any other name → 400. This is the single gate
// that keeps the generic `POST /command` proxy from being a blanket
// passthrough to every Sonarr/Radarr command (BackupDatabase, RssSync,
// arbitrary scripts, …).
// ---------------------------------------------------------------------------

export type CommandSpec = {
  /** Required body fields for this command beyond `name`. */
  requires?: ReadonlyArray<string>
  /** Fields (besides `name`) that may be forwarded upstream. */
  passthrough: ReadonlyArray<string>
}

export type CommandResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Validate + assemble the upstream `/command` body from a client request,
 * against a per-app allowlist. Returns the exact (and ONLY the) fields the
 * allowlist permits, so a client can't smuggle extra command parameters.
 */
export function buildCommandBody(
  raw: unknown,
  allow: Record<string, CommandSpec>,
): CommandResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' }
  }
  const body = raw as Record<string, unknown>
  const name = body.name
  if (typeof name !== 'string' || !(name in allow)) {
    return { ok: false, error: 'command_not_allowed' }
  }
  const spec = allow[name]
  for (const field of spec.requires ?? []) {
    const v = body[field]
    // Required companion fields must be present and non-empty (arrays must
    // have at least one element). A RenameFiles with no file ids, or an
    // EpisodeSearch with no episode ids, is a no-op upstream at best and a
    // 400 here — fail loudly rather than fire an empty command.
    if (v === undefined || v === null) return { ok: false, error: 'missing_required_field' }
    if (Array.isArray(v) && v.length === 0) return { ok: false, error: 'missing_required_field' }
  }
  const out: Record<string, unknown> = { name }
  for (const field of spec.passthrough) {
    if (body[field] !== undefined) out[field] = body[field]
  }
  return { ok: true, body: out }
}

// ---------------------------------------------------------------------------
// PUT field-allowlist merge (S7 / R6).
//
// Edit handlers NEVER blind-passthrough a client body. They fetch the full
// upstream object, overlay ONLY the allowlisted fields the client supplied,
// then PUT the whole object back. Anything outside the allowlist on the
// client body is ignored.
// ---------------------------------------------------------------------------

export const EDIT_ALLOWLIST = ['monitored', 'qualityProfileId', 'rootFolderPath'] as const

export type EditPatch = Partial<Record<(typeof EDIT_ALLOWLIST)[number], unknown>>

/** Extract only the allowlisted, well-typed edit fields from a client body.
 *  Wrong-typed values are dropped (not coerced) so a bogus qualityProfileId
 *  string can't reach Sonarr/Radarr. */
export function extractEditPatch(raw: unknown): EditPatch {
  const patch: EditPatch = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return patch
  const body = raw as Record<string, unknown>
  if (typeof body.monitored === 'boolean') patch.monitored = body.monitored
  if (typeof body.qualityProfileId === 'number' && Number.isFinite(body.qualityProfileId)) {
    patch.qualityProfileId = body.qualityProfileId
  }
  if (typeof body.rootFolderPath === 'string' && body.rootFolderPath.length > 0) {
    patch.rootFolderPath = body.rootFolderPath
  }
  return patch
}

/** Overlay an allowlisted patch onto the full upstream object. The full
 *  object is preserved; only allowlisted keys are replaced. */
export function mergeEdit<T extends Record<string, unknown>>(full: T, patch: EditPatch): T {
  return { ...full, ...patch }
}

// ---------------------------------------------------------------------------
// History mapping (S6 / R5).
// ---------------------------------------------------------------------------

export type HistoryRecord = {
  date: string
  eventType: string
  sourceTitle: string
  quality: string
  seasonNumber?: number
  episodeId?: number
}

type UpstreamHistoryRecord = {
  date?: string
  eventType?: string
  sourceTitle?: string
  quality?: { quality?: { name?: string } }
  seasonNumber?: number
  episodeId?: number
}

/** Sonarr/Radarr history is paged: `{ records: [...] }`. Radarr's
 *  /history/movie and Sonarr's /history/series both return a bare array.
 *  Accept either and project to the slim client shape, newest first
 *  preserved from upstream order (already newest-first). */
export function mapHistory(raw: unknown): HistoryRecord[] {
  const records: UpstreamHistoryRecord[] = Array.isArray(raw)
    ? (raw as UpstreamHistoryRecord[])
    : raw && typeof raw === 'object' && Array.isArray((raw as { records?: unknown }).records)
      ? ((raw as { records: UpstreamHistoryRecord[] }).records)
      : []
  return records.map((r) => ({
    date: typeof r.date === 'string' ? r.date : '',
    eventType: typeof r.eventType === 'string' ? r.eventType : 'unknown',
    sourceTitle: typeof r.sourceTitle === 'string' ? r.sourceTitle : '',
    quality: r.quality?.quality?.name ?? 'Unknown',
    ...(typeof r.seasonNumber === 'number' ? { seasonNumber: r.seasonNumber } : {}),
    ...(typeof r.episodeId === 'number' ? { episodeId: r.episodeId } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Interactive grab (S3 / R3).
//
// An admin picks a specific release in the browser and grabs it. Unlike the
// automatic cap-aware grab pipeline, the release is chosen by hand, so the
// cap is advisory: we flag `overCap` in the browser, and the grab is allowed
// to proceed only when EITHER the release is within cap OR the admin sent
// `allowOverCap:true`. Over-cap-without-override → 424.
//
// The grab still routes through the same reservation ledger + grab-event
// recorder as the automatic pipeline, so disk reservations and the audit log
// stay consistent.
// ---------------------------------------------------------------------------

export type InteractiveGrabRequest = {
  guid: string
  indexerId: number
  allowOverCap?: boolean
}

export type InteractiveGrabResult =
  | { status: 'over_cap' } // 424
  | { status: 'release_not_found' } // 404
  | { status: 'bad_request' } // 400
  | { status: 'no_space' } // 507
  | { status: 'upstream_error'; upstreamStatus: number } // 502
  | { status: 'grabbed'; title: string; sizeGb: number }

/** Parse + validate the S3/R3 request body. */
export function parseInteractiveGrab(raw: unknown):
  | { ok: true; req: InteractiveGrabRequest }
  | { ok: false } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false }
  const body = raw as Record<string, unknown>
  if (typeof body.guid !== 'string' || body.guid.length === 0) return { ok: false }
  if (typeof body.indexerId !== 'number' || !Number.isFinite(body.indexerId)) return { ok: false }
  return {
    ok: true,
    req: {
      guid: body.guid,
      indexerId: body.indexerId,
      allowOverCap: body.allowOverCap === true,
    },
  }
}

/**
 * Execute an interactive grab. Generic over the app via injected callbacks:
 *  - `itemId` / `sub`: identify the grabbed item + caller for the audit log.
 *  - `listReleases`: re-run the interactive search to locate the picked
 *    release (we identify by guid+indexerId rather than trusting the
 *    client's size, so the cap decision is made against the real upstream
 *    release record).
 *  - `capBytesFor`: the per-release byte ceiling (movies flat, TV per-ep).
 *  - `postGrab`: POST /release {guid,indexerId} upstream.
 *  - `recordEvent`: the app's grab-event recorder (createGrabEventRecorder).
 *    We reuse the EXISTING event vocabulary so the admin grab panel + the
 *    /by-item poller treat interactive grabs exactly like automatic ones.
 *  - `ledger`/`folder`: optional disk reservation around the grab POST.
 */
export async function executeInteractiveGrab(opts: {
  itemId: number
  sub: string
  req: InteractiveGrabRequest
  listReleases: () => Promise<UpstreamRelease[] | null>
  capBytesFor: (r: UpstreamRelease) => number | null
  postGrab: (guid: string, indexerId: number) => Promise<{ ok: boolean; status: number }>
  recordEvent: (event: ArrGrabEvent) => Promise<void>
  capGb: number
  ledger?: ReservationLedger
  folder?: RootFolderSpaceSnapshot
}): Promise<InteractiveGrabResult> {
  const { itemId, sub, req, listReleases, capBytesFor, postGrab, recordEvent, capGb, ledger, folder } = opts
  const base = { itemId, sub, capGb }
  const releases = await listReleases()
  if (releases === null) return { status: 'upstream_error', upstreamStatus: 502 }
  const picked = releases.find((r) => r.guid === req.guid && r.indexerId === req.indexerId)
  if (!picked) return { status: 'release_not_found' }
  const size = typeof picked.size === 'number' && Number.isFinite(picked.size) ? picked.size : 0
  const cap = capBytesFor(picked)
  const overCap = cap !== null && size > cap
  if (overCap && !req.allowOverCap) {
    // Reuse the all_rejected_by_cap event so the over-cap refusal lands in
    // the same audit stream as an automatic over-cap rejection.
    await recordEvent({
      ...base,
      title: picked.title,
      type: 'all_rejected_by_cap',
      eligible: 0,
      release: { title: picked.title, sizeBytes: size, qualityWeight: picked.qualityWeight ?? 0 },
    })
    return { status: 'over_cap' }
  }
  await recordEvent({ ...base, title: picked.title, type: 'grab_started' })
  // Reserve disk against the grab so a concurrent automatic add can't
  // double-spend the same headroom. The interactive grab is admin-driven,
  // so when the reserve refuses (the folder is already committed up to the
  // floor) we surface 507 rather than silently grabbing into the reserve.
  let reserved = false
  if (ledger && folder && size > 0) {
    reserved = ledger.reserve(folder, size)
    if (!reserved) return { status: 'no_space' }
  }
  try {
    const grab = await postGrab(req.guid, req.indexerId)
    await recordEvent({
      ...base,
      title: picked.title,
      type: grab.ok ? 'grab_succeeded' : 'grab_failed',
      status: grab.status,
      release: { title: picked.title, sizeBytes: size, qualityWeight: picked.qualityWeight ?? 0 },
    })
    if (!grab.ok) return { status: 'upstream_error', upstreamStatus: grab.status }
    return { status: 'grabbed', title: picked.title, sizeGb: round2(size / 1e9) }
  } finally {
    if (reserved && ledger && folder) ledger.release(folder, size)
  }
}

/** Map the interactive-grab result to the shared HTTP contract (S3 / R3).
 *  Used by both routes so the status codes stay identical across apps. */
export function interactiveGrabResponse(c: Context<Env>, result: InteractiveGrabResult): Response {
  switch (result.status) {
    case 'grabbed':
      return c.json({ status: 'grabbed', title: result.title, sizeGb: result.sizeGb })
    case 'over_cap':
      return c.json({ error: 'over_cap', message: 'Release exceeds the size cap; resend with allowOverCap to grab anyway.' }, 424)
    case 'release_not_found':
      return c.json({ error: 'release_not_found' }, 404)
    case 'bad_request':
      return c.json({ error: 'invalid_body' }, 400)
    case 'no_space':
      return c.json({ error: 'insufficient_disk_space' }, 507)
    case 'upstream_error':
      return c.json({ error: 'grab_failed', status: result.upstreamStatus }, 502)
  }
}
