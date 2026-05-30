-- Add channels.epg_resolved_id: the feed channel id we actually JOIN EPG on.
--
-- Why: this provider's stream catalog tags channels with a tvg-id (epg_channel_id)
-- that exactly matches the XMLTV feed for only ~806 of 50k channels. But the feed
-- carries EPG for ~5,986 channels and ships ~46k <display-name> ALIASES so players
-- can match a channel to its schedule by NAME, not just by exact tvg-id. The sync
-- now name-matches catalog channels to feed channels and records the matched feed
-- id here, lifting coverage from ~806 to ~12,500 catalog channels.
--
-- epg_resolved_id holds the feed id to join on (= the tvg-id when it directly
-- matches, else the name-matched feed id, else NULL). Queries COALESCE
-- (epg_resolved_id, epg_channel_id) so they keep working before the first resync
-- recomputes matches. Non-destructive: ADD COLUMN + backfill + index.
ALTER TABLE channels ADD COLUMN epg_resolved_id TEXT;

-- Seed with the existing tvg-id so the join is unchanged (still ~806) until the
-- next sync recomputes name-based matches. lower(trim()) mirrors the canonical
-- form so the seed already benefits from the 0005 case fix.
UPDATE channels
SET epg_resolved_id = NULLIF(lower(trim(epg_channel_id)), '')
WHERE epg_channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS channels_epg_resolved ON channels(epg_resolved_id);
