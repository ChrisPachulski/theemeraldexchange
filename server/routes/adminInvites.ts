// /api/admin/invites/* and /api/admin/members/* — the owner-only allowlist
// management surface backing the SPA InvitesPanel.
//
// These are the HTTP endpoints over the membership data layer
// (server/services/invites.ts + members.ts). Both routers are gated by
// requireAdmin (mirroring adminDevices) so only an admin session can mint,
// list, or revoke invites and members. The members allowlist is the single
// shared authZ gate for BOTH the Plex and Apple login paths — these
// endpoints are how the owner grows and prunes it.
//
//   Invites (single-use codes, code shown exactly once on create):
//     GET    /api/admin/invites            — list outstanding invites (redacted)
//     POST   /api/admin/invites            — issue a new invite, returns the code
//     DELETE /api/admin/invites/:prefix    — revoke an invite by code_hash prefix
//
//   Members (the authZ allowlist):
//     GET    /api/admin/members            — list members (active + revoked)
//     DELETE /api/admin/members/:sub       — revoke a member
//
// Schema: server/migrations/server/0003_members_invites.sql.

import { Hono } from 'hono'
import { requireAdmin, type Env } from '../middleware/auth.js'
import { env } from '../env.js'
import { issueInvite, listInvites, revokeInvite } from '../services/invites.js'
import { listMembers, revokeMember, type Member } from '../services/members.js'

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export const adminInvites = new Hono<Env>()

adminInvites.use('*', requireAdmin)

adminInvites.get('/', (c) => {
  // listInvites returns the redacted InviteSummary[] — never the plaintext
  // code, never the full code_hash. Shape matches the SPA InviteView.
  return c.json({ invites: listInvites() })
})

adminInvites.post('/', async (c) => {
  const session = c.get('session')
  const body = (await c.req.json().catch(() => null)) as
    | { label?: unknown; expiresInDays?: unknown; maxUses?: unknown }
    | null

  // All fields optional; validate the ones supplied. A bad type fails the
  // request rather than silently defaulting, so the owner never thinks they
  // set an expiry/limit that didn't take.
  const label =
    body?.label === undefined || body?.label === null
      ? null
      : typeof body.label === 'string'
        ? body.label.trim().slice(0, 120) || null
        : undefined
  if (label === undefined) {
    return c.json({ error: 'invalid_body', message: 'label must be a string' }, 400)
  }

  let expiresInDays: number | null | undefined = undefined
  if (body?.expiresInDays !== undefined) {
    if (body.expiresInDays === null) {
      expiresInDays = null
    } else if (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)) {
      expiresInDays = body.expiresInDays
    } else {
      return c.json({ error: 'invalid_body', message: 'expiresInDays must be a number or null' }, 400)
    }
  }

  let maxUses: number | undefined = undefined
  if (body?.maxUses !== undefined) {
    if (typeof body.maxUses === 'number' && Number.isInteger(body.maxUses) && body.maxUses >= 1) {
      maxUses = body.maxUses
    } else {
      return c.json({ error: 'invalid_body', message: 'maxUses must be an integer >= 1' }, 400)
    }
  }

  // issueInvite returns the plaintext code exactly once — this is the only
  // place it is ever surfaced. Shape matches the SPA CreatedInvite.
  const created = issueInvite(session.sub, { label, expiresInDays, maxUses })
  return c.json(created, 201)
})

adminInvites.delete('/:prefix', (c) => {
  const prefix = c.req.param('prefix')
  const revoked = revokeInvite(prefix)
  if (!revoked) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const adminMembers = new Hono<Env>()

adminMembers.use('*', requireAdmin)

// The SPA MemberView adds an `is_admin` flag the bare members row lacks. A
// member is "admin" when their sub is an ADMIN_SUBS owner-bootstrap entry
// (these subs are implicitly allowed without a row) OR their stored role is
// 'admin'. The flag drives the "owner" badge and suppresses the Revoke
// button so the owner can't lock themselves out.
function toMemberView(m: Member): Member & { is_admin: boolean } {
  return { ...m, is_admin: env.adminSubs.includes(m.sub) || m.role === 'admin' }
}

adminMembers.get('/', (c) => {
  const members = listMembers().map(toMemberView)

  // Surface ADMIN_SUBS owner(s) even when they have no members row yet (the
  // bootstrap path: an admin sub is implicitly allowed and may never have
  // redeemed an invite). Without this the owner wouldn't appear in their own
  // members list until first login wrote a row — and they'd have no row to
  // begin with. Synthesize a minimal admin view for any ADMIN_SUBS sub not
  // already present.
  const present = new Set(members.map((m) => m.sub))
  for (const sub of env.adminSubs) {
    if (present.has(sub)) continue
    members.unshift({
      sub,
      display_name: null,
      role: 'admin',
      auth_mode: sub.startsWith('apple:') ? 'apple' : 'plex',
      invited_by: null,
      joined_at: '',
      revoked_at: null,
      is_admin: true,
    })
  }

  return c.json({ members })
})

adminMembers.delete('/:sub', (c) => {
  const sub = c.req.param('sub')
  // Never let an admin revoke an ADMIN_SUBS owner bootstrap sub — that sub is
  // implicitly allowed regardless of the row, so revoking would be a no-op
  // that misleads the UI. Fail explicitly instead.
  if (env.adminSubs.includes(sub)) {
    return c.json({ error: 'cannot_revoke_owner' }, 409)
  }
  const revoked = revokeMember(sub)
  if (!revoked) return c.json({ error: 'not_found' }, 404)
  return c.json({ ok: true })
})
