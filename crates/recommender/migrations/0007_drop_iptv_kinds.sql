-- 0007_drop_iptv_kinds.sql
-- DESTRUCTIVE
-- Resolution A (§9): drop per-source iptv_vod / iptv_series rows from
-- exchange.db.titles. The iptv_title_link join in iptv.db is now the sole
-- canonical path for IPTV availability. Restores the kind CHECK constraint to
-- ('movie','tv') — the widening added by 0005_iptv_kinds.sql is reverted.
--
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table
-- using the standard CREATE / INSERT / DROP / RENAME pattern.

PRAGMA foreign_keys = OFF;

-- 1. Remove orphaned feature/vector/genre rows for iptv_vod and iptv_series
--    titles BEFORE deleting from titles (no FK cascade in this schema).
DELETE FROM title_features
WHERE kind IN ('iptv_vod', 'iptv_series');

DELETE FROM title_genres
WHERE kind IN ('iptv_vod', 'iptv_series');

-- title_vec is a virtual table; rows are keyed by integer rowid, not by
-- (tmdb_id, kind). Delete any rows whose kind partition is an iptv kind.
DELETE FROM title_vec
WHERE kind IN ('iptv_vod', 'iptv_series');

-- 2. Delete the per-source rows from titles.
DELETE FROM titles
WHERE kind IN ('iptv_vod', 'iptv_series');

-- 3. Rebuild titles with the narrowed CHECK constraint.
DROP TABLE IF EXISTS titles_new;

CREATE TABLE IF NOT EXISTS titles_new (
  tmdb_id           INTEGER NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('movie','tv')),
  title             TEXT    NOT NULL,
  original_title    TEXT,
  year              INTEGER,
  release_date      TEXT,
  overview          TEXT,
  poster_path       TEXT,
  vote_average      REAL,
  vote_count        INTEGER,
  popularity        REAL,
  runtime           INTEGER,
  status            TEXT,
  original_language TEXT,
  adult             INTEGER NOT NULL DEFAULT 0,
  last_changed_at   TEXT,
  fetched_at        TEXT    NOT NULL,
  raw_json          TEXT,
  PRIMARY KEY (tmdb_id, kind)
);

INSERT OR IGNORE INTO titles_new (
  tmdb_id,
  kind,
  title,
  original_title,
  year,
  release_date,
  overview,
  poster_path,
  vote_average,
  vote_count,
  popularity,
  runtime,
  status,
  original_language,
  adult,
  last_changed_at,
  fetched_at,
  raw_json
)
SELECT
  tmdb_id,
  kind,
  title,
  original_title,
  year,
  release_date,
  overview,
  poster_path,
  vote_average,
  vote_count,
  popularity,
  runtime,
  status,
  original_language,
  adult,
  last_changed_at,
  fetched_at,
  raw_json
FROM titles;

DROP TABLE titles;
ALTER TABLE titles_new RENAME TO titles;

CREATE INDEX IF NOT EXISTS titles_popularity_idx ON titles(kind, popularity DESC);
CREATE INDEX IF NOT EXISTS titles_release_idx    ON titles(kind, release_date DESC);
CREATE INDEX IF NOT EXISTS titles_votes_idx      ON titles(kind, vote_count DESC);

PRAGMA foreign_keys = ON;
