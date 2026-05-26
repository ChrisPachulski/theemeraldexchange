/**
 * In-process stream-token replay cache (§5.5 of the M1.5 contract).
 *
 * Per-kind reuse semantics:
 *
 *   segment  — strict single-use. Written to the cache on first presentation;
 *              subsequent presentations of the same jti are rejected with
 *              { error: 'token_replay' }.
 *
 *   live / vod / series / catchup / remux — multi-use within token TTL.
 *              Written to the cache on first presentation; re-presentations
 *              are allowed while exp > now(). Rejected only if presented
 *              after exp (expiry is already enforced by verifyStreamToken, but
 *              the cache provides a secondary check for jti entries whose exp
 *              has passed).
 *
 *   playlist — excluded from this cache entirely. Playlist token revocation
 *              is persistent and handled by the iptv_playlist_tokens table
 *              (D12 / §6.2).
 *
 * Implementation: plain in-process Map<jti, { exp, singleUse, seen }>.
 * Zero false positives; no bloom filter.
 *
 * GC: a setInterval sweep runs every 60 seconds and drops entries whose
 * exp is in the past. On process restart the cache is empty; this is
 * accepted for short-TTL segment tokens (60s).
 *
 * Map ceiling: ~10,000 entries at sustained peak for a single-household
 * server (generous estimate per contract §5.5).
 */

import type { StreamKind } from './iptvStreamToken.js'

/** Kinds tracked by this cache. 'playlist' is deliberately excluded. */
type TrackedKind = Exclude<StreamKind, 'playlist'>

/** Return value from checkReplay — describes whether the presentation is allowed. */
export type ReplayCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'token_replay' | 'token_expired' }

interface CacheEntry {
  /** Unix-second expiry copied from the token's exp claim. */
  exp: number
  /** True for 'segment' tokens (strict single-use). */
  singleUse: boolean
  /** True once the jti has been recorded on first presentation. */
  seen: boolean
}

const cache = new Map<string, CacheEntry>()

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
    for (const [jti, entry] of cache) {
      if (entry.exp < now) cache.delete(jti)
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
  const singleUse = kind === 'segment'

  const existing = cache.get(jti)

  if (existing === undefined) {
    // First presentation — record it.
    cache.set(jti, { exp, singleUse, seen: true })
    return { allowed: true }
  }

  // Entry already exists.
  if (singleUse) {
    // segment: strict single-use regardless of exp.
    return { allowed: false, reason: 'token_replay' }
  }

  // Multi-use kinds: allow until exp.
  if (now > existing.exp) {
    // exp already passed — reject. (verifyStreamToken catches this first in
    // normal flow, but a cached entry whose exp has slipped past now is also
    // authoritative grounds for rejection.)
    return { allowed: false, reason: 'token_expired' }
  }

  return { allowed: true }
}

// Start the GC sweep immediately on module load.
startGcSweep()
