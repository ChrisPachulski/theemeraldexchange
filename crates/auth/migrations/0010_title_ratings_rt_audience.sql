-- 0010_title_ratings_rt_audience.sql — Rotten Tomatoes Popcornmeter + slug.
--
-- OMDb carries a Tomatometer for only a minority of TV series and never the
-- audience score, so /api/ratings now resolves the RT page itself (IMDb id →
-- Wikidata P1258 → rottentomatoes.com) and stores both meters. rt_slug is
-- kept so a stale row can be refreshed without another Wikidata round-trip.

ALTER TABLE title_ratings ADD COLUMN rt_audience INTEGER;
ALTER TABLE title_ratings ADD COLUMN rt_slug TEXT;
