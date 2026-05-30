import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Accessibility behaviour for a `role="dialog" aria-modal="true"` container that
 * is a plain element (not a native <dialog>). Gives keyboard + screen-reader
 * users the contract aria-modal promises:
 *   1. on open, capture the previously-focused element and move focus into the
 *      modal (first focusable, else the container itself);
 *   2. Escape closes the modal (calls `onClose`);
 *   3. Tab / Shift+Tab cycle focus within the modal (focus trap);
 *   4. on close/unmount, restore focus to the element that was focused on open.
 *
 * Returns a ref to attach to the modal container. The container should carry
 * `tabIndex={-1}` so it can receive focus when it has no focusable children.
 */
export function useModalA11y<T extends HTMLElement>(onClose: () => void) {
  const containerRef = useRef<T | null>(null)
  // Keep the latest onClose without re-running the effect (and re-trapping
  // focus) every render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const previouslyFocused = document.activeElement as HTMLElement | null

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )

    // Move focus into the modal.
    const initial = focusables()[0] ?? container
    initial.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        // Nothing focusable inside — keep focus on the container.
        event.preventDefault()
        container.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || active === container) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore focus to wherever it was before the modal opened.
      previouslyFocused?.focus?.()
    }
  }, [])

  return containerRef
}
