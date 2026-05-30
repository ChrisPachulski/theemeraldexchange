// EPG channel resolution: match a stream-catalog channel to the XMLTV feed
// channel that actually carries its schedule.
//
// This provider tags channels with a tvg-id (epg_channel_id) that matches the
// feed for only ~806 of 50k channels. But the feed carries EPG for ~5,986
// channels and ships ~46k <display-name> aliases per channel so players can
// match by NAME. We do a two-pass resolve:
//   1. exact tvg-id (authoritative) — if the catalog tvg-id is a feed channel
//      that has programmes, use it.
//   2. name/alias match — otherwise, normalize the catalog channel name and
//      look it up in an index built from the feed's <display-name> aliases.
//
// Precision over recall: the name index DROPS any normalized name that maps to
// more than one feed channel (ambiguous), so we never attach the wrong guide.

import { normalizeEpgChannelId } from './iptvEpg.js'

// Country/quality/variant tokens stripped before name comparison. The catalog
// names look like "US: ESPN", "UK FHD TNT Sport 1", "HEVC: TNT Sports 1 FHD";
// the feed display-names look like "ESPN", "TNT Sports 1". Strip the noise so
// they converge.
const QUALITY_TOKENS =
  /\b(FHD|UHD|HD|SD|4K|8K|HEVC|H ?265|H ?264|50 ?FPS|60 ?FPS|VIP|RAW|MULTI|BACKUP|ALT|SLOW|FAST)\b/gi

/**
 * Canonical comparison key for a channel name. Strips a leading country prefix
 * ("US:", "UK |", "DK -"), parenthetical qualifiers ("(S)", "(Backup)"),
 * quality/variant tokens, and all non-alphanumerics, then lowercases. Returns
 * null for anything shorter than 3 chars (too generic to match safely).
 */
export function normalizeChannelName(s: string | null | undefined): string | null {
  if (!s) return null
  const v = s
    .replace(/^\s*[A-Za-z]{2,4}\s*[:|–—-]\s*/, '') // leading "US:", "USA |", "DK -"
    .replace(/\([^)]*\)/g, ' ') // (S) (H) (Backup)
    .replace(/\[[^\]]*\]/g, ' ') // [VIP] etc.
    .replace(QUALITY_TOKENS, ' ')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
    .trim()
  return v.length >= 3 ? v : null
}

export interface FeedChannelDef {
  id: string
  names: string[]
}

export interface EpgNameIndex {
  /** feed channel ids (lowercased) that actually have ≥1 programme. */
  feedWithEpg: Set<string>
  /** normalized unambiguous name → single feed id (only for feed ids with EPG). */
  nameToFeedId: Map<string, string>
}

/**
 * Build the resolver index from the feed's channel definitions and the set of
 * feed channel ids that have programmes. Only feed channels WITH programmes are
 * indexed (a display-name pointing at an EPG-less feed channel is useless), and
 * a normalized name shared by two different feed ids is dropped as ambiguous.
 */
export function buildEpgNameIndex(defs: FeedChannelDef[], feedWithEpg: Set<string>): EpgNameIndex {
  // First gather every (normName → set of feed ids) to detect collisions.
  const collisions = new Map<string, Set<string>>()
  const add = (name: string | null, id: string) => {
    if (!name) return
    let set = collisions.get(name)
    if (!set) collisions.set(name, (set = new Set()))
    set.add(id)
  }

  for (const def of defs) {
    const id = normalizeEpgChannelId(def.id)
    if (!id || !feedWithEpg.has(id)) continue
    // Index each display-name alias…
    for (const nm of def.names) add(normalizeChannelName(nm), id)
    // …and the id itself sans country suffix ("espn.us" → "espn"), which often
    // equals the channel name with no aliases present.
    add(normalizeChannelName(id.replace(/\.[a-z]{2,3}$/, '')), id)
  }

  const nameToFeedId = new Map<string, string>()
  for (const [name, ids] of collisions) {
    if (ids.size === 1) nameToFeedId.set(name, [...ids][0])
  }
  return { feedWithEpg, nameToFeedId }
}

/**
 * Resolve a single catalog channel to the feed id whose EPG it should show.
 * Returns the feed id, or null if neither the tvg-id nor the name matches a
 * feed channel that has programmes.
 */
export function resolveEpgId(
  channel: { name: string; epg_channel_id: string | null },
  index: EpgNameIndex,
): string | null {
  const tvg = normalizeEpgChannelId(channel.epg_channel_id)
  if (tvg && index.feedWithEpg.has(tvg)) return tvg // pass 1: authoritative
  const name = normalizeChannelName(channel.name)
  if (name) {
    const hit = index.nameToFeedId.get(name)
    if (hit) return hit // pass 2: unambiguous name/alias
  }
  return null
}
