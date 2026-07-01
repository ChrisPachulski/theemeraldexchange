-- media.db v5: minimal music library (artists / albums / tracks).
--
-- Mirrors the movies/shows/episodes shape: a track is backed by a media_files
-- row (the same rows the scanner probes and stream_file serves), so audio
-- reuses the whole direct-play + range-streaming path with no new plumbing.
-- Artists dedup on name; albums dedup on (artist_id, title); a track is unique
-- per backing media file so a rescan of the same file never duplicates it.

CREATE TABLE artists (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE albums (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  year      INTEGER,
  UNIQUE(artist_id, title)
);

CREATE TABLE tracks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id      INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_file_id INTEGER NOT NULL UNIQUE REFERENCES media_files(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  track_no      INTEGER,
  duration_secs INTEGER
);

CREATE INDEX idx_albums_artist ON albums(artist_id);
CREATE INDEX idx_tracks_album ON tracks(album_id, track_no);
