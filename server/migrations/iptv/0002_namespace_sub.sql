-- 0002_namespace_sub.sql — backfill §8.2 namespace prefix (M1.5 D7)
--
-- M1 stored raw Plex user ids as the `sub` column value. This migration
-- prefixes every bare (un-namespaced) value with 'plex:' so the column
-- matches the §8.1 `<provider>:<id>` invariant going forward.
--
-- The WHERE guard (`sub NOT LIKE '%:%'`) makes this idempotent: already-
-- prefixed rows from new logins post-D7 are left untouched.

BEGIN;
UPDATE iptv_favorites     SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE iptv_watch_history SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
COMMIT;
