-- 0001_init.sql — server identity and cross-cutting server state.
--
-- Intentionally NOT under migrations/iptv/ to avoid migrator glob collision.
-- This DB persists server identity and state that must survive IPTV_DISABLED builds.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS server_state (
  key            TEXT PRIMARY KEY,
  value          TEXT NOT NULL,
  ts             TEXT NOT NULL,
  last_backup_at TEXT NULL
);
