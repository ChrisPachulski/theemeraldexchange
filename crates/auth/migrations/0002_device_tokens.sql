-- 0002_device_tokens.sql — D13 device-token registration tables.
--
-- §3.4 verbatim schema. Verifier check order:
--   1. JWE decrypts under a known kid.
--   2. Claims pass aud/iss/role/auth_mode validation.
--   3. A `device_tokens` row exists with this jti (catches
--      restored-from-backup tokens after data-dir wipe).
--   4. The jti is NOT in `device_token_revocations`.
--
-- device_name is sourced at mint time from the pairing body
-- (Apple device name) and is mutable via admin / self rename routes
-- — it is NOT in the JWE.

CREATE TABLE IF NOT EXISTS device_tokens (
  jti               TEXT PRIMARY KEY,
  sub               TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  device_name       TEXT NOT NULL,                  -- mutable; updated via admin UI
  platform          TEXT NOT NULL,
  server_id         TEXT NOT NULL,
  kid               TEXT NOT NULL DEFAULT 'device-v1',
  issued_at         TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  last_seen_at      TEXT,                            -- updated on every authenticated request
  last_seen_version TEXT                             -- from X-App-Version header
);

CREATE INDEX IF NOT EXISTS device_tokens_by_sub ON device_tokens(sub);
CREATE INDEX IF NOT EXISTS device_tokens_by_device_id ON device_tokens(device_id);
CREATE INDEX IF NOT EXISTS device_tokens_by_expires ON device_tokens(expires_at);

CREATE TABLE IF NOT EXISTS device_token_revocations (
  jti        TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,
  reason     TEXT NOT NULL
);
