import { useEffect, useRef, useState } from 'react'
import { useDialogDismiss } from '../../lib/useDialogDismiss'
import './ConfirmModal.css'

export type ConfirmIntent = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => Promise<void> | void
}

type Props = {
  intent: ConfirmIntent | null
  onClose: () => void
}

export function ConfirmModal({ intent, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // useDialogDismiss owns showModal()/close() + deferred unmount so the exit
  // transition can play. It also keeps the dialog mounted while closing, so we
  // retain the last intent's content (shownIntent) to render through the
  // fade-out — `intent` itself goes null the instant the parent clears it.
  const open = intent !== null
  const rendered = useDialogDismiss(open, dialogRef)

  // Snapshot the active intent via adjust-state-during-render (the supported
  // React pattern) so the closing dialog keeps painting, and reset the
  // transient error/pending state exactly when a new intent opens.
  const [shownIntent, setShownIntent] = useState(intent)
  if (intent && intent !== shownIntent) {
    setShownIntent(intent)
    setError(null)
    setPending(false)
  }

  useEffect(() => {
    if (!intent) return
    // Focus Cancel when a new intent opens. useDialogDismiss (declared above)
    // has already run showModal() by the time this effect fires.
    cancelBtnRef.current?.focus()
  }, [intent])

  if (!rendered || !shownIntent) return null

  const handleClose = () => {
    if (pending) return
    onClose()
  }

  const handleConfirm = async () => {
    setError(null)
    setPending(true)
    try {
      await shownIntent.onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPending(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm"
      onCancel={(e) => {
        if (pending) e.preventDefault()
        else handleClose()
      }}
      onClose={handleClose}
      onKeyDown={(e) => {
        // Per DESIGN.md: Enter must NOT submit the destructive action under
        // any circumstances. If Cancel is focused, Enter cancels (safe). If
        // Confirm is focused, Enter is intercepted and does nothing — user
        // must click intentionally.
        if (e.key !== 'Enter') return
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement === cancelBtnRef.current) handleClose()
      }}
    >
      <div
        className="confirm__panel"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm__title">{shownIntent.title}</h2>
        <p className="confirm__body">{shownIntent.body}</p>
        {error && <p className="confirm__error" role="alert">{error}</p>}
        <div className="confirm__actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="confirm__cancel"
            onClick={handleClose}
            disabled={pending}
          >
            {shownIntent.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className="confirm__confirm"
            onClick={handleConfirm}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? 'Working' : shownIntent.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
