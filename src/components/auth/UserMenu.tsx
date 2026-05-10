import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth'
import './UserMenu.css'

// Compact user pill with a dropdown — username, role badge, sign out.
// Admins also see:
//   - View-as toggle to preview the app as a regular user (UI-only;
//     server-side permissions are unchanged).
//   - Direct links to Sonarr / Radarr / SAB on the LAN. Hidden when
//     viewing as user. Links use the LAN hostname only — no IP — so the
//     public Netlify bundle leaks nothing about the home network.
//
// The component is positioning-agnostic; the parent (HomeNav / TopNav)
// places it in the top-right cluster.

const APP_LINKS = [
  { name: 'Sonarr', href: 'http://theemeraldexchange.local/tv' },
  { name: 'Radarr', href: 'http://theemeraldexchange.local/movies' },
  { name: 'SAB', href: 'http://theemeraldexchange.local/downloads' },
] as const

export function UserMenu() {
  const { user, role, effectiveRole, isAdmin, setViewAs, signOut } = useAuth()
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
          <div className="user-menu__row">
            <span className="user-menu__row-label">Role</span>
            <span className={`user-menu__role user-menu__role--${effectiveRole}`}>
              {previewing ? 'user (preview)' : effectiveRole}
            </span>
          </div>

          {isActualAdmin && (
            <button
              type="button"
              className="user-menu__toggle"
              onClick={() => setViewAs(previewing ? null : 'user')}
              role="switch"
              aria-checked={!previewing}
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
          )}

          {isAdmin && (
            <div className="user-menu__apps" role="group" aria-label="Open service">
              {APP_LINKS.map((app) => (
                <a
                  key={app.name}
                  className="user-menu__app"
                  href={app.href}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {app.name}
                </a>
              ))}
            </div>
          )}

          <button
            type="button"
            className="user-menu__signout"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
