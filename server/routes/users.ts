// /api/users — admin-only listing of who has access to the dashboard.
//
// Sources:
//   - The current admin's own Plex account (always listed first as Owner).
//   - Accepted share recipients via plex.tv/api/users (legacy XML).
//   - Pending invitations via plex.tv/api/v2/friends/requested (best-effort
//     — if this call fails we still return accepted users).
// Each user is annotated with the role we'd assign on login: 'admin' if
// their username matches an entry in env.admins (case-insensitive),
// otherwise 'user'.

import { Hono } from 'hono'
import { requireAdmin, type Env } from '../middleware/auth.js'
import { getUser, listAcceptedUsers, listPendingInvites } from '../plex.js'
import { env } from '../env.js'

export const users = new Hono<Env>()

users.use('*', requireAdmin)

function roleFor(username: string): 'admin' | 'user' {
  const lower = username.toLowerCase()
  return env.admins.some((a) => a.toLowerCase() === lower) ? 'admin' : 'user'
}

users.get('/', async (c) => {
  const session = c.get('session')
  if (!session.plexAuthToken) {
    return c.json(
      { error: 'no_plex_token', message: 'Re-authenticate to refresh your Plex token.' },
      409,
    )
  }

  try {
    // Pending invites are best-effort: if the call fails (timeout, Plex
    // returning a wrapper shape we don't recognize, etc.) the route
    // still returns owner + accepted users so the tab keeps working.
    const [me, accepted, pending] = await Promise.all([
      getUser(session.plexAuthToken),
      listAcceptedUsers(session.plexAuthToken),
      listPendingInvites(session.plexAuthToken).catch((err) => {
        console.warn('users: listPendingInvites failed, omitting:', err)
        return []
      }),
    ])
    const owner = {
      id: me.id,
      username: me.username,
      title: me.username,
      email: me.email,
      thumb: me.thumb,
      role: roleFor(me.username),
      relation: 'owner' as const,
      status: 'accepted' as const,
    }
    // Merge accepted + pending, but suppress pending entries that have
    // already been accepted (Plex may briefly list both during the gap
    // between accept and cache refresh).
    const acceptedKeys = new Set(
      accepted.flatMap((u) => [u.email?.toLowerCase(), u.username.toLowerCase()].filter(Boolean) as string[]),
    )
    const pendingFiltered = pending.filter((p) => {
      const e = p.email?.toLowerCase()
      const u = p.username.toLowerCase()
      return !(e && acceptedKeys.has(e)) && !(u && acceptedKeys.has(u))
    })
    const others = [...accepted, ...pendingFiltered]
      .filter((u) => u.id !== me.id && (u.username || u.title))
      .map((u) => ({
        id: u.id,
        username: u.username,
        title: u.title ?? u.username,
        email: u.email ?? null,
        thumb: u.thumb ?? null,
        role: roleFor(u.username),
        relation: 'friend' as const,
        status: u.status,
      }))
    return c.json({ users: [owner, ...others] })
  } catch (e) {
    return c.json({ error: 'plex_lookup_failed', detail: String(e) }, 502)
  }
})
