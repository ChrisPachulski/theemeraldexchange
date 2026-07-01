-- Per-user video playlists (ordered) and collections (unordered groupings).
-- Item rows are polymorphic (media_kind + media_id) like media_watch_state, so
-- referential integrity to movies/episodes/shows is enforced in the handlers,
-- not by SQL FKs. The parent link is likewise plain (no REFERENCES), so the
-- DELETE handlers remove item rows explicitly before the parent.

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (sub, name)
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('movie', 'episode')),
  media_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (playlist_id, media_kind, media_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_position
  ON playlist_items (playlist_id, position);

CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (sub, name)
);

CREATE TABLE IF NOT EXISTS collection_items (
  collection_id INTEGER NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('movie', 'show')),
  media_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, media_kind, media_id)
);
