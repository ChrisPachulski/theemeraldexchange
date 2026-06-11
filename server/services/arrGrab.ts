// Shared reservation + grab-event machinery for the Sonarr/Radarr cap
// pipelines. radarr.ts and sonarr.ts previously each carried a private
// copy of this (~50 lines apiece) and the copies had already diverged:
// Radarr's release path guarded non-finite/non-positive byte amounts
// while Sonarr's did not, so a NaN release on the Sonarr side could
// poison the ledger (Math.max(0, reserved - NaN) === NaN) and wedge the
// free-space gate until restart. One implementation, the stricter guard
// for both apps.
//
// SCOPE: each route module owns its OWN ledger instance (one Map per
// app), matching the prior per-file Maps — Radarr and Sonarr reservations
// intentionally do not see each other (they normally target different
// root folders; cross-app accounting is the M5 shared-DB reservation's
// job). In-process, single-instance, dropped on restart — same caveat as
// before, documented on purpose.

import { appendGrabEvent } from './grabLog.js'
import { env } from '../env.js'

export type ArrApp = 'sonarr' | 'radarr'

export type RootFolderSpaceSnapshot = { path: string; freeSpace: number }

// Outcome of a cap-enforced grab attempt. Shared so both pipelines (and
// their callers' Record maps) agree on the status vocabulary.
export type CappedGrabResult =
  | { status: 'grab_succeeded' }
  | { status: 'search_failed'; upstreamStatus: number }
  | { status: 'no_releases'; scanned: number }
  // Releases existed but the *arr rejected every one (parse/title/quality),
  // so the size cap never applied. Handled like no_releases (monitor),
  // not like all_rejected_by_cap (roll back).
  | { status: 'no_matching_releases'; scanned: number }
  | { status: 'all_rejected_by_cap'; scanned: number }
  | { status: 'grab_failed'; upstreamStatus: number }

type GrabEventInput = Parameters<typeof appendGrabEvent>[0]
export type ArrGrabEvent = Omit<GrabEventInput, 'app'>

/** Best-effort grab-log append with the app injected — the grab pipelines
 *  must never fail a user-facing add because the audit log write failed. */
export function createGrabEventRecorder(app: ArrApp): (event: ArrGrabEvent) => Promise<void> {
  return (event) =>
    appendGrabEvent({ app, ...event }).catch((err) => {
      console.error(`[${app}] grab log write failed:`, err)
    })
}

export type ReservationLedger = {
  /** Folder free space minus in-flight reservations against its path. */
  availableBytes(folder: RootFolderSpaceSnapshot): number
  /** Bytes currently reserved against the folder's path. */
  pendingBytes(folder: RootFolderSpaceSnapshot): number
  /** Reserve `bytes` if doing so keeps the folder above env.minFreeBytes.
   *  Refuses non-finite / non-positive amounts. */
  reserve(folder: RootFolderSpaceSnapshot, bytes: number): boolean
  /** Release up to `bytes` of a prior reservation (floored at zero so a
   *  double-release can't go negative). Non-finite / non-positive amounts
   *  are ignored — the unified guard both apps now share. */
  release(folder: RootFolderSpaceSnapshot, bytes: number): void
}

// In-flight disk-space reservations keyed by root-folder path. Without
// this, two near-simultaneous adds both read the SAME stale
// folder.freeSpace snapshot, both clear the MIN_FREE_GB gate, and both
// grab up to the per-app cap — driving the disk below the reserve. The
// planned grab bytes are subtracted the moment a grab is committed and
// the unused remainder released afterward, so the second concurrent add
// sees the reduced figure and is refused when only one fits.
export function createReservationLedger(): ReservationLedger {
  const pending = new Map<string, number>()
  return {
    availableBytes(folder) {
      return folder.freeSpace - (pending.get(folder.path) ?? 0)
    },
    pendingBytes(folder) {
      return pending.get(folder.path) ?? 0
    },
    reserve(folder, bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return false
      const reserved = pending.get(folder.path) ?? 0
      if (folder.freeSpace - reserved - bytes < env.minFreeBytes) return false
      pending.set(folder.path, reserved + bytes)
      return true
    },
    release(folder, bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return
      const reserved = pending.get(folder.path) ?? 0
      const next = Math.max(0, reserved - bytes)
      if (next === 0) pending.delete(folder.path)
      else pending.set(folder.path, next)
    },
  }
}
