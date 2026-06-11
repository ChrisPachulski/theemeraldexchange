import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { DiscordNotifications } from './DiscordNotifications'
import { ApiKeySettings } from './ApiKeySettings'
import { DevicesPanel } from './DevicesPanel'
import { InvitesPanel } from './InvitesPanel'
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
//   5. Sign out

const APP_LINKS = [
  { name: 'Sonarr', href: 'https://sonarr.theemeraldexchange.com' },
  { name: 'Radarr', href: 'https://radarr.theemeraldexchange.com' },
  { name: 'SAB', href: 'https://sab.theemeraldexchange.com' },
] as const

export function UserMenu() {
  const { user, role, effectiveRole, isAdmin, setViewAs, signOut, signOutError } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
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
            <p className="user-menu__eyebrow">Signed in as</p>
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
          {signOutError && (
            <p className="user-menu__signout-error" role="alert">{signOutError}</p>
          )}
        </div>
      )}
    </div>
  )
}
