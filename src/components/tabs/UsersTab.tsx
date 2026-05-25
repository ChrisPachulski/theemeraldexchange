import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../../lib/api/base'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { useAuth } from '../../lib/auth'
import './UsersTab.css'

type UserRow = {
  id: number
  username: string
  title: string
  email: string | null
  thumb: string | null
  role: 'admin' | 'user'
  relation: 'owner' | 'friend'
  status: 'accepted' | 'pending'
}

class UsersFetchError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

async function fetchUsers(): Promise<UserRow[]> {
  const r = await fetch(apiUrl('/api/users'), { credentials: 'include' })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new UsersFetchError(
      body.message ?? body.error ?? `users fetch ${r.status}`,
      body.error,
    )
  }
  const data = (await r.json()) as { users: UserRow[] }
  return data.users
}

export function UsersTab() {
  const { signOut } = useAuth()
  const q = useQuery({
    queryKey: ['users'],
    queryFn: fetchUsers,
    staleTime: 60_000,
    retry: (failureCount, err) =>
      err instanceof UsersFetchError && err.code === 'no_plex_token'
        ? false
        : failureCount < 2,
  })

  if (q.isPending) {
    return (
      <section className="users-tab">
        <LoadingPulse>Loading users</LoadingPulse>
      </section>
    )
  }

  if (q.error) {
    const stale =
      q.error instanceof UsersFetchError && q.error.code === 'no_plex_token'
    if (stale) {
      return (
        <section className="users-tab">
          <div className="users-tab__stale">
            <p className="users-tab__stale-title">Your session is from an earlier build.</p>
            <p className="users-tab__stale-body">
              The Users tab needs a Plex token attached to your session — sessions
              issued before this feature shipped don't have one. Sign out and sign
              back in to refresh it.
            </p>
            <button
              type="button"
              className="users-tab__stale-action"
              onClick={() => {
                void signOut().catch(() => {})
              }}
            >
              Sign out &amp; re-authenticate
            </button>
          </div>
        </section>
      )
    }
    return (
      <section className="users-tab">
        <div className="users-tab__error">
          <p>Couldn't load users.</p>
          <p className="users-tab__error-detail">{q.error.message}</p>
        </div>
      </section>
    )
  }

  const rows = q.data ?? []

  return (
    <section className="users-tab">
      <header className="users-tab__header">
        <p className="users-tab__eyebrow">Access</p>
        <h2 className="users-tab__title">Who can sign in</h2>
        <p className="users-tab__hint">
          Anyone listed below who is a member of your home Plex server can sign in.
          Admin role is granted to usernames in the <code>ADMINS</code> env var; everyone
          else gets viewer access.
        </p>
      </header>

      <ul className="users-tab__list" aria-label="Users with access">
        {rows.map((u) => (
          <li key={u.id} className="users-tab__row">
            {u.thumb ? (
              <img
                className="users-tab__avatar"
                src={u.thumb}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="users-tab__avatar users-tab__avatar--fallback" aria-hidden="true">
                {u.title.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="users-tab__identity">
              <p className="users-tab__name">{u.title}</p>
              {u.title !== u.username && (
                <p className="users-tab__handle">@{u.username}</p>
              )}
              {u.email && <p className="users-tab__email">{u.email}</p>}
            </div>
            <div className="users-tab__badges">
              <span
                className={`users-tab__badge users-tab__badge--${u.role}`}
                title={
                  u.role === 'admin'
                    ? 'Can pause/cancel downloads, remove items, and view this Users page'
                    : 'Can browse, add to library, but not remove'
                }
              >
                {u.role}
              </span>
              {u.relation === 'owner' && (
                <span className="users-tab__badge users-tab__badge--owner" title="Plex server owner">
                  owner
                </span>
              )}
              {u.status === 'pending' && (
                <span
                  className="users-tab__badge users-tab__badge--pending"
                  title="Invitation sent — they haven't accepted on plex.tv yet"
                >
                  pending
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
