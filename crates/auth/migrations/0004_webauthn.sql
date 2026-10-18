-- 0004_webauthn.sql — passkey (WebAuthn / FIDO2) credentials + ceremony challenges.
--
-- Passkeys are the cross-platform, password-free identity spine that replaces
-- reliance on Plex's login. A passkey authenticates against a SELF-OWNED user
-- record: sub `local:<ulid>` (the `local:` namespace already defined in the
-- M1.5 contract §8.1). AuthN (the passkey proves who you are) stays decoupled
-- from authZ (the members allowlist from 0003 decides if you're in) — a
-- registered passkey whose member row is revoked is denied, same as any other
-- provider.
--
-- Additive only — no §7.4 backup gate. Auto-applies on boot via the
-- schema_migrations ledger.

PRAGMA foreign_keys = ON;

-- One row per registered passkey credential. A single `local:<ulid>` user may
-- register multiple passkeys (phone + laptop + security key), so sub is NOT
-- unique here — credential_id is the PK.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id  TEXT PRIMARY KEY,        -- base64url of the raw credential id
  sub            TEXT NOT NULL,           -- 'local:<ulid>' — the owning user
  public_key     BLOB NOT NULL,           -- COSE public key bytes (from @simplewebauthn)
  counter        INTEGER NOT NULL DEFAULT 0, -- signature counter (clone/replay detection)
  transports     TEXT,                    -- JSON array of AuthenticatorTransport, nullable
  device_label   TEXT,                    -- user-facing name ("Chris's iPhone"), nullable
  backed_up      INTEGER NOT NULL DEFAULT 0, -- 1 == synced/multi-device passkey (iCloud/Google)
  created_at     TEXT NOT NULL,           -- ISO-8601
  last_used_at   TEXT                     -- ISO-8601, updated on each successful assertion
);

CREATE INDEX IF NOT EXISTS webauthn_credentials_by_sub ON webauthn_credentials(sub);

-- Short-lived server-side challenge store for the two ceremonies. The client
-- receives an opaque challenge_id (returned in the options JSON) and echoes it
-- back at verify time; the server looks up and single-use-consumes the row.
-- Stored server-side (not a stateless cookie) so the random challenge can be
-- matched exactly and so a registration's pending sub/handle survive between
-- the two round-trips without trusting the client to carry them.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_id   TEXT PRIMARY KEY,        -- random opaque id handed to the client
  challenge      TEXT NOT NULL,           -- base64url challenge bytes
  ceremony       TEXT NOT NULL CHECK (ceremony IN ('register','login')),
  pending_sub    TEXT,                    -- register: the freshly-minted local:<ulid>; login: NULL
  pending_handle TEXT,                    -- register: chosen display name; login: NULL
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL            -- ISO-8601; rows past this are swept and rejected
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_by_expires ON webauthn_challenges(expires_at);
