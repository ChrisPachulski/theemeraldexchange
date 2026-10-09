-- YouTube library (ytdl-sub's "Plex TV Show by Date" layout under
-- YOUTUBE_LIBRARY_PATHS): <root>/<Channel>/Season YYYY/sYYYY.eMMDDNN - Title.mp4
-- with a "-thumb.jpg" and an ".info.json" beside each video and the channel's
-- poster.jpg / fanart.jpg in its folder. Channels are folder names, not rows.
CREATE TABLE IF NOT EXISTS youtube_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_file_id INTEGER NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  channel_dir TEXT NOT NULL,
  title TEXT NOT NULL,
  upload_date TEXT,              -- yyyy-MM-dd
  description TEXT,
  duration_secs INTEGER,
  thumb_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_channel_date
  ON youtube_videos (channel, upload_date DESC);
CREATE INDEX IF NOT EXISTS idx_youtube_videos_date
  ON youtube_videos (upload_date DESC);

-- Widen the watch-state kind CHECK so YouTube videos get per-item resume
-- (same rebuild as 0007; the table has no secondary indexes).
CREATE TABLE media_watch_state_new (
  sub TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (
    media_kind IN ('movie', 'episode', 'track', 'audiobook', 'podcast_episode', 'video')
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
