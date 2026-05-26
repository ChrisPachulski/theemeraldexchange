-- 0006_namespace_sub.sql — backfill §8.2 namespace prefix (M1.5 D7)
--
-- M1 stored raw Plex user ids as the `sub` column value in exchange.db.
-- This migration prefixes every bare (un-namespaced) value with 'plex:'
-- so all three sub-keyed tables match the §8.1 `<provider>:<id>`
-- invariant going forward.
--
-- The WHERE guards (`sub NOT LIKE '%:%'`) make each statement idempotent.

BEGIN;
UPDATE user_feedback  SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE recently_shown SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
UPDATE rec_log        SET sub = 'plex:' || sub WHERE sub NOT LIKE '%:%';
COMMIT;
