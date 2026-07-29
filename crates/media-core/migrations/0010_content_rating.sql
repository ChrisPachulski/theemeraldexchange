-- US certification / content rating on the downloaded-library movie & show rows.
--
-- The media.db movies/shows tables carried no rating column, and the
-- /api/media/movies|shows payloads exposed nothing the parental gate could
-- filter on: a restricted (child) profile browsing the downloaded library saw
-- and could play R / TV-MA titles that UserPolicy blocks everywhere else.
--
-- This column is the missing input. The scanner populates it during TMDB
-- enrichment from `/movie/{id}/release_dates` (US certification) and
-- `/tv/{id}/content_ratings` (US rating); the Apple client decodes it and
-- applies the same UserPolicy ceiling already enforced for IPTV/live. NULL is
-- the honest "unknown" — the client treats it as it already treats an unrated
-- item, so existing rows stay browseable rather than being mass-hidden until a
-- rescan backfills them.
ALTER TABLE movies ADD COLUMN content_rating TEXT;
ALTER TABLE shows ADD COLUMN content_rating TEXT;
