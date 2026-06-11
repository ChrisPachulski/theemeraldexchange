// Shared add-pipeline machinery for the Sonarr/Radarr routes (round 2 of
// the twin dedup — round 1 unified the reservation ledger + grab-event
// recorder in arrGrab.ts). This module owns the pieces that were
// byte-identical (or trivially parallel) in routes/sonarr.ts and
// routes/radarr.ts:
//
//   - the Release shape returned by /api/v3/release (declared 3× before)
//   - pickProfile (quality-profile preference chain)
//   - non-admin body materialization (allowlist + server-derived policy)
//   - the root-folder free-space gate
//
// App-specific policy (which fields the materialized body carries, how an
// unreachable upstream is reported) stays in the route files, injected as
// small callbacks, so behavior is preserved exactly per app.

import { env } from '../env.js'
import { createLogger } from './logger.js'
import type { ReservationLedger, RootFolderSpaceSnapshot } from './arrGrab.js'

const log = createLogger('arr-add')

/** A release row from Sonarr/Radarr's /api/v3/release. The TV-only fields
 *  (seasonNumber / episodeNumbers / fullSeason) are simply absent on movie
 *  releases. One declaration — the routes previously carried three copies
 *  that had to be kept in sync by hand. */
export type Release = {
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

export function normalizePath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

export type QualityProfile = { id: number; name?: string }

/**
 * Pick a quality profile by preference order:
 *   1. exact name match against `defaultName` (e.g. "choose me")
 *   2. a profile whose name contains "1080p" (the typical curated default)
 *   3. a profile whose name starts with "HD"
 *   4. any profile other than "Any" (Any is uncapped — last-resort)
 *   5. profiles[0] if literally only "Any" exists
 *
 * Returns undefined only if the profiles list is empty.
 *
 * The operator can pin a specific profile by setting DEFAULT_PROFILE_NAME
 * to a name that exists upstream. Otherwise the fallback chain prefers a
 * size-capped HD profile over the uncapped "Any" default, which keeps RSS
 * auto-grabs sane without requiring a curated "Choose Me" profile. The
 * same chain serves both apps: for TV it matters even more than for
 * movies, because Sonarr's ongoing RSS sweep is gated by the profile, not
 * by the per-episode size cap.
 */
export function pickProfile(
  profiles: QualityProfile[],
  defaultName: string,
): QualityProfile | undefined {
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

export type NonAdminMaterializeResult<T> =
  | { ok: true; body: T }
  | {
      ok: false
      reason: string
      expected_name?: string
      available_names?: string[]
      expected_path?: string
      available_paths?: string[]
    }

/**
 * Materialize a non-admin add body: keep only the identifying-metadata
 * allowlist from the raw client body, then fill policy fields (root
 * folder, quality profile, monitor mode, …) from server-derived defaults
 * via `applyPolicy`. A direct-POST can therefore never pin the household
 * to a more permissive profile/folder than the curated one.
 */
export async function materializeNonAdminAddBody<T extends Record<string, unknown>>(opts: {
  app: 'sonarr' | 'radarr'
  raw: T
  allowKeys: ReadonlyArray<string>
  /** Throws when the upstream rootfolder endpoint is unreachable. */
  loadFolders: () => Promise<Array<{ path: string }>>
  /** Raw fetch of /api/v3/qualityprofile (non-ok → unreachable). */
  fetchProfiles: () => Promise<Response>
  /** Operator-configured default root folder path (env), if any. */
  configuredFolderPath: string | null | undefined
  /** Stamp app-specific policy fields onto the safe body. */
  applyPolicy: (safe: T, picked: { folderPath: string; profileId: number }) => void
}): Promise<NonAdminMaterializeResult<T>> {
  const [folderResult, profileRes] = await Promise.all([
    opts
      .loadFolders()
      .then((folders) => ({ ok: true as const, folders }))
      .catch((err) => {
        log.error(`${opts.app} rootfolder lookup failed`, { error: err })
        return { ok: false as const }
      }),
    opts.fetchProfiles(),
  ])
  if (!folderResult.ok) {
    return { ok: false, reason: 'rootfolder_unreachable' }
  }
  if (!profileRes.ok) {
    return { ok: false, reason: 'qualityprofile_unreachable' }
  }
  const profiles = (await profileRes.json()) as QualityProfile[]
  const folders = folderResult.folders
  const configuredFolder = opts.configuredFolderPath
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
  const safe = {} as T
  for (const key of opts.allowKeys) {
    if (opts.raw[key] !== undefined) safe[key as keyof T] = opts.raw[key] as T[keyof T]
  }
  opts.applyPolicy(safe, { folderPath: folder.path, profileId: profile.id })
  return { ok: true, body: safe }
}

/** Assemble the 503 payload for a failed materialization — identical in
 *  both routes before extraction. */
export function materializeFailurePayload(m: {
  reason: string
  expected_name?: string
  available_names?: string[]
  expected_path?: string
  available_paths?: string[]
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { error: m.reason }
  if (m.expected_name) payload.expected_name = m.expected_name
  if (m.available_names) payload.available_names = m.available_names
  if (m.expected_path) payload.expected_path = m.expected_path
  if (m.available_paths) payload.available_paths = m.available_paths
  return payload
}

export type SpaceGateFailure = { status: 400 | 507; body: Record<string, unknown> }

/**
 * Hard disk-space gate against an already-loaded rootfolder list. Fails
 * closed on every "we couldn't actually measure free space" case: a
 * missing path, an unknown path, or an upstream response without a
 * numeric freeSpace all reject rather than silently bypassing the cap.
 * Availability is computed MINUS in-flight reservations so a second
 * concurrent add can't clear the gate against the same stale snapshot
 * the first add is already spending.
 */
export function gateRootFolderSpace(opts: {
  rootFolderPath: string | undefined
  folders: ReadonlyArray<{ path: string; freeSpace?: unknown }>
  ledger: ReservationLedger
}): { ok: true; folder: RootFolderSpaceSnapshot; availableBytes: number } | { ok: false; failure: SpaceGateFailure } {
  if (!opts.rootFolderPath) {
    return { ok: false, failure: { status: 400, body: { error: 'rootFolderPath_required' } } }
  }
  const folder = opts.folders.find((f) => f.path === opts.rootFolderPath)
  if (!folder) {
    return {
      ok: false,
      failure: { status: 400, body: { error: 'unknown_root_folder', path: opts.rootFolderPath } },
    }
  }
  if (typeof folder.freeSpace !== 'number' || !Number.isFinite(folder.freeSpace)) {
    return {
      ok: false,
      failure: { status: 507, body: { error: 'free_space_unknown', path: folder.path } },
    }
  }
  const snapshot: RootFolderSpaceSnapshot = { path: folder.path, freeSpace: folder.freeSpace }
  const availableBytes = opts.ledger.availableBytes(snapshot)
  if (availableBytes < env.minFreeBytes) {
    return {
      ok: false,
      failure: {
        status: 507,
        body: {
          error: 'insufficient_disk_space',
          free_bytes: availableBytes,
          threshold_bytes: env.minFreeBytes,
          path: snapshot.path,
        },
      },
    }
  }
  return { ok: true, folder: snapshot, availableBytes }
}
