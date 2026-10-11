import { useEffect, useRef, useState } from 'react'
import { authModeFromUser, useAuth, type AuthMode } from '../../lib/auth'
import { apiUrl } from '../../lib/api/base'
import { throwApiError } from '../../lib/api/errors'
import { useLimits } from '../../lib/hooks/useLimits'
import { useConfirm } from '../confirm/useConfirm'
import { DiscordNotifications } from './DiscordNotifications'
import { ApiKeySettings } from './ApiKeySettings'
import { DevicesPanel } from './DevicesPanel'
import { InvitesPanel } from './InvitesPanel'
import { LinkDeviceModal } from './LinkDeviceModal'
import { PreferencesPanel } from './PreferencesPanel'
import './UserMenu.css'

// Trigger pill in the top-right cluster + dropdown panel for the
// authenticated user. The panel is structured into five sections
// separated by hairlines:
//   1. Header: who you're signed in as + role badge
//   2. Toggle: admins can preview the app as a regular user (UI-only)
//   3. Apps:   admin-only direct links to Sonarr / Radarr / SAB on the LAN
//              (hidden when viewing-as-user). Links use the LAN hostname
//              only — no IP — so the public bundle leaks nothing about
//              the home network.
//   4. Discord notifications: admin-only webhook config that drives
//              Sonarr + Radarr's Discord notification connections.
//   5. Sign out, and Delete account when the server offers self-deletion

const APP_LINKS = [
  { name: 'Sonarr', href: 'https://sonarr.theemeraldexchange.com' },
  { name: 'Radarr', href: 'https://radarr.theemeraldexchange.com' },
  { name: 'SAB', href: 'https://sab.theemeraldexchange.com' },
] as const

const PROVIDER_LABELS: Record<AuthMode, string> = {
  plex: 'Plex',
  apple: 'Apple',
  google: 'Google',
  workos: 'WorkOS',
  local: 'a local account',
}

// The Apple app's refusal copy (AccountDeletionCopy). DELETE /api/account/self
// answers 409 only for last_admin, and it changes nothing when it does.
const LAST_ADMIN_MESSAGE =
  'The server refused to delete your account because you are its last administrator, ' +
  'and a household with no administrator could never invite anyone again. Nothing was ' +
  'changed on the server or in this browser. Make another member an administrator first, ' +
  'then try again.'

async function deleteOwnAccount(): Promise<void> {
  const r = await fetch(apiUrl('/api/account/self'), { method: 'DELETE', credentials: 'include' })
  if (r.status === 409) throw new Error(LAST_ADMIN_MESSAGE)
  if (!r.ok) await throwApiError(r, 'Delete account')
}

// Everything the SPA keeps in this browser lives under these prefixes.
function clearLocalData(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
    for (const key of keys) {
      if (key.startsWith('eex.') || key.startsWith('guide.')) localStorage.removeItem(key)
    }
  } catch {
    /* storage unavailable, so nothing was stored */
  }
}

export function UserMenu() {
  const { user, role, effectiveRole, isAdmin, setViewAs, signOut, signOutError } = useAuth()
  const confirm = useConfirm()
  const { data: limits } = useLimits()
  const [open, setOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      // A confirm dialog opened from a panel in here renders outside this
      // subtree; clicking it must not close the menu and unmount that panel.
      if ((e.target as Element).closest?.('dialog')) return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  if (!user) return null
  const initial = user.username.charAt(0).toUpperCase()
  const isActualAdmin = role === 'admin'
  const previewing = isActualAdmin && effectiveRole === 'user'

  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-menu__avatar" aria-hidden="true">{initial}</span>
        <span className="user-menu__name">{user.username}</span>
      </button>

      {open && (
        <div className="user-menu__dropdown" role="menu">
          <header className="user-menu__header">
            <p className="user-menu__eyebrow">
              Signed in with {PROVIDER_LABELS[authModeFromUser(user)]} as
            </p>
            <div className="user-menu__identity">
              <span className="user-menu__username">{user.username}</span>
              <span className={`user-menu__role user-menu__role--${effectiveRole}`}>
                {previewing ? 'user (preview)' : effectiveRole}
              </span>
            </div>
          </header>

          {isActualAdmin && (
            <>
              <hr className="user-menu__divider" />
              <button
                type="button"
                className="user-menu__toggle"
                onClick={() => setViewAs(previewing ? null : 'user')}
                role="switch"
                aria-checked={previewing}
              >
                <span className="user-menu__toggle-label">View as user</span>
                <span
                  className={
                    previewing
                      ? 'user-menu__toggle-track user-menu__toggle-track--on'
                      : 'user-menu__toggle-track'
                  }
                  aria-hidden="true"
                >
                  <span className="user-menu__toggle-thumb" />
                </span>
              </button>
            </>
          )}

          {/* Admin apps (Sonarr/Radarr/SAB) are OPERATOR tools and a recorded
              PRODUCT.md exception (re-review fix3, orchestrator decision):
              they render for admins ONLY. `isAdmin` is effectiveRole-based,
              which is strictly tighter than role==='admin' — only a real
              admin can hold effectiveRole 'admin', and an admin previewing
              as a user intentionally loses the links along with the rest of
              the admin chrome. Never widen this gate to non-admin roles. */}
          {isAdmin && (
            <>
              <hr className="user-menu__divider" />
              <section
                className="user-menu__apps"
                role="group"
                aria-label="Admin services"
              >
                <p className="user-menu__eyebrow">Admin apps</p>
                <ul className="user-menu__app-list">
                  {APP_LINKS.map((app) => (
                    <li key={app.name}>
                      <a
                        className="user-menu__app"
                        href={app.href}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <span className="user-menu__app-name">{app.name}</span>
                        <span className="user-menu__app-arrow" aria-hidden="true">-&gt;</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>

              <hr className="user-menu__divider" />
              <DiscordNotifications onClose={() => setOpen(false)} />

              <hr className="user-menu__divider" />
              <InvitesPanel />
            </>
          )}

          <hr className="user-menu__divider" />
          <ApiKeySettings />

          <hr className="user-menu__divider" />
          <DevicesPanel />

          <hr className="user-menu__divider" />
          <PreferencesPanel />

          <hr className="user-menu__divider" />
          <button
            type="button"
            className="user-menu__signout"
            onClick={() => {
              setOpen(false)
              setLinking(true)
            }}
          >
            Link a TV or phone
          </button>
          <button
            type="button"
            className="user-menu__signout"
            onClick={() => {
              void signOut()
                .then(() => setOpen(false))
                .catch(() => {})
            }}
          >
            Sign out
          </button>
          {limits?.accountDeletionEnabled && (
            <button
              type="button"
              className="user-menu__signout user-menu__signout--danger"
              onClick={() =>
                confirm({
                  title: 'Delete your account?',
                  body:
                    'This deletes your account on this server, signs out every device paired to it, ' +
                    'and clears everything Emerald stored in this browser. This cannot be undone. ' +
                    'Rejoining needs a new invite from the person who runs the server.',
                  confirmLabel: 'Delete account',
                  cancelLabel: 'Keep account',
                  onConfirm: async () => {
                    await deleteOwnAccount()
                    clearLocalData()
                    // The account is gone either way; signOut clears the local
                    // session even when its logout call fails.
                    await signOut().catch(() => {})
                  },
                })
              }
            >
              Delete account
            </button>
          )}
          {signOutError && (
            <p className="user-menu__signout-error" role="alert">{signOutError}</p>
          )}
        </div>
      )}
      {linking && <LinkDeviceModal initialCode="" onClose={() => setLinking(false)} />}
    </div>
  )
}
