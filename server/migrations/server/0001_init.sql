-- 0001_init.sql — server.db bootstrap (D5 + D8b).
--
-- D5 (impl-d5-server-db) owns this file's full schema including server_id generation.
-- D8b adds last_backup_at to server_state so DESTRUCTIVE migration enforcement works.
-- Merge will reconcile if D5 writes a fuller version.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS server_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- last_backup_at: ISO-8601 timestamp of the most recent successful POST /api/admin/backup.
-- Required by D8b DESTRUCTIVE migration enforcement (§7.4).
-- D15 (adminBackup route) updates this field on every successful backup.
-- Value is absent until the first backup is taken.
