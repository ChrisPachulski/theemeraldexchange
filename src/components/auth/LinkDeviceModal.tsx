import { useEffect, useRef, useState, type FormEvent } from 'react'
import { claimDeviceLink } from '../../lib/api/deviceLink'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import './LinkDeviceModal.css'

// Claims a TV/phone pairing code for the signed-in member. Opened automatically
// when the app is entered via `#/link/CODE` (the QR the device displays), and
// from the user menu for hand-typed codes. A scanned code needs no second
// confirmation: `autoSubmit` claims it as soon as the member is signed in.
const isFullCode = (code: string) => code.replace(/[\s-]/g, '').length === 8

export function LinkDeviceModal({
  initialCode,
  onClose,
  autoSubmit = false,
}: {
  initialCode: string
  onClose: () => void
  autoSubmit?: boolean
}) {
  const [code, setCode] = useState(initialCode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const ref = useModalA11y<HTMLDivElement>(onClose)

  const claim = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await claimDeviceLink(code)
      setDone(r.device_name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void claim()
  }

  // One automatic claim per scanned code; a failure leaves the form to retry.
  const autoClaimed = useRef(false)
  useEffect(() => {
    if (!autoSubmit || autoClaimed.current || !isFullCode(initialCode)) return
    autoClaimed.current = true
    void claim()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit, initialCode])

  return (
    <div ref={ref} className="link-device" role="dialog" aria-modal="true" aria-labelledby="link-device-title" tabIndex={-1}>
      <form className="link-device__panel" onSubmit={submit}>
        <p className="link-device__eyebrow">Link a device</p>
        <h2 id="link-device-title">{done ? 'Linked' : 'Enter the code on your TV or phone'}</h2>
        {done ? (
          <p className="link-device__body">{done} is signed in as you. You can close this.</p>
        ) : (
          <>
            <input
              className="link-device__input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD2345"
              maxLength={9}
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              aria-label="Device code"
            />
            {error && <p className="link-device__error" role="alert">{error}</p>}
          </>
        )}
        <div className="link-device__actions">
          <button type="button" className="link-device__btn" onClick={onClose}>{done ? 'Done' : 'Cancel'}</button>
          {!done && (
            <button type="submit" className="link-device__btn link-device__btn--primary" disabled={busy || !isFullCode(code)}>
              {busy ? 'Linking…' : 'Link device'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
