-- Feed identity checks: does a live stream actually carry the channel its guide
-- listing says? On 2026-10-09 "US: Showtime" carried Showtime 2, so picking My
-- Cousin Vinny in the guide played Blade Runner 2049. iptvFeedVerify compares a
-- stream's picture with other streams' and records the outcome here.
--
-- verdict:
--   match         the stream carries listed_epg_id's channel
--   mislabeled    it carries actual_epg_id's channel instead; the guide joins
--                 EPG on actual_epg_id while listed_epg_id still equals the
--                 stream's resolved id (a provider re-map retires the override)
--   inconclusive  no positive evidence either way (dark picture, no candidate)
--
-- matched_stream_id / score are the evidence: the stream whose picture matched
-- and the fingerprint correlation.
CREATE TABLE IF NOT EXISTS channel_feed_checks (
  stream_id         INTEGER PRIMARY KEY,
  verdict           TEXT NOT NULL CHECK (verdict IN ('match', 'mislabeled', 'inconclusive')),
  listed_epg_id     TEXT,
  actual_epg_id     TEXT,
  matched_stream_id INTEGER,
  score             REAL,
  checked_at        TEXT NOT NULL
);
