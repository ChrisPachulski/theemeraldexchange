import { describe, it, expect } from 'vitest'
import {
  computeAllTagged,
  shouldRefetchStrip,
  stripLongEnough,
  MIN_STRIP_FOR_AUTOREFRESH,
} from './useStripAutoRefresh'

// vitest runs in the `node` environment (no jsdom, no @testing-library,
// no react-test-renderer). We therefore can't render useStripAutoRefresh
// or exercise its useEffect refetch wiring. Instead we pin the extracted
// PURE decision functions the effect delegates to: computeAllTagged (the
// "is the whole strip judged?" predicate), stripLongEnough (the
// minimum-length gate) and shouldRefetchStrip (the latch + in-flight +
// long-enough refetch gate). If these are correct, the hook is correct by
// construction; the only untested part is the (un-renderable) React effect
// wiring.

describe('computeAllTagged', () => {
  it('returns false for an empty items array (must NOT auto-refresh a not-yet-loaded strip)', () => {
    expect(computeAllTagged([], () => true)).toBe(false)
  })

  it('returns true when every item is tagged', () => {
    expect(computeAllTagged([{ id: 1 }, { id: 2 }], () => true)).toBe(true)
  })

  it('returns false when one item is untagged', () => {
    expect(
      computeAllTagged([{ id: 1 }, { id: 2 }, { id: 3 }], (id) => id !== 2),
    ).toBe(false)
  })

  it('returns true for a single tagged item', () => {
    expect(computeAllTagged([{ id: 7 }], (id) => id === 7)).toBe(true)
  })

  it('consults isTagged per-id rather than as a blanket', () => {
    const items = [{ id: 1 }, { id: 2 }]
    // id 2 is not tagged → false
    expect(computeAllTagged(items, (id) => id === 1)).toBe(false)
    // now every id is tagged → true (proves it reads every id)
    expect(computeAllTagged(items, () => true)).toBe(true)
  })
})

describe('stripLongEnough', () => {
  it('returns false below the minimum (short strips never auto-refresh)', () => {
    expect(stripLongEnough(0)).toBe(false)
    expect(stripLongEnough(1)).toBe(false)
    expect(stripLongEnough(MIN_STRIP_FOR_AUTOREFRESH - 1)).toBe(false)
  })

  it('returns true at and above the minimum', () => {
    expect(stripLongEnough(MIN_STRIP_FOR_AUTOREFRESH)).toBe(true)
    expect(stripLongEnough(MIN_STRIP_FOR_AUTOREFRESH + 5)).toBe(true)
  })

  it('the minimum is a sane positive threshold (regression guard on the constant)', () => {
    expect(MIN_STRIP_FOR_AUTOREFRESH).toBeGreaterThan(1)
  })
})

describe('shouldRefetchStrip', () => {
  it('fires on the unset→all-tagged transition when the strip was long enough', () => {
    expect(shouldRefetchStrip(true, false, false, true)).toBe(true)
  })

  it('does NOT fire on a short strip even when fully judged (the accept-one-refreshes bug)', () => {
    // The core regression: a short strip that gets fully tagged must NOT
    // auto-refetch, or a single accept replaces the lineup mid-triage.
    expect(shouldRefetchStrip(true, false, false, false)).toBe(false)
  })

  it('does NOT fire when already all-tagged last render (anti-infinite-loop latch)', () => {
    // The latch: once we have fired for this all-tagged round, prevAllTagged
    // is true and we must not fire again — this is what prevents the refetch
    // loop.
    expect(shouldRefetchStrip(true, true, false, true)).toBe(false)
  })

  it('does NOT fire while a fetch is in flight (in-flight gate)', () => {
    // Never kick off another recommender run while one is already running.
    expect(shouldRefetchStrip(true, false, true, true)).toBe(false)
  })

  it('does NOT fire when both latched AND fetching', () => {
    expect(shouldRefetchStrip(true, true, true, true)).toBe(false)
  })

  it('never fires when not all tagged, regardless of prev/fetching/length', () => {
    expect(shouldRefetchStrip(false, false, false, true)).toBe(false)
    expect(shouldRefetchStrip(false, true, false, true)).toBe(false)
    expect(shouldRefetchStrip(false, false, false, false)).toBe(false)
  })

  it('yields exactly one true per all-tagged round on a long strip (exactly-once property)', () => {
    // A single all-tagged round is the false→true transition, which yields
    // exactly one `true`. The refreshed strip arrives all-unset, resetting
    // allTagged to false and re-arming the latch for the next round.
    expect(shouldRefetchStrip(true, false, false, true)).toBe(true) // round fires once
    expect(shouldRefetchStrip(true, true, false, true)).toBe(false) // latched after
    expect(shouldRefetchStrip(false, true, false, true)).toBe(false) // refreshed (unset) → re-arm
    expect(shouldRefetchStrip(true, false, false, true)).toBe(true) // next round fires once
  })
})
