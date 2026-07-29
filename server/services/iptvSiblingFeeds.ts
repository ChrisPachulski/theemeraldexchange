// Sibling-feed resolver (Fox Soccer Plus incident, 2026-07-06).
//
// A single live event is usually carried by SEVERAL duplicate channel feeds on
// the provider (e.g. ~5 "Fox Soccer Plus" variants). When the feed a viewer
// tuned turns out to be a dead-channel placeholder (see iptvRemux's dead-feed
// detection), we want to fail over to one of its siblings instead of surfacing
// a hard failure. Two channels are siblings when they share an epg_channel_id
// OR normalize to the same display name (quality/format/backup tags stripped).
//
// The tuned channel is always returned FIRST so the resolver doubles as "the
// ordered candidate list for this channel"; ensureLiveRemuxEntry walks it and
// picks the first candidate not currently remembered as a dead feed.

import type Database from 'better-sqlite3'

/**
 * Fold a raw channel name to a comparison key: lowercase, drop bracketed and
 * parenthetical tags ("[Backup]", "(1080p)") and the common quality/format
 * qualifiers providers append to distinguish otherwise-identical feeds, then
 * collapse to single-spaced alphanumerics. "Fox Soccer Plus HD" and
 * "Fox Soccer Plus [Backup]" both fold to "fox soccer plus".
 */
export function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[[(][^\])]*[\])]/g, ' ') // [backup], (1080p), …
    .replace(
      /\b(?:fhd|uhd|hd|sd|4k|8k|2160p?|1080p?|720p?|576p?|480p?|hevc|h\.?265|h\.?264|raw|backup|alt(?:ernate)?|feed\s*\d+|ch\s*\d+)\b/g,
      ' ',
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

type ChannelRow = { stream_id: number; name: string; epg_channel_id: string | null; num: number | null }

/**
 * Ordered candidate feed stream_ids for `streamId`: itself first, then every
 * sibling sharing its epg_channel_id or normalized name, ordered by channel
 * number then stream_id for a stable failover sequence. Returns `[streamId]`
 * when the channel is unknown or has no siblings. Stream ids are strings to
 * match the route/remux layer, which treats stream_id as an opaque id.
 *
 * Only invoked on a session (re)start / offline check — never on the hot
 * per-segment path — so the whole-table scan (a few thousand light rows) is
 * negligible and avoids depending on a name index that does not exist.
 */
export function resolveSiblingFeeds(db: Database.Database, streamId: string): string[] {
  if (!/^\d+$/.test(streamId)) return [streamId]
  const id = Number(streamId)
  const self = db
    .prepare('SELECT stream_id, name, epg_channel_id, num FROM channels WHERE stream_id = ?')
    .get(id) as ChannelRow | undefined
  if (!self) return [streamId]

  const epg = (self.epg_channel_id ?? '').trim().toLowerCase()
  const norm = normalizeChannelName(self.name)

  const rows = db
    .prepare('SELECT stream_id, name, epg_channel_id, num FROM channels')
    .all() as ChannelRow[]

  const siblings = rows
    .filter((r) => {
      if (r.stream_id === id) return false
      const rEpg = (r.epg_channel_id ?? '').trim().toLowerCase()
      if (epg && rEpg && rEpg === epg) return true
      return norm.length > 0 && normalizeChannelName(r.name) === norm
    })
    .sort((a, b) => (a.num ?? a.stream_id) - (b.num ?? b.stream_id))
    .map((r) => String(r.stream_id))

  return [streamId, ...siblings]
}
