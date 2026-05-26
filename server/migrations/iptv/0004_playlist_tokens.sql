-- 0004_playlist_tokens.sql — persistent playlist token registry for revocation (§6.2).
-- Each row represents one issued playlist token. The verifier checks this table on
-- every playlist.m3u request; a revoked_at IS NOT NULL row is a hard reject.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS iptv_playlist_tokens (
  jti         TEXT PRIMARY KEY,
  sub         TEXT NOT NULL,
  device_name TEXT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT NULL
);

-- Full index retained for backward compat with any existing DB that already has it.
CREATE INDEX IF NOT EXISTS iptv_playlist_tokens_sub ON iptv_playlist_tokens(sub);

-- Partial index for the hot revocation-check path: WHERE sub = ? AND revoked_at IS NULL.
-- SQLite supports partial indexes (WHERE clause on CREATE INDEX) since 3.8.0.
CREATE INDEX IF NOT EXISTS iptv_playlist_tokens_active
  ON iptv_playlist_tokens(sub, revoked_at) WHERE revoked_at IS NULL;
