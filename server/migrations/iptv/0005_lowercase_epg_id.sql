-- Normalize channels.epg_channel_id to lowercase+trim so it joins the XMLTV
-- guide feed.
--
-- Root cause: this provider's stream catalog (get_live_streams) preserves the
-- original mixed case of the tvg-id (e.g. "CNBC.us", "BBCWorld.us"), but its
-- epg.xml feed emits channel ids in lowercase ("cnbc.us"). The EPG join is
-- exact + BINARY-collated, so ~3,868 channels never matched their schedule
-- data — only ~509 of 50k channels showed any guide. epg_programs.channel_id
-- is already stored lowercase (verified: 0 mixed-case rows), so normalizing the
-- channel side alone converges the two namespaces.
--
-- parseLiveStreams() now lowercases epg_channel_id on every sync, so this
-- one-time backfill keeps the existing rows aligned until the next sync rewrites
-- them anyway. Idempotent: the guard skips rows already normalized.
--
-- NULLIF(..., '') collapses whitespace-only ids to NULL to match the canonical
-- normalizeEpgChannelId() (which returns null for empty), so the migration and
-- the next sync converge on the same value (no churn). Not marked DESTRUCTIVE:
-- this is a recoverable, transaction-atomic rewrite of a derived join key (the
-- next sync re-derives it from upstream), and the iptv db migrates without a
-- server.db handle, so a DESTRUCTIVE marker would refuse at boot.
UPDATE channels
SET epg_channel_id = NULLIF(lower(trim(epg_channel_id)), '')
WHERE epg_channel_id IS NOT NULL
  AND epg_channel_id IS NOT NULLIF(lower(trim(epg_channel_id)), '');
