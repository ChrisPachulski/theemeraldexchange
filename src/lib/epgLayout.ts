// Pure geometry for the EPG guide grid — a port of the Apple app's EmeraldKit
// `EpgLayout`. Kept UI-free so the overlap-prevention and windowing math can be
// unit-tested without React.

/**
 * Width (in px) of one programme block on the guide's time axis.
 *
 * - `left`  — the block's start projected onto the axis.
 * - `right` — the block's stop projected onto the axis.
 * - `nextLeft` — the next programme's start on the axis, or the track width if
 *   this is the last block.
 * - `minWidth` — minimum readable/tappable width.
 *
 * A short block is padded up to `minWidth` so it stays readable, but the result
 * is never wider than the gap to `nextLeft` — so the padding (or a provider's
 * overlapping stop time) can't draw on top of the next block. Programmes are
 * assumed sorted by start, so `nextLeft >= left`.
 */
export function blockWidth(left: number, right: number, nextLeft: number, minWidth: number): number {
  const available = Math.max(0, nextLeft - left)
  const desired = Math.max(right - left, minWidth)
  return Math.min(desired, available)
}

/**
 * The contiguous range of channel rows to render so a huge EPG doesn't build
 * every row eagerly. Returns `[start, end)`.
 *
 * - `scrollBucket` — index of the top row at the current scroll offset.
 * - `viewportRows` — how many rows fit in the viewport (forced ≥ 1).
 * - `count` — total channel rows.
 * - `overscan` — extra rows rendered above and below the viewport.
 *
 * Always within `0..count`, and non-empty when `count > 0` — even if a stale
 * `scrollBucket` points past the end after a filter shrank the list (the bug
 * that left the guide blank until you scrolled).
 */
export function visibleRowRange(
  scrollBucket: number,
  viewportRows: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  if (count <= 0) return { start: 0, end: 0 }
  const start = Math.min(Math.max(0, scrollBucket - overscan), count - 1)
  const end = Math.min(count, Math.max(start + 1, scrollBucket + Math.max(1, viewportRows) + overscan))
  return { start, end }
}
