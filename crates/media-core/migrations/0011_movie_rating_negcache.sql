-- Negative-result cache for the movie content-rating backfill.
--
-- Migration 0010 added movies.content_rating, fetched during TMDB matching —
-- but the backfill path short-circuits on `tmdb_id IS NOT NULL`, so every
-- movie matched BEFORE 0010 shipped keeps a NULL rating forever (847 titles on
-- the live library at deploy time). The fix re-fetches the rating for
-- matched-but-unrated rows; these columns are its negative cache so titles
-- that legitimately carry no US certification (foreign/indie films) are
-- re-probed on the 0009 episode cooldown schedule instead of every ~hourly
-- scan (the exact storm 0009 killed for episodes).
ALTER TABLE movies ADD COLUMN rating_lookup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE movies ADD COLUMN rating_lookup_failed_at TEXT;
