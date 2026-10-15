-- Why a feed check ended the way it did (iptvFeedVerify's outcome reason), kept
-- with the verdict. Until 2026-10-15 it was only in the logs, so a check whose
-- captures failed (a channel off air overnight) could not be told apart from
-- one that compared every candidate, and both were retried at the same hour
-- every night. Additive: NULL for checks recorded before this column existed.
ALTER TABLE channel_feed_checks ADD COLUMN reason TEXT;
