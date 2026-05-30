// Per-session token-bucket rate limiting for the mutating/search surfaces of
// the *arr / SAB proxies (finding 4-0).
//
// Without this, an authenticated member (or a leaked session) can loop movie/
// series adds and upgrade/search POSTs, each of which triggers a real upstream
// indexer release search and disk I/O — a genuine DoS / indexer-budget-burn
// vector at multi-user scale. We apply a tight bucket to the expensive
// release-search-bearing routes and a looser one to cheap reads.
//
// SCOPE: this is an IN-PROCESS Map keyed by session sub, sufficient for the
// single-instance NAS target and consistent with the other in-memory state in
// this codebase (concurrency tracker, remux registry). It does NOT survive a
// restart and is NOT shared across replicas; when the §5.3 / M5 multi-replica
// work lands, move this to the same shared store (IPTV DB / Redis) as the
// concurrency tracker. Documented single-instance on purpose.

import { createMiddleware } from 'hono/factory'
import type { Env } from './auth.js'

interface Bucket {
  tokens: number
  lastRefill: number
}

export interface RateLimitOptions {
  /** Max burst (bucket capacity). */
  capacity: number
  /** Tokens added back per `intervalMs`. */
  refill: number
  /** Refill interval in milliseconds. */
  intervalMs: number
  /** Stable name used to namespace buckets so two limiters don't collide. */
  name: string
}

// One Map per limiter name keeps independent buckets (e.g. the tight "mutate"
// bucket and the loose "read" bucket don't share tokens).
const registries = new Map<string, Map<string, Bucket>>()

function registryFor(name: string): Map<string, Bucket> {
  let reg = registries.get(name)
  if (!reg) {
    reg = new Map<string, Bucket>()
    registries.set(name, reg)
  }
  return reg
}

/** Best-effort caller key: session sub when present, else client IP. */
function callerKey(headerSub: string | undefined, ip: string | null): string {
  if (headerSub) return `sub:${headerSub}`
  if (ip) return `ip:${ip}`
  return 'anon'
}

/**
 * Token-bucket middleware. Returns 429 with a `retry_after_ms` hint when the
 * caller's bucket is empty. Keyed by session sub (falls back to client IP for
 * unauthenticated callers, though these routes are auth-gated upstream).
 */
export function rateLimit(opts: RateLimitOptions): ReturnType<typeof createMiddleware<Env>> {
  return createMiddleware<Env>(async (c, next) => {
    // Resolve the bucket registry by name ON EACH REQUEST rather than capturing
    // it at construction. Capturing here would let the limiter keep using a
    // stale inner Map after __resetRateLimitsForTests() cleared the outer
    // `registries` map (a test would then start with a pre-drained bucket).
    const reg = registryFor(opts.name)
    const session = c.get('session')
    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      null
    const key = callerKey(session?.sub, ip)

    const now = Date.now()
    let bucket = reg.get(key)
    if (!bucket) {
      bucket = { tokens: opts.capacity, lastRefill: now }
      reg.set(key, bucket)
    }

    // Lazy refill proportional to elapsed time.
    const elapsed = now - bucket.lastRefill
    if (elapsed >= opts.intervalMs) {
      const refills = Math.floor(elapsed / opts.intervalMs)
      bucket.tokens = Math.min(opts.capacity, bucket.tokens + refills * opts.refill)
      bucket.lastRefill = now
    }

    if (bucket.tokens < 1) {
      const retryAfterMs = opts.intervalMs - (now - bucket.lastRefill)
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)))
      return c.json(
        { error: 'rate_limited', retry_after_ms: Math.max(0, retryAfterMs) },
        429,
      )
    }

    bucket.tokens -= 1
    await next()
    return
  }) as ReturnType<typeof createMiddleware<Env>>
}

/** TEST-ONLY: clear all buckets so limits don't leak across test cases. */
export function __resetRateLimitsForTests(): void {
  registries.clear()
}
