// Dated backward-compat windows, made observable.
//
// The codebase carries a few deliberately temporary compat shims, each
// with a calendar expiry buried in a comment ("drop this after
// <date>"). Those relied on someone manually sweeping the code on the
// right day — which never happens (the stream-token grace windows from
// M1 were only removed in a review wave, weeks after their dates).
//
// This registry is the single inventory of every remaining dated
// window. warnExpiredCompatWindows() runs at boot (index.ts) and logs a
// WARN for any window past its date, so expiry shows up in `docker
// logs` instead of depending on a calendar sweep. When you remove a
// shim, delete its entry here; when you add one, register it here with
// a concrete expiry — never a bare TODO comment.

import { createLogger } from './logger.js'

const log = createLogger('compat')

export type CompatWindow = {
  /** Stable identifier, greppable from the boot warning. */
  id: string
  /** ISO instant after which the shim should be removed. */
  expiresAt: string
  /** Where the shim lives. */
  location: string
  /** What to do when the window expires. */
  remediation: string
}

// No active dated compat windows. (The session auth_mode default and the
// legacy bare-Plex-sub normalisation were removed ahead of their 2026-06-25
// expiry: auth_mode is now backfilled at mint time and tryDecrypt parses subs
// strictly.) When you add a temporary shim with a calendar expiry, register it
// here so warnExpiredCompatWindows() boot-warns once it lapses.
export const DATED_COMPAT_WINDOWS: ReadonlyArray<CompatWindow> = []

/**
 * Log a WARN for every dated compat window past its expiry and return the
 * expired entries (callers/tests can assert on the list). Safe to call on
 * every boot — windows still inside their date are silent.
 */
export function warnExpiredCompatWindows(
  now: Date = new Date(),
  windows: ReadonlyArray<CompatWindow> = DATED_COMPAT_WINDOWS,
): CompatWindow[] {
  const expired = windows.filter((w) => now.getTime() >= Date.parse(w.expiresAt))
  for (const w of expired) {
    log.warn('dated compat window past expiry — remove the shim', {
      id: w.id,
      expiredAt: w.expiresAt,
      location: w.location,
      remediation: w.remediation,
    })
  }
  return expired
}
