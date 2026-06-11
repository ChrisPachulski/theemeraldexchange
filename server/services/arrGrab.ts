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

// A reservation only guards the brief PLANNING + grab-POST window inside
// grab*UnderCap — it is taken when a grab is committed and released in the
// same function's `finally`, so its real lifetime is seconds to a minute.
// Any reservation older than this is, by construction, a release that never
// fired (a crashed/buggy grab path), NOT a still-running one. Expiring it
// self-heals the free-space gate instead of letting one missed release wedge
// EVERY later add to that folder until the process restarts — the exact
// failure that silently blocked all TV adds for 3 days after a
// fully-successful grab skipped its release. 15 min is ~10× the worst-case
// real hold, so a live reservation is never expired out from under a grab.
const RESERVATION_TTL_MS = 15 * 60 * 1000

// In-flight disk-space reservations keyed by root-folder path. Without
// this, two near-simultaneous adds both read the SAME stale
// folder.freeSpace snapshot, both clear the MIN_FREE_GB gate, and both
// grab up to the per-app cap — driving the disk below the reserve. The
// planned grab bytes are subtracted the moment a grab is committed and
// the unused remainder released afterward, so the second concurrent add
// sees the reduced figure and is refused when only one fits.
//
// Each reservation is timestamped and self-expires (RESERVATION_TTL_MS) so a
// missed release can never wedge the gate beyond the TTL. `app` only labels
// the stale-prune warning so a future leak is loud, not silently discovered
// days later when an add 409s.
export function createReservationLedger(app: ArrApp | 'arr' = 'arr'): ReservationLedger {
  type Entry = { bytes: number; expiresAt: number }
  const pending = new Map<string, Entry[]>()

  // Drop expired reservations on every read/write, returning the live set.
  // A pruned entry almost always means a grab skipped its release — log it
  // LOUD so the next leak surfaces in seconds, not after days of blocked adds.
  const live = (path: string): Entry[] => {
    const arr = pending.get(path)
    if (!arr) return []
    const now = Date.now()
    const kept: Entry[] = []
    let prunedBytes = 0
    for (const e of arr) {
      if (e.expiresAt > now) kept.push(e)
      else prunedBytes += e.bytes
    }
    if (prunedBytes > 0) {
      console.warn(
        `[${app}] pruned ${(prunedBytes / 1024 ** 3).toFixed(2)}GB of stale disk reservation ` +
          `on ${path} (held >${RESERVATION_TTL_MS / 60000}m) — a cap grab likely missed its ` +
          `release; self-healing the free-space gate.`,
      )
    }
    if (kept.length) pending.set(path, kept)
    else pending.delete(path)
    return kept
  }

  const sum = (path: string): number => live(path).reduce((s, e) => s + e.bytes, 0)

  return {
    availableBytes(folder) {
      return folder.freeSpace - sum(folder.path)
    },
    pendingBytes(folder) {
      return sum(folder.path)
    },
    reserve(folder, bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return false
      const reserved = sum(folder.path)
      if (folder.freeSpace - reserved - bytes < env.minFreeBytes) return false
      const arr = pending.get(folder.path) ?? []
      arr.push({ bytes, expiresAt: Date.now() + RESERVATION_TTL_MS })
      pending.set(folder.path, arr)
      return true
    },
    release(folder, bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return
      const arr = live(folder.path)
      // Callers release exactly what they reserved — remove the first entry
      // with that amount. Fall back to trimming oldest entries until `bytes`
      // is consumed, preserving the "release up to bytes, floored at zero"
      // contract even if amounts don't line up after a partial grab.
      const exact = arr.findIndex((e) => e.bytes === bytes)
      if (exact >= 0) {
        arr.splice(exact, 1)
      } else {
        let remaining = bytes
        while (remaining > 0 && arr.length > 0) {
          const head = arr[0]
          if (head.bytes <= remaining) {
            remaining -= head.bytes
            arr.shift()
          } else {
            head.bytes -= remaining
            remaining = 0
          }
        }
      }
      if (arr.length) pending.set(folder.path, arr)
      else pending.delete(folder.path)
    },
  }
}
