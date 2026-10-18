-- Mark West-feed guide rows the sync derived from the East schedule.
--
-- Why: deriveWestFeedEpg (iptvSync.ts) fills a "<x>west.us" id the feeds do not
-- deliver with the East schedule three hours later. Each run must replace its
-- own earlier copies (an East programme that moved would otherwise leave a stale
-- copy beside the new one) and never a real West listing (an external source's,
-- or one a feed delivered in an earlier sync), so the sync has to tell them
-- apart. derived = 1 is a copy; every feed row is 0. Non-destructive: ADD COLUMN.
ALTER TABLE epg_programs ADD COLUMN derived INTEGER NOT NULL DEFAULT 0;
