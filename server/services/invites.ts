// server/services/invites.ts — owner-issued invite codes (authZ grant path).
//
// An invite is the mechanism by which a NEW member is added to the allowlist
// (members.ts). The owner issues a code; a first successful SIWA/Plex auth
// that presents a valid, unredeemed, unexpired, unrevoked code becomes an
// allowed member, atomically incrementing the invite's used_count.
//
// Security:
//   - Codes carry 128 bits of entropy (crypto.randomBytes(16)).
//   - Only sha256(code) hex is persisted (code_hash PK). The plaintext is
//     returned to the admin exactly once at issue time and never stored or
//     logged. SHA-256 (not a slow KDF) is correct: the input is high-entropy
//     random, so there is nothing to brute-force.
//   - Redeem runs in a single IMMEDIATE transaction with a
//     `used_count < max_uses` guard so two concurrent redeems cannot
//     over-spend a single-use code.
//   - Lookup is by sha256(code) via the PK index: the attacker-controlled
//     plaintext is hashed before any DB compare, so there is no plaintext
//     timing oracle. timingSafeEqual is used where an explicit fixed-length
//     compare is still wanted.
//
// Schema: server/migrations/server/0003_members_invites.sql.

import { createHash, randomBytes } from 'node:crypto'
import { serverDb } from './serverDb.js'
import { parseSub, isValidSub } from './sub.js'
import { constantTimeEqual } from './secrets.js'
import type { Member } from './members.js'
import type { AuthMode } from '../session.js'

const DEFAULT_EXPIRES_IN_DAYS = 14
const DEFAULT_MAX_USES = 1

/** A row in the `invites` table (never carries the plaintext code). */
export interface Invite {
  code_hash: string
  issued_by: string
  label: string | null
  expires_at: string | null
  max_uses: number
  used_count: number
  created_at: string
  revoked_at: string | null
}

/** Derived lifecycle status for the admin invite list. */
export type InviteStatus = 'active' | 'expired' | 'exhausted' | 'revoked'

/** The shape returned by listInvites — never the full code_hash, never the code. */
export interface InviteSummary {
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

export interface IssueInviteResult {
  /** Plaintext code — shown to the admin ONCE, never persisted or logged. */
  code: string
  code_hash_prefix: string
  label: string | null
  expires_at: string | null
  max_uses: number
}

export type RedeemResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'invalid' | 'expired' | 'exhausted' | 'revoked' }

/** sha256 hex of an invite code. */
function hashCode(code: string): string {
  return createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex')
}

/** First 8 hex chars of a code_hash — the only opaque id safe to log/return. */
function hashPrefix(codeHash: string): string {
  return codeHash.slice(0, 8)
}

/**
 * Issue a new invite. Generates a 128-bit code, stores only its sha256 hash,
 * and returns the plaintext code exactly once.
 *
 * `adminSub` is the issuing admin's namespaced sub (parseSub-validated here so
 * a bad caller value fails closed). expiresInDays defaults to 14; maxUses to 1.
 */
export function issueInvite(
  adminSub: string,
  opts: { label?: string | null; expiresInDays?: number | null; maxUses?: number } = {},
): IssueInviteResult {
  parseSub(adminSub) // fail closed on a malformed issuer sub

  const label = opts.label ?? null
  const maxUses = Math.max(1, Math.floor(opts.maxUses ?? DEFAULT_MAX_USES))
  // expiresInDays: a finite number sets an expiry that many days out (a
  // negative value yields an already-past expiry — a legitimate pre-expired
  // invite); explicit null disables expiry. undefined falls back to the default.
  const expiresInDays =
    opts.expiresInDays === undefined ? DEFAULT_EXPIRES_IN_DAYS : opts.expiresInDays

  // 16 bytes = 128 bits of entropy. Base64url for a compact, url-safe,
  // human-transcribable code with no padding.
  const code = randomBytes(16).toString('base64url')
  const codeHash = hashCode(code)

  const now = new Date()
  const expiresAt =
    expiresInDays === null
      ? null
      : new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()

  serverDb()
    .raw.prepare(
      `INSERT INTO invites (code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
    )
    .run(codeHash, adminSub, label, expiresAt, maxUses, now.toISOString())

  return {
    code,
    code_hash_prefix: hashPrefix(codeHash),
    label,
    expires_at: expiresAt,
    max_uses: maxUses,
  }
}

/**
 * Redeem an invite code for a verified sub, creating (or re-granting) a
 * members row in a single atomic transaction.
 *
 * Returns:
 *   { ok: true, created: true }   — a new (or re-granted) member was minted.
 *   { ok: true, created: false }  — sub was ALREADY an active member; the
 *                                   code is NOT burned (idempotent re-login).
 *   { ok: false, reason }         — invalid | expired | exhausted | revoked.
 *
 * `sub` must be a verified, parseSub-valid namespaced sub. authMode/displayName
 * are recorded on the new member row.
 */
export function redeemInvite(
  code: string,
  sub: string,
  displayName: string | null,
  authMode: AuthMode,
): RedeemResult {
  if (!isValidSub(sub)) return { ok: false, reason: 'invalid' }

  const codeHash = hashCode(code)
  const db = serverDb()
  const nowIso = new Date().toISOString()

  // IMMEDIATE transaction: take the write lock up front so two concurrent
  // redeems of a single-use code serialise and the used_count guard holds.
  const tx = db.raw.transaction((): RedeemResult => {
    const invite = db.raw
      .prepare(
        `SELECT code_hash, issued_by, expires_at, max_uses, used_count, revoked_at
           FROM invites
          WHERE code_hash = ?`,
      )
      .get(codeHash) as
      | Pick<Invite, 'code_hash' | 'issued_by' | 'expires_at' | 'max_uses' | 'used_count' | 'revoked_at'>
      | undefined

    if (!invite) return { ok: false, reason: 'invalid' }

    // Constant-time confirm of the hash match (PK lookup already matched; this
    // is belt-and-suspenders against any future non-PK lookup path).
    if (!constantTimeEqual(invite.code_hash, codeHash)) {
      return { ok: false, reason: 'invalid' }
    }

    if (invite.revoked_at !== null) return { ok: false, reason: 'revoked' }
    if (invite.expires_at !== null && invite.expires_at < nowIso) {
      return { ok: false, reason: 'expired' }
    }

    const member = db.raw
      .prepare(`SELECT revoked_at FROM members WHERE sub = ?`)
      .get(sub) as { revoked_at: string | null } | undefined

    // Already an active member → idempotent; do NOT burn a use.
    if (member && member.revoked_at === null) {
      return { ok: true, created: false }
    }

    // From here we WILL consume a use — enforce the cap.
    if (invite.used_count >= invite.max_uses) {
      return { ok: false, reason: 'exhausted' }
    }

    if (member) {
      // Previously revoked member: this invite re-grants access. Attribute
      // the re-grant to this invite's issuer (verdict A7: the schema
      // provisioned + indexed members.invited_by but the redeem path left
      // it NULL forever).
      db.raw
        .prepare(
          `UPDATE members
              SET revoked_at = NULL,
                  joined_at = ?,
                  display_name = ?,
                  auth_mode = ?,
                  invited_by = ?
            WHERE sub = ?`,
        )
        .run(nowIso, displayName, authMode, invite.issued_by, sub)
    } else {
      db.raw
        .prepare(
          `INSERT INTO members (sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at)
           VALUES (?, ?, 'user', ?, ?, ?, NULL)`,
        )
        .run(sub, displayName, authMode, invite.issued_by, nowIso)
    }

    // Burn one use, guarded so a concurrent redeem cannot over-spend.
    const spent = db.raw
      .prepare(
        `UPDATE invites
            SET used_count = used_count + 1
          WHERE code_hash = ? AND used_count < max_uses`,
      )
      .run(codeHash)

    if (spent.changes === 0) {
      // Lost the race for the last use — abort the whole txn.
      throw new ExhaustedRace()
    }

    return { ok: true, created: true }
  })

  try {
    return tx.immediate()
  } catch (err) {
    if (err instanceof ExhaustedRace) return { ok: false, reason: 'exhausted' }
    throw err
  }
}

/** Sentinel used to roll back a redeem transaction that lost the use-count race. */
class ExhaustedRace extends Error {}

/**
 * List invites for the admin UI, newest first. Never returns the plaintext
 * code or the full code_hash — only an 8-char opaque prefix.
 */
export function listInvites(): InviteSummary[] {
  const rows = serverDb()
    .raw.prepare(
      `SELECT code_hash, issued_by, label, expires_at, max_uses, used_count, created_at, revoked_at
         FROM invites
        ORDER BY created_at DESC`,
    )
    .all() as Invite[]

  const nowIso = new Date().toISOString()
  return rows.map(r => ({
    code_hash_prefix: hashPrefix(r.code_hash),
    issued_by: r.issued_by,
    label: r.label,
    expires_at: r.expires_at,
    max_uses: r.max_uses,
    used_count: r.used_count,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    status: statusOf(r, nowIso),
  }))
}

/**
 * Revoke an invite identified by an 8-char (or longer) code_hash prefix.
 * Refuses ambiguous prefixes (more than one match) and already-revoked /
 * unknown invites.
 *
 * Returns true if exactly one active invite was revoked, false otherwise.
 */
export function revokeInvite(codeHashPrefix: string): boolean {
  if (!/^[0-9a-f]{1,64}$/.test(codeHashPrefix)) return false

  const db = serverDb()
  const matches = db.raw
    .prepare(`SELECT code_hash, revoked_at FROM invites WHERE code_hash LIKE ? ESCAPE '\\'`)
    .all(`${escapeLike(codeHashPrefix)}%`) as Array<{ code_hash: string; revoked_at: string | null }>

  if (matches.length !== 1) return false // unknown or ambiguous
  if (matches[0].revoked_at !== null) return false // already revoked

  const info = db.raw
    .prepare(`UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), matches[0].code_hash)

  return info.changes > 0
}

/** Derive an invite's lifecycle status. */
function statusOf(r: Invite, nowIso: string): InviteStatus {
  if (r.revoked_at !== null) return 'revoked'
  if (r.expires_at !== null && r.expires_at < nowIso) return 'expired'
  if (r.used_count >= r.max_uses) return 'exhausted'
  return 'active'
}

/** Escape SQLite LIKE wildcards in a (validated-hex) prefix. Defensive. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => `\\${m}`)
}


// Re-export Member so consumers importing the redeem surface can type the
// resulting allowlist row without a second import.
export type { Member }
