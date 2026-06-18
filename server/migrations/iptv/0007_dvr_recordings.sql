-- DVR recordings (M6 — DVR bucket, phase 1).
--
-- A scheduled or completed recording of an IPTV live channel for a programme
-- time window (start/stop from the EPG). The recorder engine (phase 2) reads
-- 'scheduled' rows whose window has opened, spawns ffmpeg against the live
-- channel, and transitions them scheduled -> recording -> completed/failed.
-- A row whose window fully elapsed while still 'scheduled' (server was down)
-- is marked 'missed'.
--
-- channel_stream_id is the Xtream live stream_id (the source for the live URL);
-- title/start/stop are copied from the chosen EPG programme so the recording is
-- self-describing even after the guide row rolls off.
CREATE TABLE IF NOT EXISTS dvr_recordings (
  id                TEXT PRIMARY KEY,                  -- ulid
  channel_stream_id INTEGER NOT NULL,                 -- Xtream live stream_id
  channel_name      TEXT NOT NULL,
  title             TEXT NOT NULL,                     -- programme title
  start_utc         TEXT NOT NULL,                     -- ISO-8601 scheduled start
  stop_utc          TEXT NOT NULL,                     -- ISO-8601 scheduled stop
  status            TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|recording|completed|failed|missed|cancelled
  file_path         TEXT,                              -- set when recording starts
  error             TEXT,                              -- set on failure
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dvr_by_status ON dvr_recordings(status);
CREATE INDEX IF NOT EXISTS dvr_by_start ON dvr_recordings(start_utc);
