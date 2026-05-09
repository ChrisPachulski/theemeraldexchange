import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../lib/auth'
import './UserMenu.css'

// Compact user pill with a dropdown — username, role badge, sign out.
// The component is positioning-agnostic; the parent (HomeNav / TopNav)
// places it in the top-right cluster.

export function UserMenu() {
  const { user, signOut } = useAuth()
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
            <span className={`user-menu__role user-menu__role--${user.role}`}>
              {user.role}
            </span>
          </div>
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
