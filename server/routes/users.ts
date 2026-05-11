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
import {
  getUser,
  listAcceptedUsers,
  listHomeUsers,
  listPendingInvites,
  listSharedServerInvitees,
} from '../plex.js'
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

  // ?debug=1 dumps the raw responses from each Plex source so we can
  // diagnose missing-user reports without blind-fixing. Admin-only
  // (already gated by middleware). Remove once Users tab is stable.
  if (c.req.query('debug') === '1') {
    const token = session.plexAuthToken
    const [usersXml, requestedJson, sharedServersJson] = await Promise.all([
      fetch('https://plex.tv/api/users', {
        headers: { 'X-Plex-Token': token, Accept: 'application/xml' },
      }).then((r) => r.text()).catch((e) => `ERR: ${e}`),
      fetch('https://plex.tv/api/v2/friends/requested', {
        headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      }).then((r) => r.text()).catch((e) => `ERR: ${e}`),
      fetch('https://plex.tv/api/v2/shared_servers', {
        headers: { 'X-Plex-Token': token, Accept: 'application/json' },
      }).then((r) => r.text()).catch((e) => `ERR: ${e}`),
    ])
    return c.json({
      sources: {
        'GET /api/users (XML)': usersXml,
        'GET /api/v2/friends/requested': requestedJson,
        'GET /api/v2/shared_servers': sharedServersJson,
      },
    })
  }

  try {
    // Pull from four sources in parallel and merge:
    //   - /api/users           — accepted share recipients
    //   - server-scoped shares — same, via the per-server endpoint
    //   - Plex Home users      — household profiles under the owner
    //   - pending invites      — sent but not accepted
    // All except /api/users are best-effort; failures log a warning
    // and return [].
    const [me, accepted, shared, home, pending] = await Promise.all([
      getUser(session.plexAuthToken),
      listAcceptedUsers(session.plexAuthToken),
      listSharedServerInvitees(session.plexAuthToken).catch((err) => {
        console.warn('users: listSharedServerInvitees failed, omitting:', err)
        return []
      }),
      listHomeUsers(session.plexAuthToken).catch((err) => {
        console.warn('users: listHomeUsers failed, omitting:', err)
        return []
      }),
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
    // Merge sources, deduping by user id (preferred) then by email or
    // username (lowercased). Status precedence: accepted > pending —
    // so if a user appears as accepted in any source, they're accepted.
    const byKey = new Map<string, typeof accepted[number]>()
    const keyFor = (u: { id: number; email?: string | null; username: string }) =>
      u.id > 0 ? `id:${u.id}` : u.email ? `e:${u.email.toLowerCase()}` : `u:${u.username.toLowerCase()}`
    // The owner appears in /api/home/users with a DIFFERENT id than
    // /api/v2/user returns (Home uses its own account ids), so id alone
    // can't dedupe — also match against username and email.
    const meUsername = me.username.toLowerCase()
    const meEmail = (me.email || '').toLowerCase()
    const isOwner = (u: { id: number; username: string; email?: string | null }) =>
      u.id === me.id ||
      u.username.toLowerCase() === meUsername ||
      (!!meEmail && (u.email || '').toLowerCase() === meEmail)
    const ingest = (list: typeof accepted) => {
      for (const u of list) {
        if (isOwner(u)) continue
        if (!u.username && !u.title) continue
        const k = keyFor(u)
        const existing = byKey.get(k)
        if (!existing) {
          byKey.set(k, u)
        } else if (existing.status === 'pending' && u.status === 'accepted') {
          byKey.set(k, { ...existing, ...u, status: 'accepted' })
        }
      }
    }
    // Order matters: accepted (legacy XML) first, then modern shares,
    // then Home users, then pending — earlier sources are kept and
    // only upgraded from pending to accepted.
    ingest(accepted)
    ingest(shared)
    ingest(home)
    ingest(pending)
    const others = [...byKey.values()].map((u) => ({
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
