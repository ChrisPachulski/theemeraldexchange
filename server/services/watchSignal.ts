// Pure watch-threshold logic for the implicit-feedback loop.
//
// A title becomes a positive "watched" signal once the household has played
// >=40% of it (or marked it completed). 40% of a feature is a real ~40-minute
// commitment — strong enough to treat as taste signal, low enough to catch
// "watched most of it then stopped". Tuned low deliberately because the in-app
// watch stream is thin.
//
// Kept pure (no DB/network) so the threshold + transition rules are unit-tested
// directly; the route layer is thin glue that resolves tmdb_id and forwards the
// signal to the recommender.

export const WATCH_QUALIFY_FRACTION = 0.4

export interface WatchPoint {
  position_secs: number
  duration_secs: number | null
  completed: number
}

/** True iff this watch point clears the positive-signal threshold. */
export function watchQualified(p: WatchPoint): boolean {
  if (p.completed === 1) return true
  if (p.duration_secs != null && p.duration_secs > 0) {
    return p.position_secs / p.duration_secs >= WATCH_QUALIFY_FRACTION
  }
  return false
}

/**
 * True iff this report is the FIRST to cross into "qualified" — i.e. the signal
 * should fire exactly once on the transition, not on every progress tick. A
 * missing prior row counts as not-qualified, so the first qualifying report
 * fires. (A re-watch that resets the row to 0 will re-cross and re-fire, which
 * is harmless: the recommender upserts the signal idempotently.)
 */
export function crossedWatchThreshold(prior: WatchPoint | undefined, now: WatchPoint): boolean {
  if (!watchQualified(now)) return false
  if (prior && watchQualified(prior)) return false
  return true
}
