import { useState, type FormEvent } from 'react'
import { claimDeviceLink } from '../../lib/api/deviceLink'
import { useModalA11y } from '../../lib/hooks/useModalA11y'
import './LinkDeviceModal.css'

// Claims a TV/phone pairing code for the signed-in member. Opened automatically
// when the app is entered via `#/link/CODE` (the URL the device displays), and
// from the user menu for hand-typed codes.
export function LinkDeviceModal({ initialCode, onClose }: { initialCode: string; onClose: () => void }) {
  const [code, setCode] = useState(initialCode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const ref = useModalA11y<HTMLDivElement>(onClose)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
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

  return (
    <div ref={ref} className="link-device" role="dialog" aria-modal="true" aria-labelledby="link-device-title" tabIndex={-1}>
      <form className="link-device__panel" onSubmit={(e) => void submit(e)}>
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
            <button type="submit" className="link-device__btn link-device__btn--primary" disabled={busy || code.replace(/[\s-]/g, '').length !== 8}>
              {busy ? 'Linking…' : 'Link device'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
