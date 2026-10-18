-- 0003_link_tombstones.sql
-- Adds soft-delete support to iptv_title_link per §11.1.
-- removed_at is NULL for active rows; set to ISO-8601 timestamp when the
-- upstream item is de-listed.  Rows are hard-deleted after 14 days.

ALTER TABLE iptv_title_link ADD COLUMN removed_at TEXT NULL;

-- Partial index covering only active (non-tombstoned) rows.
-- tagIptvAvailability queries WHERE tmdb_id IN (...) AND removed_at IS NULL;
-- without this index SQLite would scan tombstoned rows after the existing
-- iptv_link_by_tmdb index lookup, degrading as tombstones accumulate.
CREATE INDEX iptv_link_active_by_tmdb ON iptv_title_link(tmdb_kind, tmdb_id) WHERE removed_at IS NULL;

ANALYZE iptv_title_link;
