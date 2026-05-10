// /api/users — admin-only listing of who has access to the dashboard.
//
// Sources:
//   - The current admin's own Plex account (always listed first as Owner).
//   - Their Plex friends list (`plex.tv/api/v2/friends`). Friends without
//     this server shared to them won't be able to log in (PLEX_SERVER_ID
//     gate), but listing them is still useful to see the full Plex
//     social graph the dashboard could pull from.
// Each user is annotated with the role we'd assign on login: 'admin' if
// their username matches an entry in env.admins (case-insensitive),
// otherwise 'user'.

import { Hono } from 'hono'
import { requireAdmin, type Env } from '../middleware/auth.js'
import { getUser, listFriends } from '../plex.js'
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
    const [me, friends] = await Promise.all([
      getUser(session.plexAuthToken),
      listFriends(session.plexAuthToken),
    ])
    const owner = {
      id: me.id,
      username: me.username,
      title: me.username,
      email: me.email,
      thumb: me.thumb,
      role: roleFor(me.username),
      relation: 'owner' as const,
    }
    const others = friends
      .filter((f) => f.username && f.username !== me.username)
      .map((f) => ({
        id: f.id,
        username: f.username,
        title: f.title ?? f.username,
        email: f.email ?? null,
        thumb: f.thumb ?? null,
        role: roleFor(f.username),
        relation: 'friend' as const,
      }))
    return c.json({ users: [owner, ...others] })
  } catch (e) {
    return c.json({ error: 'plex_lookup_failed', detail: String(e) }, 502)
  }
})
