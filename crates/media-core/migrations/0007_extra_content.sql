-- Extra content types (M6): photos, audiobooks, podcasts — plus a widened
-- media_watch_state kind CHECK so audio content gets per-item resume.

-- Photos are indexed directly (no media_files row: they are never probed by
-- ffprobe and never streamed through the video path).
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  -- EXIF DateTimeOriginal, normalized to RFC3339 when parseable; the
  -- timeline sort key (falls back to mtime at query time when NULL).
  taken_at TEXT,
  scanned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos (taken_at);

-- Audiobooks reuse media_files for the backing audio (same probe, same
-- range-capable stream path as music tracks).
CREATE TABLE IF NOT EXISTS audiobooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_secs INTEGER,
  -- ffprobe chapter list: [{"title":..,"start_secs":..,"end_secs":..}]
  chapters_json TEXT NOT NULL DEFAULT '[]'
);

-- Podcasts are remote RSS feeds; episodes stream from their enclosure URLs.
CREATE TABLE IF NOT EXISTS podcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  added_at TEXT NOT NULL,
  refreshed_at TEXT
);

CREATE TABLE IF NOT EXISTS podcast_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  podcast_id INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  audio_url TEXT NOT NULL,
  published_at TEXT,
  duration_secs INTEGER,
  description TEXT,
  UNIQUE (podcast_id, guid)
);

-- Widen the watch-state kind CHECK (SQLite cannot ALTER a CHECK: recreate).
-- 'track' backs the Music tab's per-track resume; 'audiobook' and
-- 'podcast_episode' back the new audio kinds.
CREATE TABLE media_watch_state_new (
  sub TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (
    media_kind IN ('movie', 'episode', 'track', 'audiobook', 'podcast_episode')
  ),
  media_id INTEGER NOT NULL,
  position_secs INTEGER NOT NULL DEFAULT 0,
  duration_secs INTEGER,
  watched_at TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, media_kind, media_id)
);

INSERT INTO media_watch_state_new
  SELECT sub, media_kind, media_id, position_secs, duration_secs, watched_at, completed
  FROM media_watch_state;

DROP TABLE media_watch_state;

ALTER TABLE media_watch_state_new RENAME TO media_watch_state;
