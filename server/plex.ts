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

// People with shared access to the home Plex server, from the owner's
// perspective. plex.tv's /v2/friends endpoint is a thin list of accounts
// the token-holder is friends with on Plex; combined with the owner's
// own profile this is what the dashboard surfaces on the Users page.
export type PlexFriend = {
  id: number
  username: string
  title?: string
  email?: string | null
  thumb?: string | null
  status?: string
}
export async function listFriends(authToken: string): Promise<PlexFriend[]> {
  const res = await fetch(`${PLEX_BASE}/friends`, {
    headers: { ...baseHeaders(), 'X-Plex-Token': authToken },
  })
  if (!res.ok) throw new Error(`plex.listFriends failed: ${res.status}`)
  return (await res.json()) as PlexFriend[]
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
