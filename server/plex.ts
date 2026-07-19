// Plex.tv API client — only the surface we need for PIN-based auth and
// server-membership verification. Plex returns XML by default; the
// `Accept: application/json` header switches it to JSON across the
// /api/v2 endpoints we use.

import { createHash } from 'node:crypto'
import { env } from './env.js'
import { fetchWithTimeout, WAN_TIMEOUT_MS, NotConfiguredError } from './services/upstream.js'

const PLEX_BASE = 'https://plex.tv/api/v2'

// The product label plex.tv shows the user during sign-in ("<product> is
// trying to sign in"). Exported so the auth route can hand it to the clients
// (web SPA + tvOS/iOS), which now create the PIN themselves — keeping a
// SINGLE source of truth for the product string between the headers here and
// the client-side create. PIN CREATION NO LONGER HAPPENS SERVER-SIDE for any
// flow (see GET /api/auth/plex/config + server/routes/device.ts); a
// server-side createPin leaked the host's IP onto plex.tv's auth page.
export const PLEX_PRODUCT = 'The Emerald Exchange'

// Plex login is optional (plan 006 Phase 0): unset PLEX_CLIENT_ID →
// typed 503 plex_not_configured via onError instead of a boot failure.
// Every plex.tv call funnels its client identifier through here.
export function requirePlexClientId(): string {
  const clientId = env.plexClientId
  if (!clientId) throw new NotConfiguredError('plex')
  return clientId
}

const baseHeaders = (): Record<string, string> => ({
  Accept: 'application/json',
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Client-Identifier': requirePlexClientId(),
  'X-Plex-Version': '0.1.0',
  'X-Plex-Platform': 'Web',
  'X-Plex-Device': PLEX_PRODUCT,
})

export type Pin = {
  id: number
  code: string
  authToken: string | null
}

const PLEX_RATE_LIMIT_FALLBACK_SECONDS = 5
const PLEX_RATE_LIMIT_LOG_MAX_SECONDS = 30
const RETRY_AFTER_HTTP_DATE_PATTERNS = [
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/,
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/,
]

/** Expected Plex backpressure, kept distinct from local auth rate limits. */
export class PlexRateLimitError extends Error {
  readonly retryAfter: string

  constructor(retryAfter: string) {
    super('Plex PIN polling rate-limited')
    this.name = 'PlexRateLimitError'
    this.retryAfter = retryAfter
  }
}

function normalizedRetryAfter(value: string | null): string {
  const candidate = value?.trim()
  if (
    candidate &&
    (/^\d+$/.test(candidate) ||
      (RETRY_AFTER_HTTP_DATE_PATTERNS.some((pattern) => pattern.test(candidate)) &&
        Number.isFinite(Date.parse(candidate))))
  ) {
    return candidate
  }
  return String(PLEX_RATE_LIMIT_FALLBACK_SECONDS)
}

function retryAfterSecondsForLog(retryAfter: string): number {
  const numeric = /^\d+$/.test(retryAfter)
    ? Number(retryAfter)
    : Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000)
  if (!Number.isFinite(numeric)) return PLEX_RATE_LIMIT_FALLBACK_SECONDS
  return Math.min(PLEX_RATE_LIMIT_LOG_MAX_SECONDS, Math.max(0, numeric))
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

// PIN creation lives on the CLIENT (web SPA + tvOS/iOS), never here — a
// server-side create attributed the sign-in to the host's IP and leaked it
// onto plex.tv's auth/link page. Clients POST plex.tv/api/v2/pins directly
// with the public clientId from GET /api/auth/plex/config; the backend only
// polls (below) with that same clientId, which is what finds the token.

// Poll until the PIN carries an authToken (user authorized).
export async function checkPin(pinId: number): Promise<Pin> {
  const res = await fetchWithTimeout(
    `${PLEX_BASE}/pins/${pinId}`,
    { headers: baseHeaders() },
    WAN_TIMEOUT_MS,
    'plex.checkPin',
  )
  if (res.status === 429) {
    const retryAfter = normalizedRetryAfter(res.headers.get('Retry-After'))
    console.warn(
      `[plex.checkPin] rate_limited status=429 retryAfterSeconds=${retryAfterSecondsForLog(retryAfter)}`,
    )
    throw new PlexRateLimitError(retryAfter)
  }
  if (!res.ok) {
    console.error(`[plex.checkPin] failed status=${res.status}`)
    throw new Error(`plex.checkPin failed: ${res.status}`)
  }
  const data = (await res.json()) as Pin
  // Keep only low-cardinality outcome evidence. PIN ids and the client id are
  // stable login artifacts and must never enter container logs.
  console.info(`[plex.checkPin] ok tokenPresent=${Boolean(data.authToken)}`)
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

// Yield the unescaped attribute map of every <tag .../> element in a Plex
// XML payload. The three friend-list endpoints (User/SharedServer/Account)
// all parse the same attribute shape; only the per-element mapping differs.
function* xmlElementAttrs(xml: string, tag: string): Generator<Record<string, string>> {
  for (const match of xml.matchAll(new RegExp(`<${tag}\\s+([^>]+?)\\/?>`, 'g'))) {
    const attrs: Record<string, string> = {}
    for (const a of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs[a[1]] = unescapeXml(a[2])
    }
    yield attrs
  }
}

function parseUserElements(xml: string): PlexFriend[] {
  const out: PlexFriend[] = []
  for (const attrs of xmlElementAttrs(xml, 'User')) {
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
        'X-Plex-Client-Identifier': requirePlexClientId(),
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
  for (const attrs of xmlElementAttrs(xml, 'SharedServer')) {
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
        'X-Plex-Client-Identifier': requirePlexClientId(),
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
  for (const attrs of xmlElementAttrs(xml, 'Account')) {
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
        'X-Plex-Client-Identifier': requirePlexClientId(),
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
