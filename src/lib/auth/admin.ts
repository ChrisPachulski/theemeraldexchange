import { apiUrl } from '../api/base'
import { throwApiError } from '../api/errors'
import type { AuthMode, Role } from './types'

// ── Admin allowlist API — invites + members ────────────────────────
//
// These are owner-only (requireAdmin server-side) management calls. They
// are plain credentialed fetches, mirroring DevicesPanel's standalone
// fetch-function style rather than living on the auth context — they are
// only ever called from the admin InvitesPanel, not on the hot auth path.
// The server contract is the parallel-model authZ layer: members are the
// allowlist; invites are the owner-issued grant that creates a member on
// first Apple/Plex login.

export type InviteStatus = 'active' | 'expired' | 'exhausted' | 'revoked'

/** A redacted invite row as listed for the owner. The plaintext code is
 *  NEVER returned by the list endpoint — only the freshly-created one is,
 *  exactly once, by createInvite(). */
export type InviteView = {
  code_hash_prefix: string
  issued_by: string
  label: string | null
  expires_at: string | null
  max_uses: number
  used_count: number
  created_at: string
  revoked_at: string | null
  status: InviteStatus
}

/** The one-time create response — `code` is the plaintext shown ONCE. */
export type CreatedInvite = {
  code: string
  code_hash_prefix: string
  label: string | null
  expires_at: string | null
  max_uses: number
}

export type MemberView = {
  sub: string
  display_name: string | null
  role: Role
  auth_mode: AuthMode
  invited_by: string | null
  joined_at: string
  revoked_at: string | null
  is_admin: boolean
}

async function adminJson<T>(
  path: string,
  scope: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!r.ok) await throwApiError(r, scope)
  return (await r.json()) as T
}

export async function listInvites(): Promise<InviteView[]> {
  const body = await adminJson<{ invites: InviteView[] }>(
    '/api/admin/invites',
    'list invites',
  )
  return body.invites
}

export async function createInvite(args: {
  label?: string
  expiresInDays?: number
  maxUses?: number
}): Promise<CreatedInvite> {
  return adminJson<CreatedInvite>('/api/admin/invites', 'create invite', {
    method: 'POST',
    body: JSON.stringify(args),
  })
}

export async function revokeInvite(codeHashPrefix: string): Promise<void> {
  await adminJson<{ ok: boolean }>(
    `/api/admin/invites/${encodeURIComponent(codeHashPrefix)}`,
    'revoke invite',
    { method: 'DELETE' },
  )
}

export async function listMembers(): Promise<MemberView[]> {
  const body = await adminJson<{ members: MemberView[] }>(
    '/api/admin/members',
    'list members',
  )
  return body.members
}

export async function revokeMember(sub: string): Promise<void> {
  await adminJson<{ ok: boolean }>(
    `/api/admin/members/${encodeURIComponent(sub)}`,
    'revoke member',
    { method: 'DELETE' },
  )
}
