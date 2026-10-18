-- 0003_members_invites.sql — authZ allowlist (members) + owner-issued invites.
--
-- Separates authN (Apple/Plex prove identity) from authZ (this allowlist
-- proves access). A verified sub is allowed iff it has a members row with
-- revoked_at IS NULL, OR it is in env ADMIN_SUBS (owner bootstrap, enforced
-- in the service layer, not this schema).
--
-- Additive only — not destructive, so no §7.4 backup gate applies. Version 3
-- auto-applies on boot via openDb's schema_migrations ledger.

PRAGMA foreign_keys = ON;

-- The allowlist. One row per authorized principal, keyed by the namespaced
-- sub (apple:<subject> | plex:<id> | local:<ulid>) — the same form parseSub
-- emits and the session cookie carries. No foreign key to invites: a member
-- created by bootstrap (ADMIN_SUBS) has no invite, and an invite may be
-- revoked/deleted after redemption without orphaning the member.
CREATE TABLE IF NOT EXISTS members (
  sub           TEXT PRIMARY KEY,        -- 'apple:...' | 'plex:...' | 'local:...'
  display_name  TEXT,                    -- best-effort label (Plex username / Apple full name at first login); nullable
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('plex','local','apple')),
  invited_by    TEXT,                    -- sub of the admin who issued the redeemed invite; NULL for bootstrap members
  joined_at     TEXT NOT NULL,           -- ISO-8601, first successful redeem/login
  revoked_at    TEXT                     -- non-NULL == access revoked; row kept for audit
);

CREATE INDEX IF NOT EXISTS members_by_revoked ON members(revoked_at);
CREATE INDEX IF NOT EXISTS members_by_invited_by ON members(invited_by);

-- Owner-issued invite codes. The plaintext code is shown to the admin exactly
-- once at creation and never stored; only its sha256 hash is persisted. The
-- code is 128-bit high-entropy random, so sha256 (not a slow KDF) is the
-- correct hash at rest — there is nothing to brute-force.
CREATE TABLE IF NOT EXISTS invites (
  code_hash     TEXT PRIMARY KEY,        -- sha256(code) hex
  issued_by     TEXT NOT NULL,           -- sub of the admin who created it
  label         TEXT,                    -- human note: "Mom's iPad", nullable
  expires_at    TEXT,                    -- ISO-8601; NULL == no expiry (the route sets a default)
  max_uses      INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count    INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at    TEXT NOT NULL,
  revoked_at    TEXT                     -- non-NULL == invite disabled
);

CREATE INDEX IF NOT EXISTS invites_by_issued_by ON invites(issued_by);
CREATE INDEX IF NOT EXISTS invites_by_expires ON invites(expires_at);
