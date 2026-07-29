-- Negative-result cache for the movie TMDB *match* search (title -> tmdb_id).
--
-- Migration 0011 negcached only the rating backfill of ALREADY-matched rows.
-- A movie that never matches TMDB (home video, obscure/foreign rip) keeps a
-- NULL tmdb_id, so the backfill path fell through to a live /search/movie for
-- that file on EVERY hourly scan forever -- 1-2 requests per unmatchable file
-- per pass that can never start succeeding without a file change, compounding
-- the 429 pressure that poisons legitimate lookups.
--
-- These two columns cache a DEFINITIVE no-results search on the same 30-day /
-- 6-attempt cooldown as the 0009 episode and 0011 rating negcaches. A transient
-- search failure (5xx/timeout/rate-limit) is NOT stamped, so a real title is
-- never suppressed by an outage. The default keeps the current library fully
-- re-searchable (0 attempts, no failure stamp) rather than mass-suppressing it.
ALTER TABLE movies ADD COLUMN match_lookup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movies ADD COLUMN match_lookup_failed_at TEXT;
