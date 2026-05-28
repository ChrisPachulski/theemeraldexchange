-- media.db initial schema (M3 §3.3). Owned by media-core (Rust/sqlx).
-- Migration convention mirrors server/services/migrator.ts: a
-- schema_migrations(version, applied_at, checksum) ledger, integer
-- versions applied in order. Keep this byte-stable across languages.

CREATE TABLE media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  container TEXT,
  duration_secs INTEGER,
  video_codec TEXT,
  video_height INTEGER,
  video_profile TEXT,
  hdr_format TEXT,
  audio_tracks_json TEXT NOT NULL,
  subtitle_tracks_json TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE TABLE movies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER UNIQUE,
  imdb_id TEXT,
  title TEXT NOT NULL,
  year INTEGER,
  added_at TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE
);

CREATE TABLE shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id INTEGER UNIQUE,
  tvdb_id INTEGER,
  title TEXT NOT NULL,
  year INTEGER,
  added_at TEXT NOT NULL
);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT,
  air_date TEXT,
  file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  UNIQUE(show_id, season, episode)
);

CREATE TABLE media_watch_state (
  sub TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('movie','episode')),
  media_id INTEGER NOT NULL,
  position_secs INTEGER NOT NULL DEFAULT 0,
  duration_secs INTEGER,
  watched_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, media_kind, media_id)
);

CREATE TABLE scan_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE INDEX idx_movies_title ON movies(title);
CREATE INDEX idx_shows_title ON shows(title);
CREATE INDEX idx_episodes_show ON episodes(show_id, season, episode);
