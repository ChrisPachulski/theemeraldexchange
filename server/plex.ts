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

// People the owner has invited to their Plex server (the "Manage Library
// Access" list). The legacy XML endpoint at plex.tv/api/users is the
// canonical source — it's what python-plexapi's MyPlexAccount.users()
// uses and it includes every invitee regardless of accept-state, which
// is what an admin actually wants to see on the Users page.
//
// We intentionally do NOT use /api/v2/friends — that's the Plex social
// graph (mutual friend relationships), not server shares, and is often
// empty even when the owner has shared with many users.
export type PlexFriend = {
  id: number
  username: string
  title?: string
  email?: string | null
  thumb?: string | null
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
    })
  }
  return out
}

export async function listInvitedUsers(authToken: string): Promise<PlexFriend[]> {
  // NOTE: this is the legacy XML endpoint on the bare plex.tv host, NOT
  // the v2 JSON tree — so the URL doesn't go through PLEX_BASE.
  const res = await fetch('https://plex.tv/api/users', {
    headers: {
      'X-Plex-Product': 'The Emerald Exchange',
      'X-Plex-Client-Identifier': env.plexClientId,
      'X-Plex-Token': authToken,
      Accept: 'application/xml',
    },
  })
  if (!res.ok) throw new Error(`plex.listInvitedUsers failed: ${res.status}`)
  const xml = await res.text()
  return parseUserElements(xml)
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
