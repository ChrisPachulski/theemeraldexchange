-- 0001_initial.sql
-- Catalog, household + per-user signals, recommender state, ingest bookkeeping.
-- Vector index (title_vec) lives in a separate migration once sqlite-vec is loaded
-- at runtime; this file contains only plain-SQLite DDL so it can run before the
-- extension is loaded.

PRAGMA foreign_keys = ON;

-- =========================================================================
-- Catalog
-- =========================================================================

CREATE TABLE IF NOT EXISTS titles (
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
CREATE INDEX IF NOT EXISTS titles_popularity_idx ON titles(kind, popularity DESC);
CREATE INDEX IF NOT EXISTS titles_release_idx    ON titles(kind, release_date DESC);
CREATE INDEX IF NOT EXISTS titles_votes_idx      ON titles(kind, vote_count DESC);

CREATE TABLE IF NOT EXISTS title_genres (
  tmdb_id INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  genre_id INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, kind, genre_id)
);
CREATE INDEX IF NOT EXISTS title_genres_by_genre ON title_genres(kind, genre_id);

CREATE TABLE IF NOT EXISTS title_keywords (
  tmdb_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  keyword_id INTEGER NOT NULL,
  keyword    TEXT,
  PRIMARY KEY (tmdb_id, kind, keyword_id)
);
CREATE INDEX IF NOT EXISTS title_keywords_by_keyword ON title_keywords(kind, keyword_id);

CREATE TABLE IF NOT EXISTS title_cast (
  tmdb_id   INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  person_id INTEGER NOT NULL,
  name      TEXT,
  order_idx INTEGER,
  PRIMARY KEY (tmdb_id, kind, person_id)
);

CREATE TABLE IF NOT EXISTS title_crew (
  tmdb_id   INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  person_id INTEGER NOT NULL,
  name      TEXT,
  job       TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, kind, person_id, job)
);

-- Stores the wide feature vector outside the sqlite-vec virtual table so we
-- can rebuild the vector index without losing source features.
CREATE TABLE IF NOT EXISTS title_features (
  tmdb_id      INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  feature_json TEXT    NOT NULL,
  embedding    BLOB    NOT NULL,
  dim          INTEGER NOT NULL,
  computed_at  TEXT    NOT NULL,
  PRIMARY KEY (tmdb_id, kind)
);

-- =========================================================================
-- Household + per-user signals
-- =========================================================================

CREATE TABLE IF NOT EXISTS library_items (
  kind     TEXT    NOT NULL,
  tmdb_id  INTEGER NOT NULL,
  source   TEXT,
  added_at TEXT    NOT NULL,
  PRIMARY KEY (kind, tmdb_id)
);

CREATE TABLE IF NOT EXISTS user_feedback (
  sub     TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  tmdb_id INTEGER NOT NULL,
  signal  TEXT    NOT NULL CHECK (signal IN ('like','dislike','reject','shown','clicked','added')),
  ts      TEXT    NOT NULL,
  PRIMARY KEY (sub, kind, tmdb_id, signal)
);
CREATE INDEX IF NOT EXISTS user_feedback_by_user ON user_feedback(sub, kind, ts DESC);

-- Household-wide reject list (mirrors server/data/rejections.json today).
CREATE TABLE IF NOT EXISTS household_rejections (
  kind    TEXT    NOT NULL,
  tmdb_id INTEGER NOT NULL,
  ts      TEXT    NOT NULL,
  PRIMARY KEY (kind, tmdb_id)
);

CREATE TABLE IF NOT EXISTS recently_shown (
  sub     TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  tmdb_id INTEGER NOT NULL,
  ts      TEXT    NOT NULL,
  PRIMARY KEY (sub, kind, tmdb_id)
);
CREATE INDEX IF NOT EXISTS recently_shown_by_user ON recently_shown(sub, kind, ts DESC);

-- =========================================================================
-- Recommender state
-- =========================================================================

CREATE TABLE IF NOT EXISTS model_config (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version     TEXT    NOT NULL UNIQUE,
  recipe      TEXT    NOT NULL,
  params_json TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  notes       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS model_config_active_one
  ON model_config(active) WHERE active = 1;

CREATE TABLE IF NOT EXISTS rec_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sub           TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  tmdb_id       INTEGER NOT NULL,
  rank          INTEGER NOT NULL,
  score         REAL    NOT NULL,
  provenance    TEXT    NOT NULL,
  model_version TEXT    NOT NULL,
  ts            TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS rec_log_by_user ON rec_log(sub, kind, ts DESC);
CREATE INDEX IF NOT EXISTS rec_log_by_model ON rec_log(model_version, ts DESC);

CREATE TABLE IF NOT EXISTS rec_outcomes (
  rec_id  INTEGER NOT NULL,
  outcome TEXT    NOT NULL CHECK (outcome IN ('clicked','added','liked','disliked','rejected','ignored')),
  ts      TEXT    NOT NULL,
  PRIMARY KEY (rec_id, outcome),
  FOREIGN KEY (rec_id) REFERENCES rec_log(id) ON DELETE CASCADE
);

-- =========================================================================
-- Ingest bookkeeping
-- =========================================================================

CREATE TABLE IF NOT EXISTS ingest_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    TEXT NOT NULL
);

-- Track which titles still need hydration after the export-ID seed.
-- Lets the bootstrap worker resume after a crash.
CREATE TABLE IF NOT EXISTS ingest_queue (
  tmdb_id  INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  status   TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, kind)
);
CREATE INDEX IF NOT EXISTS ingest_queue_status ON ingest_queue(status, attempts);
