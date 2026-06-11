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

export const DATED_COMPAT_WINDOWS: ReadonlyArray<CompatWindow> = [
  {
    // D17 shipped 2026-05-26; session cookies live 30 days, so every
    // active cookie carries an explicit auth_mode after 2026-06-25.
    id: 'session-auth-mode-default',
    expiresAt: '2026-06-25T00:00:00Z',
    location: 'server/session.ts (tryDecrypt)',
    remediation:
      "Remove the auth_mode 'plex' fallback for cookies without the field; " +
      'treat a missing/invalid auth_mode as an invalid session.',
  },
  {
    // §8.2 D: M1 cookies carry bare numeric Plex ids. D7 (namespaced
    // subs) shipped 2026-05-26; one 30-day cookie TTL later every live
    // cookie was minted with a namespaced sub. NOTE the in-code gate
    // (sub.ts isGraceWindowOpen) bakes its start time at PROCESS START,
    // so it re-arms on every boot and would never close by itself —
    // this registry entry carries the real calendar expiry.
    id: 'legacy-bare-plex-sub-normalisation',
    expiresAt: '2026-06-25T00:00:00Z',
    location: 'server/session.ts (tryDecrypt) → server/services/sub.ts (tryNormaliseLegacySub)',
    remediation:
      'Replace the tryNormaliseLegacySub call in tryDecrypt with a strict parseSub ' +
      '(reject bare subs), then delete tryNormaliseLegacySub/isGraceWindowOpen and ' +
      'migrate tests that still mint sessions with bare numeric subs.',
  },
]

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
