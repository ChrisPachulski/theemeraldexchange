-- Negative-result cache for per-episode TMDB lookups.
--
-- Episodes whose on-disk season/episode numbers don't line up with TMDB's
-- numbering scheme (absolute-numbered anime, alternate-cut sitcoms) return a
-- permanent 404 from /tv/{id}/season/{s}/episode/{e}. The only short-circuit
-- used to be `title IS NOT NULL`, so every ~hourly scan re-probed every
-- still-NULL episode forever: tens of thousands of wasted TMDB calls that also
-- pushed healthy shows into 429 back-off, and the mis-numbered episodes never
-- got a title/air_date in the library or guide UI.
--
-- These two columns are the negative cache. After a failed lookup the scanner
-- stamps `tmdb_lookup_failed_at` and bumps `tmdb_lookup_attempts`; the next
-- scan skips re-probing until the cooldown elapses, and permanently once the
-- attempt cap is hit. A later success sets `title`, which the existing
-- `title IS NOT NULL` guard already treats as resolved.
ALTER TABLE episodes ADD COLUMN tmdb_lookup_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN tmdb_lookup_failed_at TEXT;
