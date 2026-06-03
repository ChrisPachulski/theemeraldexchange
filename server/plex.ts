// Plex.tv API client — only the surface we need for PIN-based auth and
// server-membership verification. Plex returns XML by default; the
// `Accept: application/json` header switches it to JSON across the
// /api/v2 endpoints we use.

import { createHash } from 'node:crypto'
import { env } from './env.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS } from './services/upstream.js'

const PLEX_BASE = 'https://plex.tv/api/v2'
const AUTH_PAGE = 'https://app.plex.tv/auth#'

// The product label plex.tv shows the user during sign-in ("<product> is
// trying to sign in"). Exported so the auth route can hand it to the SPA,
// which creates the WEB PIN in the browser — keeping a SINGLE source of
// truth for the product string across the header here, buildAuthUrl, and
// the browser-side create.
export const PLEX_PRODUCT = 'The Emerald Exchange'

const baseHeaders = (): Record<string, string> => ({
  Accept: 'application/json',
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Client-Identifier': env.plexClientId,
  'X-Plex-Version': '0.1.0',
  'X-Plex-Platform': 'Web',
  'X-Plex-Device': PLEX_PRODUCT,
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

// Step 1: create a PIN.
//
// IMPORTANT: the WEB sign-in NO LONGER calls this — the SPA creates its PIN
// directly in the browser (server/auth.ts has no /plex/pin route) so plex.tv
// attributes the request to the VISITOR's IP instead of leaking the host's
// home IP onto Plex's "Security Alert" page. This server-side createPin is
// retained ONLY for the native device-pairing flow (server/routes/device.ts),
// where the authorizing user is on a separate device via plex.tv/link.
export async function createPin(): Promise<Pin> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/pins?strong=true`,
    { method: 'POST', headers: baseHeaders() },
    WAN_TIMEOUT_MS,
    'plex.createPin',
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '<read failed>')
    console.error(
      `[plex.createPin] FAILED status=${res.status} clientID=${env.plexClientId} body=${body.slice(0, 300)}`,
    )
    throw new Error(`plex.createPin failed: ${res.status}`)
  }
  const data = (await res.json()) as Pin
  console.info(`[plex.createPin] ok id=${data.id} clientID=${env.plexClientId}`)
  return data
}

// Step 2: poll until the PIN carries an authToken (user authorized).
export async function checkPin(pinId: number): Promise<Pin> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/pins/${pinId}`,
    { headers: baseHeaders() },
    WAN_TIMEOUT_MS,
    'plex.checkPin',
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '<read failed>')
    console.error(
      `[plex.checkPin] FAILED status=${res.status} pinId=${pinId} clientID=${env.plexClientId} body=${body.slice(0, 300)}`,
    )
    throw new Error(`plex.checkPin failed: ${res.status}`)
  }
  const data = (await res.json()) as Pin
  // Log the polled state without leaking the authToken value. A
  // {status:'pending'} loop in production now produces evidence:
  //   - "tokenPresent=false" forever → plex.tv has not attached a token
  //     (popup not authorized, or clientID mismatch between create/auth/
  //     check; the most common cause is PLEX_CLIENT_ID drift between the
  //     server boot and the popup auth URL the SPA opened)
  //   - "tokenPresent=true" then the rest of the route runs as normal
  // Logged at info on every poll — at 1.5s cadence that's ~40 lines/min
  // per signing-in user, low enough to leave on permanently.
  console.info(
    `[plex.checkPin] ok pinId=${pinId} tokenPresent=${Boolean(data.authToken)} clientID=${env.plexClientId}`,
  )
  return data
}

// Step 3: identify the user behind the authToken.
export async function getUser(authToken: string): Promise<PlexUser> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/user`,
    { headers: { ...baseHeaders(), 'X-Plex-Token': authToken } },
    WAN_TIMEOUT_MS,
    'plex.getUser',
  )
  if (!res.ok) throw new Error(`plex.getUser failed: ${res.status}`)
  return (await res.json()) as PlexUser
}

// Step 4: verify the user is a member of our home Plex server. Plex
// returns every resource the token can see — including the user's own
// servers (owned: true) and ones they've been invited to (owned: false).
// A "member of our server" is anyone for whom that server's
// machineIdentifier appears in their resource list.
export async function listResources(authToken: string): Promise<PlexResource[]> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/resources?includeHttps=1`,
    { headers: { ...baseHeaders(), 'X-Plex-Token': authToken } },
    WAN_TIMEOUT_MS,
    'plex.listResources',
  )
  if (!res.ok) throw new Error(`plex.listResources failed: ${res.status}`)
  return (await res.json()) as PlexResource[]
}

// Bounded variant used by the sessionGate revalidation loop. The plain
// listResources throws on every non-2xx, which loses the auth-vs-
// outage distinction the gate needs:
//   - 401 / 403 → token revoked, user should be signed out
//   - 5xx / network error / timeout → plex.tv hiccup, fail open
// Returns the typed result on success, the HTTP status on a non-ok
// HTTP response, or 'network_error' for fetch throws / timeouts.
export type ListResourcesProbe =
  | { kind: 'ok'; resources: PlexResource[] }
  | { kind: 'http_error'; status: number }
  | { kind: 'network_error' }

export async function probeResources(
  authToken: string,
  signal?: AbortSignal,
): Promise<ListResourcesProbe> {
  try {
    const res = await fetch(`${PLEX_BASE}/resources?includeHttps=1`, {
      headers: { ...baseHeaders(), 'X-Plex-Token': authToken },
      signal,
    })
    if (!res.ok) return { kind: 'http_error', status: res.status }
    const resources = (await res.json()) as PlexResource[]
    return { kind: 'ok', resources }
  } catch {
    return { kind: 'network_error' }
  }
}

export async function signOut(authToken: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/signout`,
    { method: 'POST', headers: { ...baseHeaders(), 'X-Plex-Token': authToken } },
    WAN_TIMEOUT_MS,
    'plex.signOut',
  )
  if (!res.ok) {
    throw new Error(`plex.signOut failed: ${res.status}`)
  }
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
  const url = 'https://plex.tv/api/users'
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'X-Plex-Product': 'The Emerald Exchange',
        'X-Plex-Client-Identifier': env.plexClientId,
        'X-Plex-Token': authToken,
        Accept: 'application/xml',
      },
    },
    WAN_TIMEOUT_MS,
    'plex.listAcceptedUsers',
  )
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
    .map((r): PlexFriend | null => {
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
        id: id ?? -stableHash(email || title || username),
        username,
        title,
        email,
        thumb: r.thumb ?? null,
        status: 'pending',
      }
    })
    .filter((u): u is PlexFriend => u !== null)
}

// Server-scoped share endpoint — XML, returns one <SharedServer/>
// per share relationship the OWNER has granted on this specific
// server. This is the endpoint python-plexapi calls in
// MyPlexAccount.sharedServers(). Legacy /api/users misses some
// users (e.g. recipients added through the modern web flow); this
// endpoint catches them.
function parseSharedServerElements(xml: string): PlexFriend[] {
  const out: PlexFriend[] = []
  for (const match of xml.matchAll(/<SharedServer\s+([^>]+?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[a[1]] = unescapeXml(a[2])
    }
    // Identity: prefer userID (Plex account id), fall back to id.
    const id = Number(attrs.userID || attrs.id)
    if (!Number.isFinite(id)) continue
    const username = attrs.username || attrs.email || ''
    const title = attrs.username || attrs.email || ''
    if (!username && !title) continue
    out.push({
      id,
      username,
      title,
      email: attrs.email || null,
      thumb: null, // legacy SharedServer doesn't carry a thumb
      status: attrs.accepted === '0' ? 'pending' : 'accepted',
    })
  }
  return out
}

export async function listSharedServerInvitees(authToken: string): Promise<PlexFriend[]> {
  if (!env.plexServerId) return []
  const url = `https://plex.tv/api/servers/${encodeURIComponent(env.plexServerId)}/shared_servers`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'X-Plex-Product': 'The Emerald Exchange',
        'X-Plex-Client-Identifier': env.plexClientId,
        'X-Plex-Token': authToken,
        Accept: 'application/xml',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`plex.listSharedServerInvitees failed: ${res.status}`)
  const xml = await res.text()
  return parseSharedServerElements(xml)
}

function stableHash(s: string): number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)
  const digest = createHash('sha256').update(s, 'utf8').digest()
  return Number(digest.readBigUInt64BE(0) % maxSafe) + 1
}

// Local PMS /accounts endpoint — lists every account that has ever
// accessed THIS server, regardless of how (current share, revoked
// share, Plex Home profile, managed user, etc.). This is the same
// source Tautulli uses for "Top Users." Catches users that plex.tv's
// cloud APIs no longer report (e.g. share revoked but historic
// playback still attributed to them).
function parseAccountElements(xml: string): PlexFriend[] {
  const out: PlexFriend[] = []
  for (const match of xml.matchAll(/<Account\s+([^>]+?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[a[1]] = unescapeXml(a[2])
    }
    const id = Number(attrs.id)
    if (!Number.isFinite(id)) continue
    // The PMS /accounts/0 "Local" account represents anonymous/local
    // playback; skip it.
    if (id === 0) continue
    const name = attrs.name || ''
    if (!name) continue
    out.push({
      id,
      username: name,
      title: name,
      email: null, // /accounts doesn't expose email
      thumb: attrs.thumb || null,
      status: 'accepted',
    })
  }
  return out
}

export async function listLocalServerAccounts(authToken: string): Promise<PlexFriend[]> {
  const url = `${env.plexServerUrl}/accounts`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'X-Plex-Token': authToken,
        Accept: 'application/xml',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`plex.listLocalServerAccounts failed: ${res.status}`)
  const xml = await res.text()
  return parseAccountElements(xml)
}

// Plex Home users — accounts under the owner's "Plex Home" household.
// Distinct from share recipients: a Home user lives under the owner's
// Plex account as a separate profile (kid account, partner, etc.) and
// shares the household's libraries by default, not because of a
// per-server invite. They don't appear in /api/users or
// /api/servers/{id}/shared_servers — they're under /api/home/users.
export async function listHomeUsers(authToken: string): Promise<PlexFriend[]> {
  const url = 'https://plex.tv/api/home/users'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'X-Plex-Product': 'The Emerald Exchange',
        'X-Plex-Client-Identifier': env.plexClientId,
        'X-Plex-Token': authToken,
        Accept: 'application/xml',
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`plex.listHomeUsers failed: ${res.status}`)
  const xml = await res.text()
  // Same <User .../> element shape as /api/users, so parseUserElements
  // works. Home users are always 'accepted' for our purposes.
  return parseUserElements(xml)
}

// Build the URL the user's browser opens to authorize the PIN. The PIN
// `code` (NOT the id) goes into the hash params. Used by the native
// device-pairing flow (server/routes/device.ts); the web SPA builds the
// equivalent URL client-side.
export function buildAuthUrl(pinCode: string): string {
  const params = new URLSearchParams({
    clientID: env.plexClientId,
    code: pinCode,
    'context[device][product]': PLEX_PRODUCT,
  })
  return `${AUTH_PAGE}?${params.toString()}`
}
