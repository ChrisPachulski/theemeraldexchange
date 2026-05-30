import { useEffect, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { browserSupportsWebAuthn } from '@simplewebauthn/browser'
import './PasskeyButtons.css'

// Passkey (WebAuthn) sign-in + first-time setup. This is the cross-platform,
// Plex-independent login: it authenticates a self-owned `local:<ulid>`
// identity with Face ID / Touch ID / Windows Hello / a security key. Rendered
// next to the Plex + Apple buttons on the sign-in screen.
//
//   - "Sign in with a passkey" — usernameless; the OS offers the passkeys
//     already registered for this site. No invite code needed.
//   - "Set one up" — first-time: needs a display name + a valid invite code
//     (the invite authorizes the new identity onto the members allowlist,
//     exactly like the Plex/Apple paths).
export function PasskeyButtons({ inviteCode }: { inviteCode?: string }) {
  const { passkeyLogin, passkeyRegister, signInState } = useAuth()
  const [supported, setSupported] = useState(false)
  const [mode, setMode] = useState<'idle' | 'register'>('idle')
  const [handle, setHandle] = useState('')
  const pending = signInState === 'pending' || signInState === 'opening'

  // Feature-detect once on mount; hide the whole block on browsers without
  // WebAuthn rather than offering a button that can only fail.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time
      // mount capability probe: browserSupportsWebAuthn() reads
      // window.PublicKeyCredential, unavailable at SSR/first render, so it must
      // run post-mount. Empty dep array → fires once.
      setSupported(browserSupportsWebAuthn())
    } catch {
      setSupported(false)
    }
  }, [])

  if (!supported) return null

  return (
    <div className="passkey-signin">
      <button
        type="button"
        className="walkthrough__signin-button passkey-signin__login"
        onClick={() => void passkeyLogin()}
        disabled={pending}
      >
        {pending ? 'Waiting…' : 'Sign in with a passkey'}
      </button>

      {mode === 'idle' ? (
        <button
          type="button"
          className="passkey-signin__toggle"
          onClick={() => setMode('register')}
          disabled={pending}
        >
          First time with a passkey? Set one up
        </button>
      ) : (
        <div className="passkey-signin__register">
          <label className="passkey-signin__label" htmlFor="passkey-handle">
            Your name
          </label>
          <input
            id="passkey-handle"
            className="walkthrough__invite-input"
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="e.g. Chris"
            autoComplete="name"
            spellCheck={false}
            disabled={pending}
          />
          <div className="passkey-signin__actions">
            <button
              type="button"
              className="walkthrough__signin-button"
              onClick={() => void passkeyRegister({ handle: handle.trim(), inviteCode })}
              disabled={pending || handle.trim().length === 0}
            >
              {pending ? 'Creating…' : 'Create passkey'}
            </button>
            <button
              type="button"
              className="passkey-signin__cancel"
              onClick={() => setMode('idle')}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
          <p className="passkey-signin__hint">
            Needs a valid invite code above. Works on this device with Face ID,
            Touch ID, Windows Hello, or a security key — no Plex account required.
          </p>
        </div>
      )}
    </div>
  )
}
