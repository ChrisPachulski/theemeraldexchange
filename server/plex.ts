// Plex.tv API client — only the surface we need for PIN-based auth and
// server-membership verification. Plex returns XML by default; the
// `Accept: application/json` header switches it to JSON across the
// /api/v2 endpoints we use.

import { env } from './env.js'

const PLEX_BASE = 'https://plex.tv/api/v2'
const AUTH_PAGE = 'https://app.plex.tv/auth#'

const baseHeaders = (): Record<string, string> => ({
  Accept: 'application/json',
  'X-Plex-Product': 'The Emerald Exchange',
  'X-Plex-Client-Identifier': env.plexClientId,
  'X-Plex-Version': '0.1.0',
  'X-Plex-Platform': 'Web',
  'X-Plex-Device': 'The Emerald Exchange',
})

export type Pin = {
  id: number
  code: string
  authToken: string | null
}

export type PlexUser = {
  id: number
  uuid: string
  username: string
  email: string
  thumb: string | null
}

export type PlexResource = {
  name: string
  clientIdentifier: string
  owned: boolean
  home: boolean
  provides: string
}

// Step 1: create a PIN. The returned `code` is plugged into the auth
// page URL; the user authenticates there; we then poll the PIN until it
// has an `authToken`.
export async function createPin(): Promise<Pin> {
  const res = await fetch(`${PLEX_BASE}/pins?strong=true`, {
    method: 'POST',
    headers: baseHeaders(),
  })
  if (!res.ok) throw new Error(`plex.createPin failed: ${res.status}`)
  const data = (await res.json()) as Pin
  return data
}

// Step 2: poll until the PIN carries an authToken (user authorized).
export async function checkPin(pinId: number): Promise<Pin> {
  const res = await fetch(`${PLEX_BASE}/pins/${pinId}`, {
    headers: baseHeaders(),
  })
  if (!res.ok) throw new Error(`plex.checkPin failed: ${res.status}`)
  return (await res.json()) as Pin
}

// Step 3: identify the user behind the authToken.
export async function getUser(authToken: string): Promise<PlexUser> {
  const res = await fetch(`${PLEX_BASE}/user`, {
    headers: { ...baseHeaders(), 'X-Plex-Token': authToken },
  })
  if (!res.ok) throw new Error(`plex.getUser failed: ${res.status}`)
  return (await res.json()) as PlexUser
}

// Step 4: verify the user is a member of our home Plex server. Plex
// returns every resource the token can see — including the user's own
// servers (owned: true) and ones they've been invited to (owned: false).
// A "member of our server" is anyone for whom that server's
// machineIdentifier appears in their resource list.
export async function listResources(authToken: string): Promise<PlexResource[]> {
  const res = await fetch(`${PLEX_BASE}/resources?includeHttps=1`, {
    headers: { ...baseHeaders(), 'X-Plex-Token': authToken },
  })
  if (!res.ok) throw new Error(`plex.listResources failed: ${res.status}`)
  return (await res.json()) as PlexResource[]
}

// People the owner has shared their Plex server with. Two states matter
// to the Users tab:
//   - ACCEPTED: the invitee accepted and can stream right now. Comes
//     from the legacy /api/users XML endpoint, which is what
//     python-plexapi's MyPlexAccount.users() uses.
//   - PENDING: the owner sent an invite that hasn't been accepted yet.
//     Comes from /api/v2/friends/requested (the outgoing-invites list,
//     which is what python-plexapi's pendingInvites(includeSent=True)
//     uses).
//
// We intentionally do NOT use /api/v2/friends — that's the accepted
// mutual-friends graph and overlaps awkwardly with /api/users.
export type PlexFriend = {
  id: number
  username: string
  title?: string
  email?: string | null
  thumb?: string | null
  status: 'accepted' | 'pending'
}

function unescapeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function parseUserElements(xml: string): PlexFriend[] {
  const out: PlexFriend[] = []
  for (const match of xml.matchAll(/<User\s+([^>]+?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[a[1]] = unescapeXml(a[2])
    }
    const id = Number(attrs.id)
    if (!Number.isFinite(id)) continue
    out.push({
      id,
      username: attrs.username || attrs.title || '',
      title: attrs.title || attrs.username || undefined,
      email: attrs.email || null,
      thumb: attrs.thumb || null,
      status: 'accepted',
    })
  }
  return out
}

export async function listAcceptedUsers(authToken: string): Promise<PlexFriend[]> {
  // Legacy XML endpoint on the bare plex.tv host, NOT under /api/v2 —
  // so we don't route through PLEX_BASE.
  //
  // python-plexapi puts the auth token in the URL as a query param
  // (not a header) for this endpoint. The header form returns 200 but
  // sometimes an empty MediaContainer; the query-param form is what
  // actually returns the share list. Belt-and-suspenders: send both.
  const url = `https://plex.tv/api/users?X-Plex-Token=${encodeURIComponent(authToken)}`
  const res = await fetch(url, {
    headers: {
      'X-Plex-Product': 'The Emerald Exchange',
      'X-Plex-Client-Identifier': env.plexClientId,
      'X-Plex-Token': authToken,
      Accept: 'application/xml',
    },
  })
  if (!res.ok) throw new Error(`plex.listAcceptedUsers failed: ${res.status}`)
  const xml = await res.text()
  return parseUserElements(xml)
}

// Outgoing invites the owner has sent that haven't been accepted yet.
// /api/v2/friends/requested returns a JSON array of pending-friend
// records; for invites sent to an email address that doesn't have a
// Plex account yet, `username` may be empty and only `email` is set.
type PendingRecord = {
  id?: number
  username?: string
  title?: string
  friendlyName?: string
  email?: string | null
  thumb?: string | null
  invitedEmail?: string | null
}

export async function listPendingInvites(authToken: string): Promise<PlexFriend[]> {
  // Hard timeout so a slow plex.tv response can't take the whole
  // /api/users route down with it.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  let res: Response
  try {
    res = await fetch(`${PLEX_BASE}/friends/requested`, {
      headers: { ...baseHeaders(), 'X-Plex-Token': authToken },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  // Plex returns 404 when there are no pending invites on some accounts;
  // treat that as "empty list" rather than failing the whole route.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`plex.listPendingInvites failed: ${res.status}`)
  // Response can be either a raw array OR { friends: [...] } depending on
  // account state. python-plexapi uses rtag='friends' which expects the
  // wrapped form.
  const raw = (await res.json().catch(() => null)) as unknown
  const data: PendingRecord[] = Array.isArray(raw)
    ? (raw as PendingRecord[])
    : Array.isArray((raw as { friends?: unknown })?.friends)
      ? ((raw as { friends: PendingRecord[] }).friends)
      : []
  return data
    .map((r) => {
      const id =
        typeof r.id === 'number' && Number.isFinite(r.id) ? r.id : undefined
      const email = r.email ?? r.invitedEmail ?? null
      const title = r.friendlyName || r.title || r.username || email || ''
      const username = r.username || email || ''
      if (!title && !username) return null
      return {
        // Synthesize a stable-ish key when Plex hasn't assigned an
        // account id yet (email-only invites). Negative sentinel to
        // avoid collisions with real ids.
        id: id ?? -(stableHash(email || title || username) >>> 0),
        username,
        title,
        email,
        thumb: r.thumb ?? null,
        status: 'pending' as const,
      } satisfies PlexFriend
    })
    .filter((u): u is PlexFriend => u !== null)
}

function stableHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return h
}

// Build the URL the user's browser opens to authorize the PIN. The PIN
// `code` (NOT the id) goes into the hash params.
export function buildAuthUrl(pinCode: string): string {
  const params = new URLSearchParams({
    clientID: env.plexClientId,
    code: pinCode,
    'context[device][product]': 'The Emerald Exchange',
  })
  return `${AUTH_PAGE}?${params.toString()}`
}
