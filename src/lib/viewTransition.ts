// Same-document View Transitions wrapper (spec P0.3).
//
// `withViewTransition(cb)` runs the state mutation `cb` inside a native
// `document.startViewTransition()` so the browser cross-fades the old and
// new DOM snapshots (see src/styles/transitions.css). It is a strict
// progressive enhancement:
//
//   - If the API is unavailable (older iOS / Safari < 18, any browser
//     without same-document View Transitions) we just call `cb()`. The
//     swap hard-cuts exactly as it did before — graceful no-op.
//   - The View Transitions API does NOT respect `prefers-reduced-motion`
//     on its own, so under `reduce` we deliberately skip the call and run
//     `cb()` directly. The matching `::view-transition-*` animations in
//     transitions.css are also gated behind `prefers-reduced-motion:
//     no-preference`, so even a stray transition would be inert.
//
// `cb` is the React `setState` (or batch of them) that flips the tab /
// mode / filter. It must be synchronous — the snapshot is taken before it
// runs and committed after, so async work would capture an empty frame.

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function withViewTransition(cb: () => void): void {
  if (typeof document === 'undefined') {
    cb()
    return
  }
  const doc = document as ViewTransitionDocument
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    cb()
    return
  }
  doc.startViewTransition(cb)
}
