-- 0011_device_link_codes.sql — web-claimed device pairing.
--
-- An Apple client with no Plex account signs in by showing a short code; a
-- member who is already signed in on the web (any provider: WorkOS, Google,
-- Apple, Plex) claims that code, and the device's next poll mints the same
-- device token the Plex PIN path mints. One row per code; consumed once.

CREATE TABLE IF NOT EXISTS device_link_codes (
  code             TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL,
  device_name      TEXT NOT NULL,
  device_platform  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  claimed_sub      TEXT,
  claimed_username TEXT,
  claimed_role     TEXT,
  claimed_auth_mode TEXT,
  claimed_at       INTEGER,
  consumed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS device_link_codes_by_expires ON device_link_codes(expires_at);
