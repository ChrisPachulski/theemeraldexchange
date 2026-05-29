// server/services/membership.ts — the authZ FACADE shared by both login
// paths (Plex + Apple) and the per-request session gate.
//
// This module is the seam between the routes layer (server/auth.ts,
// server/services/sessionGate.ts) and the membership data layer
// (members.ts = the `members` allowlist, invites.ts = owner-issued
// invites). The routes/gate import a single provider-agnostic surface —
// `memberStatus` + `redeemInvite` — and never reach into the underlying
// tables directly. Keeping the facade here means the Apple and Plex paths
// converge on EXACTLY the same authZ decision.
//
// Schema: server/migrations/server/0003_members_invites.sql.

import { env } from '../env.js'
import { serverDb } from './serverDb.js'
import { parseSub } from './sub.js'

// Re-export the invite-redeem surface unchanged so callers can import the
// authZ decision (`memberStatus`) and the membership-minting side
// (`redeemInvite`) from one module. redeemInvite already validates the
// sub, takes the write lock, and enforces the single-use guard.
export { redeemInvite } from './invites.js'
export type { RedeemResult } from './invites.js'

/** The provider-agnostic authZ verdict for an already-identity-verified sub. */
export type MemberStatus = 'allowed' | 'revoked' | 'not_member'

/**
 * The single authoritative authZ decision: "is this verified sub allowed?".
 *
 *   - 'allowed'    — the sub is an ADMIN_SUBS owner-bootstrap entry, OR it has
 *                    an active (non-revoked) `members` row.
 *   - 'revoked'    — the sub has a `members` row whose access was revoked.
 *                    The caller (sessionGate) cascades device-token revocation
 *                    so paired Apple/tvOS tokens drop on their next request.
 *   - 'not_member' — the sub has no `members` row at all.
 *
 * ADMIN_SUBS is short-circuited to 'allowed' FIRST (before any DB read) so the
 * operator's own Apple/Plex sub never needs an invite or a members row to log
 * in — this is the owner bootstrap. A malformed sub fails closed to
 * 'not_member'.
 *
 * The caller is expected to pass a parseSub-validated namespaced sub; we
 * re-validate defensively so a bad value can never match a row.
 */
export function memberStatus(sub: string): MemberStatus {
  if (!isValidSub(sub)) return 'not_member'

  // Owner bootstrap: ADMIN_SUBS are implicitly allowed without an invite or
  // a members row. env.adminSubs is the parseSub-validated namespaced form,
  // so an exact match is safe and sufficient. Default to [] defensively so a
  // partial env (older test stub) can never throw in this auth hot path.
  if ((env.adminSubs ?? []).includes(sub)) return 'allowed'

  // We query the row directly (not members.isMember, which collapses a
  // revoked row to null) so we can distinguish 'revoked' from 'not_member'.
  const row = serverDb()
    .raw.prepare(`SELECT revoked_at FROM members WHERE sub = ?`)
    .get(sub) as { revoked_at: string | null } | undefined

  if (row) return row.revoked_at === null ? 'allowed' : 'revoked'

  // UN-BOOTSTRAPPED FALL-THROUGH (preserves the legacy bootstrap-mode that
  // reconcileSession used to key off `!env.plexServerId`). An install that
  // has configured NO authZ gate at all — no PLEX_SERVER_ID, no ADMIN_SUBS,
  // Sign in with Apple not configured — AND has no members rows yet is a
  // fresh / single-operator install with nothing to enforce against. In that
  // state a verified identity is admitted, exactly as before, so the operator
  // isn't locked out of their own freshly-deployed server before they've had
  // a chance to seed the allowlist.
  //
  // The moment ANY gate is configured (PLEX_SERVER_ID set, ADMIN_SUBS set,
  // Apple configured) OR the first members row exists, this branch stops
  // firing and the allowlist becomes strictly authoritative — a sub with no
  // row is 'not_member' and denied. So enabling invitation-only access is a
  // one-way door: seed one gate and the fall-through is gone for good.
  if (isAuthzBootstrapped()) return 'not_member'
  return 'allowed'
}

/**
 * True once the install has SOME authZ gate to enforce against: a configured
 * Plex server scope, an ADMIN_SUBS owner-bootstrap, Sign in with Apple, or at
 * least one members row. Until then the install is un-bootstrapped and
 * memberStatus falls open (see the note in memberStatus).
 */
function isAuthzBootstrapped(): boolean {
  if (env.plexServerId) return true
  if ((env.adminSubs ?? []).length > 0) return true
  if (env.appleClientId) return true
  const anyMember = serverDb()
    .raw.prepare(`SELECT 1 FROM members LIMIT 1`)
    .get() as unknown
  return anyMember !== undefined
}

/** True when `sub` is a syntactically valid namespaced sub. */
function isValidSub(sub: string): boolean {
  try {
    parseSub(sub)
    return true
  } catch {
    return false
  }
}
