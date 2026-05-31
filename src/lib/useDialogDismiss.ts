import { useEffect, useState, type RefObject } from 'react'

// Deferred-unmount lifecycle for a native <dialog> so its exit transition
// (the `:not([open])` + allow-discrete CSS from b23ebaa) can actually play
// before React removes the element from the tree.
//
// Without this, a `if (!open) return null` hard-unmounts the <dialog> on the
// same render that flips `open` to false, discarding the out-transition. Here
// we keep the dialog mounted, call `.close()` to remove the `[open]` attribute
// (which drives the closing CSS state), and only set `rendered=false` once the
// panel's `transitionend` fires.
//
// Returns `rendered`: render the <dialog> while this is true, unmount when it
// is false (i.e. `if (!rendered) return null`). The hook itself owns
// showModal()/close(); callers keep their own focus + a11y wiring.
//
// reduced-motion: when the user prefers reduced motion there is no transition
// to await, so we unmount on the next tick (matching the instant swap the CSS
// keeps under that media query).
export function useDialogDismiss(
  open: boolean,
  dialogRef: RefObject<HTMLDialogElement | null>,
): boolean {
  const [rendered, setRendered] = useState(open)

  // Mount as soon as `open` becomes true so the <dialog> exists for showModal().
  // (Set-state-in-render is the supported way to derive mount state from a prop;
  // React re-renders immediately without committing the intermediate output.)
  if (open && !rendered) setRendered(true)

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return

    if (open) {
      if (!d.open) d.showModal()
      return
    }

    // open === false: begin the closing transition by dropping `[open]`.
    if (d.open) d.close()

    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduce) {
      // No transition is playing — unmount on the next tick. Deferred (not a
      // synchronous setState in the effect body) to avoid a cascading render.
      const t = window.setTimeout(() => setRendered(false), 0)
      return () => window.clearTimeout(t)
    }

    // Wait for the panel/backdrop fade-out to finish, then unmount. Guard
    // against transitionend bubbling up from descendant elements: only the
    // dialog itself or its direct panel child should end the lifecycle.
    const onEnd = (e: TransitionEvent) => {
      const target = e.target as Node | null
      if (target !== d && target?.parentNode !== d) return
      setRendered(false)
    }
    d.addEventListener('transitionend', onEnd)

    // Safety net: if transitionend never fires (e.g. no transitionable property
    // actually changed), unmount anyway so the dialog can't get stuck open. If
    // the dialog re-opens first, this effect's cleanup cancels the timer.
    const fallback = window.setTimeout(() => setRendered(false), 400)

    return () => {
      d.removeEventListener('transitionend', onEnd)
      window.clearTimeout(fallback)
    }
  }, [open, dialogRef])

  return rendered
}
