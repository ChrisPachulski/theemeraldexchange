import { useEffect, useMemo, useRef } from 'react'

// Auto-re-runs the recommender when every currently-shown suggestion
// card has been given a yes/no (like/dislike) signal — the "I've judged
// the whole strip, give me a fresh batch" flow.
//
// Loop-safety: the refetch fires only on the unset→all-tagged transition
// (latched via `prev`), and never while a fetch is already in flight.
// The refreshed strip arrives all-unset, which resets the latch — so a
// single all-tagged round produces exactly one extra run, not a cycle.
//
// Long-strip gate: the refetch REPLACES the strip, so it must only fire
// when the user actually triaged a substantial batch. On a short strip a
// single like tags the last remaining card → allTagged flips → the strip
// refetches out from under the user mid-triage (the reported "accept one
// and the whole thing refreshes, can't take more" bug). Gating the trigger
// on a minimum strip length means short strips never auto-refresh; the
// manual refresh button in the strip header covers that case.
//
// Returns `allTagged` so callers can reflect the state in the UI if they
// want (e.g. a "judged — refreshing" hint). The return keeps its literal
// "every card judged" meaning; only the auto-refetch trigger is gated.

// Minimum number of cards a strip must have had for an all-judged round to
// auto-pull a fresh batch. Below this the user refreshes manually.
export const MIN_STRIP_FOR_AUTOREFRESH = 8

// Pure: true iff the strip is non-empty AND every shown card is judged.
// The non-empty guard prevents firing on a not-yet-loaded (empty) strip.
export function computeAllTagged<T extends { id: number }>(
  items: T[],
  isTagged: (id: number) => boolean,
): boolean {
  return items.length > 0 && items.every((it) => isTagged(it.id))
}

// Pure: true iff the strip is long enough to justify auto-refreshing once
// fully judged. Short strips are excluded so a single accept can't replace
// the lineup out from under the user.
export function stripLongEnough(itemCount: number): boolean {
  return itemCount >= MIN_STRIP_FOR_AUTOREFRESH
}

// Pure refetch-gate predicate: fire only on the unset→all-tagged
// transition (latch via prevAllTagged), only when the strip was long
// enough, and never while a fetch is in flight.
export function shouldRefetchStrip(
  allTagged: boolean,
  prevAllTagged: boolean,
  isFetching: boolean,
  longEnough: boolean,
): boolean {
  return allTagged && longEnough && !prevAllTagged && !isFetching
}

export function useStripAutoRefresh<T extends { id: number }>(
  items: T[],
  isTagged: (id: number) => boolean,
  isFetching: boolean,
  refetch: () => void,
): boolean {
  const allTagged = useMemo(
    () => computeAllTagged(items, isTagged),
    // isTagged closes over the latest feedback state and is recreated
    // each render; items + isTagged together cover every input.
    [items, isTagged],
  )
  const longEnough = stripLongEnough(items.length)
  const prev = useRef(false)
  useEffect(() => {
    if (shouldRefetchStrip(allTagged, prev.current, isFetching, longEnough)) {
      refetch()
    }
    prev.current = allTagged
  }, [allTagged, isFetching, longEnough, refetch])
  return allTagged
}
