import { describe, expect, it } from 'vitest'
import { blockWidth, visibleRowRange } from './epgLayout'

// Ported from the Apple app's EpgLayoutTests — locks the EPG block-layout
// invariant: short programmes get a minimum-width box, but no block ever
// overlaps its neighbour.
describe('blockWidth', () => {
  // iOS/web scale: 6 px/min, so a 15-minute minimum box is 90px.
  const minW = 90

  it('pads a short block up to the minimum when there is room', () => {
    // 3-min block (18px) with the next programme far off → padded to 15 min.
    expect(blockWidth(0, 18, 1000, minW)).toBe(90)
  })

  it('tiles back-to-back short blocks without overlap', () => {
    // 3-min block immediately followed by the next at 18px → no padding past it.
    expect(blockWidth(0, 18, 18, minW)).toBe(18)
  })

  it('keeps a normal block at its natural width', () => {
    expect(blockWidth(0, 360, 360, minW)).toBe(360)
  })

  it('clamps a provider overlap to the next start', () => {
    // Bad data: stop (400) runs past the next programme's start (300).
    expect(blockWidth(0, 400, 300, minW)).toBe(300)
  })

  it('yields zero width for a zero gap', () => {
    expect(blockWidth(100, 118, 100, minW)).toBe(0)
  })
})

// Ported from the Apple app's EpgRowWindowTests — locks the row-windowing
// invariants: always in bounds, non-empty for a non-empty list, viewport + over-
// scan on both sides, and clamped when a stale bucket points past a shrunk list.
describe('visibleRowRange', () => {
  it('yields an empty range for an empty list', () => {
    expect(visibleRowRange(0, 20, 0, 8)).toEqual({ start: 0, end: 0 })
  })

  it('renders a small list fully', () => {
    expect(visibleRowRange(0, 20, 10, 8)).toEqual({ start: 0, end: 10 })
  })

  it('windows the viewport plus overscan when scrolled into the middle', () => {
    // Top row 50, 10 fit, 200 total, ±8 overscan → [42, 68).
    expect(visibleRowRange(50, 10, 200, 8)).toEqual({ start: 42, end: 68 })
  })

  it('stays in bounds and non-empty when a stale bucket points past the end', () => {
    // A filter shrank the list to 20 but the offset still reads 500.
    const r = visibleRowRange(500, 10, 20, 8)
    expect(r.start).toBeGreaterThanOrEqual(0)
    expect(r.end).toBeLessThanOrEqual(20)
    expect(r.end).toBeGreaterThan(r.start)
  })

  it('stays bounded on the first frame of a huge EPG', () => {
    // A thousands-channel EPG must window to a handful of rows, not the full set.
    const r = visibleRowRange(0, 15, 3000, 8)
    expect(r).toEqual({ start: 0, end: 23 })
    expect(r.end - r.start).toBeLessThan(50)
  })
})
