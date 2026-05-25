-- 0005_iptv_kinds.sql
-- Widen titles.kind to accept IPTV catalog rows. SQLite cannot alter a
-- CHECK constraint in place, so rebuild the table and restore indexes.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS titles_new;

CREATE TABLE IF NOT EXISTS titles_new (
  tmdb_id           INTEGER NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('movie','tv','iptv_vod','iptv_series')),
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
