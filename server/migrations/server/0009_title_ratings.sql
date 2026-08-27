-- 0009_title_ratings.sql — OMDb rating cache keyed by IMDb id.
--
-- Sonarr only exposes a single TVDB score for series and Radarr's RT field is
-- often empty, so /api/ratings enriches both from OMDb. OMDb's free tier is
-- 1000 calls/day; caching every answer (including "not found") for
-- RATINGS_TTL_MS keeps a 300+ title library well under the quota.

CREATE TABLE IF NOT EXISTS title_ratings (
  imdb_id    TEXT PRIMARY KEY,
  imdb       REAL,
  rt         INTEGER,
  metacritic INTEGER,
  fetched_at INTEGER NOT NULL
);
