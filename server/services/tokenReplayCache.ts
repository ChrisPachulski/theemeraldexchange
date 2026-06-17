/**
 * In-process stream-token reuse cache (§5.5 of the M1.5 contract).
 *
 * Per-kind reuse semantics:
 *
 *   segment / live / vod / series / catchup / remux — multi-use within token
 *              TTL. Written to the cache on first presentation; re-presentations
 *              are allowed while exp > now(). Rejected only if presented after
 *              exp (expiry is already enforced by verifyStreamToken, but the
 *              cache provides a secondary check for jti entries whose exp has
 *              slipped past now).
 *
 *              NOTE (MED-17, 2026-06-17): 'segment' was previously STRICT
 *              single-use. That is incompatible with HLS — players legitimately
 *              re-fetch a segment on seek-back, buffer recovery, and bitrate
 *              switch-back, every one of which presented the same jti and got a
 *              401. A segment token is bound to ONE specific segment URL
 *              (resourceId) and lives only IPTV_STREAM_TOKEN_TTL_SECS (300s), so
 *              re-presentation re-fetches the same ~6s segment for at most 5
 *              minutes — negligible abuse surface, identical to the model the
 *              other kinds already use. So segment now follows the same
 *              multi-use-within-TTL rule as everything else.
 *
 *   playlist — excluded from this cache entirely. Playlist token revocation
 *              is persistent and handled by the iptv_playlist_tokens table
 *              (D12 / §6.2).
 *
 * Implementation: plain in-process Map<jti, exp>. Zero false positives; no
 * bloom filter.
 *
 * GC: a setInterval sweep runs every 60 seconds and drops entries whose exp is
 * in the past. On process restart the cache is empty; this is accepted for the
 * short-TTL stream tokens.
 *
 * Map ceiling: ~10,000 entries at sustained peak for a single-household server
 * (generous estimate per contract §5.5).
 */

import type { StreamKind } from './iptvStreamToken.js'

/** Kinds tracked by this cache. 'playlist' is deliberately excluded. */
type TrackedKind = Exclude<StreamKind, 'playlist'>

/** Return value from checkReplay — describes whether the presentation is allowed. */
export type ReplayCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'token_expired' }

/** jti → exp (Unix seconds). Presence means "seen at least once". */
const cache = new Map<string, number>()

/** GC sweep interval handle — exported so callers can clear it in tests. */
let gcHandle: ReturnType<typeof setInterval> | null = null

/**
 * Start the GC sweep. Called automatically on module load. Safe to call
 * multiple times; subsequent calls are no-ops if the sweep is already running.
 */
export function startGcSweep(intervalMs = 60_000): void {
  if (gcHandle !== null) return
  gcHandle = setInterval(() => {
    const now = Math.floor(Date.now() / 1000)
    for (const [jti, exp] of cache) {
      if (exp < now) cache.delete(jti)
    }
  }, intervalMs)
  // Allow the process to exit even if the sweep is still scheduled.
  if (typeof gcHandle === 'object' && gcHandle !== null && 'unref' in gcHandle) {
    ;(gcHandle as { unref(): void }).unref()
  }
}

/**
 * Stop the GC sweep (useful in tests to avoid leaking open handles).
 */
export function stopGcSweep(): void {
  if (gcHandle !== null) {
    clearInterval(gcHandle)
    gcHandle = null
  }
}

/**
 * Evict all entries from the cache. For use in tests only.
 */
export function clearReplayCache(): void {
  cache.clear()
}

/**
 * Check whether a token presentation is allowed, and record it if so.
 *
 * @param jti  - The token's jti claim.
 * @param exp  - The token's exp claim (Unix seconds).
 * @param kind - The token's kind claim.
 * @returns    ReplayCheckResult
 */
export function checkReplay(jti: string, exp: number, kind: TrackedKind): ReplayCheckResult {
  // 'playlist' callers are a contract violation — guard defensively.
  if ((kind as StreamKind) === 'playlist') {
    return { allowed: true }
  }

  const now = Math.floor(Date.now() / 1000)
  const existingExp = cache.get(jti)

  if (existingExp === undefined) {
    // First presentation — record it.
    cache.set(jti, exp)
    return { allowed: true }
  }

  // Already seen: allow re-presentation until exp. (verifyStreamToken catches
  // expiry first in normal flow, but a cached entry whose exp has slipped past
  // now is also authoritative grounds for rejection.)
  if (now > existingExp) {
    return { allowed: false, reason: 'token_expired' }
  }

  return { allowed: true }
}

// Start the GC sweep immediately on module load.
startGcSweep()
