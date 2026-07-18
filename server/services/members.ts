// server/services/members.ts — authZ allowlist (the `members` table).
//
// This is the AUTHORIZATION data layer. It is provider-agnostic: it never
// proves identity, it only answers "is this already-verified sub allowed?".
// authN (SIWA-JWKS verify / Plex PIN verify) happens upstream and hands a
// parseSub-validated `sub` to these functions.
//
// A sub is allowed iff it has a `members` row with revoked_at IS NULL.
// New memberships are minted by redeemInvite (see invites.ts) or by the
// owner-convenience addMember path; this module owns the read + revoke +
// login-touch surface plus the row type shared with invites.ts.
//
// Schema: server/migrations/server/0003_members_invites.sql.

import { serverDb } from './serverDb.js'
import { parseSub, isValidSub } from './sub.js'
import type { AuthMode } from '../session.js'

/** A row in the `members` allowlist. */
export interface Member {
  sub: string
  display_name: string | null
  role: 'admin' | 'user'
  auth_mode: AuthMode
  invited_by: string | null
  joined_at: string
  revoked_at: string | null
}

/**
 * Look up an active member by sub.
 *
 * Returns the row when the sub has a members row that is NOT revoked.
 * Returns null when the sub is unknown OR has been revoked (a revoked row is
 * kept for audit but is not "a member" for authZ purposes). This is the hot
 * per-request authZ check — a single indexed PK lookup.
 *
 * The caller is expected to pass a parseSub-validated sub. We re-validate
 * defensively so a malformed value can never match a row (fail closed).
 */
export function isMember(sub: string): Member | null {
  if (!isValidSub(sub)) return null

  const row = serverDb()
    .raw.prepare(
      `SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at
         FROM members
        WHERE sub = ?`,
    )
    .get(sub) as Member | undefined

  if (!row) return null
  if (row.revoked_at !== null) return null
  return row
}

/**
 * List all members (active and revoked) for the admin UI, newest first.
 * Revoked rows ARE included so the owner can audit / re-grant.
 */
export function listMembers(): Member[] {
  return serverDb()
    .raw.prepare(
      `SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at
         FROM members
        ORDER BY joined_at DESC`,
    )
    .all() as Member[]
}

/**
 * Owner-convenience: add a member directly, with no invite.
 *
 * Returns the created row, or null if the sub already has a (non-revoked)
 * members row — callers map null to 409 already_member. A previously revoked
 * sub is re-granted (revoked_at cleared, joined_at refreshed).
 *
 * Throws `sub_invalid_format` (from parseSub) on a malformed sub so a bad
 * value fails closed at the boundary rather than inserting garbage.
 */
export function addMember(opts: {
  sub: string
  displayName?: string | null
  role?: 'admin' | 'user'
  authMode: AuthMode
  invitedBy?: string | null
}): Member | null {
  // parseSub throws on a malformed sub — let it propagate (fail closed).
  parseSub(opts.sub)

  const db = serverDb()
  const now = new Date().toISOString()
  const role = opts.role ?? 'user'
  const displayName = opts.displayName ?? null
  const invitedBy = opts.invitedBy ?? null

  const tx = db.raw.transaction((): Member | null => {
    const existing = db.raw
      .prepare(`SELECT revoked_at FROM members WHERE sub = ?`)
      .get(opts.sub) as { revoked_at: string | null } | undefined

    if (existing && existing.revoked_at === null) {
      return null // already an active member
    }

    if (existing) {
      // Re-grant a previously revoked member.
      db.raw
        .prepare(
          `UPDATE members
              SET revoked_at = NULL,
                  joined_at = ?,
                  display_name = ?,
                  role = ?,
                  auth_mode = ?,
                  invited_by = ?
            WHERE sub = ?`,
        )
        .run(now, displayName, role, opts.authMode, invitedBy, opts.sub)
    } else {
      db.raw
        .prepare(
          `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(opts.sub, displayName, role, opts.authMode, invitedBy, now)
    }

    return getMemberRow(opts.sub)
  })

  return tx()
}

export type SafeMemberRevocation =
  | 'revoked'
  | 'not_found'
  | 'owner'
  | 'self'
  | 'final_admin'

/**
 * Revoke a member while preserving at least one durable administrator.
 *
 * The immediate transaction acquires the server DB write lock before reading
 * the administrator set, so two independent revocations cannot both decide
 * they are leaving another admin behind. ADMIN_SUBS entries are immutable
 * authorities even without a row; a Set prevents double-counting one that
 * also has an active DB-backed admin row.
 */
export function revokeMemberSafely(opts: {
  targetSub: string
  actorSub: string
  immutableAdminSubs: readonly string[]
}): SafeMemberRevocation {
  if (!isValidSub(opts.targetSub)) return 'not_found'

  const immutableAdmins = new Set(opts.immutableAdminSubs.filter(isValidSub))
  if (immutableAdmins.has(opts.targetSub)) return 'owner'
  if (opts.targetSub === opts.actorSub) return 'self'

  const db = serverDb().raw
  const tx = db.transaction((): SafeMemberRevocation => {
    const target = db
      .prepare(`SELECT role, revoked_at FROM members WHERE sub = ?`)
      .get(opts.targetSub) as
      | { role: 'admin' | 'user'; revoked_at: string | null }
      | undefined
    if (!target || target.revoked_at !== null) return 'not_found'

    if (target.role === 'admin') {
      const activeDbAdmins = db
        .prepare(`SELECT sub FROM members WHERE role = 'admin' AND revoked_at IS NULL`)
        .all() as Array<{ sub: string }>
      const remainingAuthorities = new Set(immutableAdmins)
      for (const { sub } of activeDbAdmins) remainingAuthorities.add(sub)
      if (remainingAuthorities.size <= 1) return 'final_admin'
    }

    const changed = db
      .prepare(
        `UPDATE members
            SET revoked_at = ?
          WHERE sub = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), opts.targetSub)
    return changed.changes === 1 ? 'revoked' : 'not_found'
  })

  return tx.immediate()
}

/**
 * Touch an EXISTING active member's display_name on a successful login. Never
 * creates a new membership (that is redeemInvite's job) and never resurrects a
 * revoked member. No-op when the sub is not an active member, or when
 * displayName is null (don't clobber a stored name with nothing).
 */
export function recordMemberLogin(sub: string, displayName: string | null): void {
  if (!isValidSub(sub)) return
  if (displayName === null) return

  serverDb()
    .raw.prepare(
      `UPDATE members
          SET display_name = ?
        WHERE sub = ? AND revoked_at IS NULL`,
    )
    .run(displayName, sub)
}

/** Internal: fetch a row regardless of revoked state (used post-write). */
function getMemberRow(sub: string): Member | null {
  const row = serverDb()
    .raw.prepare(
      `SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at
         FROM members
        WHERE sub = ?`,
    )
    .get(sub) as Member | undefined
  return row ?? null
}
