-- 0001_init.sql — iptv catalog, EPG, per-user state, link table for the recommender.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS channels (
  stream_id           INTEGER PRIMARY KEY,
  num                 INTEGER,
  name                TEXT    NOT NULL,
  stream_icon         TEXT,
  epg_channel_id      TEXT,
  category_id         INTEGER,
  is_adult            INTEGER NOT NULL DEFAULT 0,
  tv_archive          INTEGER NOT NULL DEFAULT 0,
  tv_archive_duration INTEGER,
  added_ts            TEXT,
  fetched_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_category ON channels(category_id);

CREATE TABLE IF NOT EXISTS vod (
  stream_id           INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL,
  stream_icon         TEXT,
  rating              REAL,
  category_id         INTEGER,
  container_extension TEXT,
  added_ts            TEXT,
  tmdb_id             INTEGER,
  year                INTEGER,
  plot                TEXT,
  director            TEXT,
  cast_csv            TEXT,
  fetched_at          TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS vod_tmdb ON vod(tmdb_id);
CREATE INDEX IF NOT EXISTS vod_category ON vod(category_id);

CREATE TABLE IF NOT EXISTS series (
  series_id      INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL,
  cover          TEXT,
  plot           TEXT,
  rating         REAL,
  category_id    INTEGER,
  tmdb_id        INTEGER,
  last_modified  TEXT,
  fetched_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS series_tmdb ON series(tmdb_id);

CREATE TABLE IF NOT EXISTS series_episodes (
  episode_id          TEXT    PRIMARY KEY,
  series_id           INTEGER NOT NULL REFERENCES series(series_id) ON DELETE CASCADE,
  season              INTEGER NOT NULL,
  episode_num         INTEGER NOT NULL,
  title               TEXT,
  container_extension TEXT,
  added_ts            TEXT,
  plot                TEXT,
  duration_secs       INTEGER
);
CREATE INDEX IF NOT EXISTS series_eps_by_series ON series_episodes(series_id, season, episode_num);

CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('live','vod','series')),
  name        TEXT    NOT NULL,
  parent_id   INTEGER,
  PRIMARY KEY (kind, category_id)
);

CREATE TABLE IF NOT EXISTS epg_programs (
  channel_id  TEXT NOT NULL,
  start_utc   TEXT NOT NULL,
  stop_utc    TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  PRIMARY KEY (channel_id, start_utc)
);
CREATE INDEX IF NOT EXISTS epg_window ON epg_programs(channel_id, start_utc, stop_utc);

CREATE TABLE IF NOT EXISTS iptv_favorites (
  sub      TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('live','vod','series')),
  item_id  TEXT NOT NULL,
  added_ts TEXT NOT NULL,
  PRIMARY KEY (sub, kind, item_id)
);

CREATE TABLE IF NOT EXISTS iptv_watch_history (
  sub            TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('live','vod','series_episode')),
  item_id        TEXT    NOT NULL,
  position_secs  INTEGER NOT NULL DEFAULT 0,
  duration_secs  INTEGER,
  watched_at     TEXT    NOT NULL,
  completed      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub, kind, item_id)
);
CREATE INDEX IF NOT EXISTS iptv_hist_recent ON iptv_watch_history(sub, watched_at DESC);

CREATE TABLE IF NOT EXISTS iptv_title_link (
  iptv_kind TEXT    NOT NULL CHECK (iptv_kind IN ('vod','series')),
  iptv_id   INTEGER NOT NULL,
  tmdb_kind TEXT    NOT NULL CHECK (tmdb_kind IN ('movie','tv')),
  tmdb_id   INTEGER NOT NULL,
  PRIMARY KEY (iptv_kind, iptv_id)
);
CREATE INDEX IF NOT EXISTS iptv_link_by_tmdb ON iptv_title_link(tmdb_kind, tmdb_id);

CREATE TABLE IF NOT EXISTS iptv_sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts    TEXT NOT NULL
);
