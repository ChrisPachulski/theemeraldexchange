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
// Returns `allTagged` so callers can reflect the state in the UI if they
// want (e.g. a "judged — refreshing" hint).

// Pure: true iff the strip is non-empty AND every shown card is judged.
// The non-empty guard prevents firing on a not-yet-loaded (empty) strip.
export function computeAllTagged<T extends { id: number }>(
  items: T[],
  isTagged: (id: number) => boolean,
): boolean {
  return items.length > 0 && items.every((it) => isTagged(it.id))
}

// Pure refetch-gate predicate: fire only on the unset→all-tagged
// transition (latch via prevAllTagged) and never while a fetch is in
// flight.
export function shouldRefetchStrip(
  allTagged: boolean,
  prevAllTagged: boolean,
  isFetching: boolean,
): boolean {
  return allTagged && !prevAllTagged && !isFetching
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
  const prev = useRef(false)
  useEffect(() => {
    if (shouldRefetchStrip(allTagged, prev.current, isFetching)) {
      refetch()
    }
    prev.current = allTagged
  }, [allTagged, isFetching, refetch])
  return allTagged
}
