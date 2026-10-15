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
//
// 2026-10-15 audit of the Apple TV guide: 69 of 290 name-resolved rows showed
// another channel's schedule. CBS locals listed WCBS New York, FOX locals the
// fox.us placeholder, NBC stations ABC or CNBC, "USA NETWORK WEST" a westerns
// channel, Showtime BET plain Showtime. So a station's callsign decides first,
// every match (tvg-id included) passes the vetoes in rejects(), and no listing
// beats another market's.

// Canonical tvg-id form: lowercase + trim, empty → null. Inlined (rather than
// imported from iptvEpg.js) so this resolver has no dependency on that module —
// iptvSync.test.ts mocks iptvEpg.js to stub fetchAndStreamEpg, and importing
// from it here would make the mock swallow this helper and break the sync path.
function normalizeEpgChannelId(id: string | null | undefined): string | null {
  if (id == null) return null
  const v = id.trim().toLowerCase()
  return v.length > 0 ? v : null
}

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
  // Strip a leading country/locale token. Catalog names prefix the country with
  // a separator ("US: ESPN", "USA | ESPN", "DK - TV3") OR just whitespace
  // ("UK FHD TNT Sport 1", "USA HGTV"). Quality tokens are removed separately
  // below, so after stripping a separator-prefix we also strip a bare 2–3 letter
  // country code that's left at the very start.
  // "(West)" and "(Pacific)" survive as "west": a West feed is its own schedule,
  // three hours behind East. "USA" before "Network" is the brand, not a country
  // ("USA NETWORK WEST" read as "networkwest", a westerns channel).
  const v = s
    .replace(/^\s*[A-Za-z]{2,4}\s*[:|–—-]+\s*/, '') // "US:", "USA |", "DK -"
    .replace(QUALITY_TOKENS, ' ') // FHD/HD/4K/HEVC… (also clears "UK FHD" → "UK  ")
    .replace(/^\s*(?:US|USA|UK|CA|AU|NZ|IE|DE|FR|ES|IT|PT|NL|SE|NO|DK|FI|PL|BR|MX|AR|IN|ZA)\b(?!\s+network)\s+/i, '') // bare country code + space
    .replace(/\(\s*(?:west|pacific)\s*\)/gi, ' west ')
    .replace(/\([^)]*\)/g, ' ') // (S) (H) (Backup)
    .replace(/\[[^\]]*\]/g, ' ') // [VIP] etc.
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
  /** normalized name shared by several feed ids of which one is a US id → that id. */
  usNameToFeedId: Map<string, string>
  /** callsign → feed ids whose id carries it ("nbcwtvjmiamifl.us" → wtvj). */
  idCallsigns: Map<string, string[]>
  /** callsign → feed ids whose display names carry it. */
  nameCallsigns: Map<string, string[]>
  /** normalized catalog name → the tvg-id same-named streams carry (catalogTvgIndex). */
  catalogTvg?: Map<string, string>
  /** feed id → last programme stop, to prefer the id with the longer schedule. */
  lastStop?: Map<string, string>
}

// Broadcast networks a US station is branded with. cnbc leads so it is never
// read as nbc; "my" covers MyTV, MyNet and MyNetworkTV.
const NETWORKS = 'cnbc|abc|cbs|nbc|fox|cw|pbs|telemundo|univision|unimas|my'
const NAME_NETWORK = new RegExp(`(?<![a-z])(${NETWORKS})(?:net(?:work)?)?(?:tv)?(?![a-z])`, 'i')
const NETWORK_WORD = new RegExp(`^(?:${NETWORKS})(?:net(?:work)?)?(?:tv)?$`)
const ID_NETWORK = new RegExp(`^(${NETWORKS})`)
// A bare network id (fox.us, abc5.us, mytv.us, telemundo.us) is one market's
// schedule or a placeholder, never a named station's.
const BARE_NETWORK = new RegExp(`^(?:${NETWORKS})(?:tv)?\\d*$`)
// Where an id carries a callsign: after its network and channel number, or as
// the whole id ("wusa9.us", "koco-dt.us_locals1").
const ID_CALLSIGN = new RegExp(`^(?:${NETWORKS})?\\d*([wk][a-z]{2})([a-z]?)`)
const ONLY_CALLSIGN = /^[wk][a-z]{2,3}(?:dt)?\d*$/
// Parts of a name that mark a different channel of the same brand.
const SUB_BRANDS = ['bet', 'jr', 'dodgers', 'lakers', 'sony']
// Channels whose feed id goes by a newer or fuller name. HBO2 became HBO Hits
// and Newsy became Scripps News; SHO×BET is shoxbet.us, not Showtime 2. The
// rest were checked against the schedules on 2026-10-15: the provider tags a
// Hallmark Family stream hallmarkdrama.us and the HALLMARK DRAMA picture
// matched it, and the Dodgers channel is SportsNet LA.
const RENAMES: Array<[string, string]> = [
  ['hbohits', 'hbo2'],
  ['newsy', 'scrippsnews'],
  ['showtimebet', 'shoxbet'],
  ['hallmarkdrama', 'hallmarkfamily'],
  ['disneyjr', 'disneyjunior'],
  ['sonymovies', 'sonymoviechannel'],
  ['sportsnetladodgers', 'sportsnetla'],
  ['sportsnetdodgers', 'sportsnetla'],
]

/** "abc.(kgun).tucson,.az.us" → "abckguntucsonaz": the id without its country suffix. */
function idStem(id: string): string {
  return id.replace(/^\[[^\]]*\]/, '').replace(/\.[a-z]{2,3}(?:\d|_locals\d*|\.plus\d)?$/, '').replace(/[^a-z0-9]+/g, '')
}

/** Country (or .net) suffix of an id, us2/us_locals1 counting as us; null for .plex and the like. */
function countryOf(id: string): string | null {
  return /\.([a-z]{2,3})(?:\d|_locals\d*)?$/.exec(id)?.[1] ?? null
}

interface Station {
  key: string | null
  us: boolean
  west: boolean
  network?: string
  callsign?: string
  /** name words that are not network, coast or callsign: the station's city. */
  words: string[]
  tvgCountry: string | null
}

const isUs = (name: string): boolean => /^\W*usa?\b/i.test(name)

function parseStation(name: string, tvg: string | null): Station {
  const network = NAME_NETWORK.exec(name)?.[1].toLowerCase()
  // Only a network-branded name has a callsign: "(WNBA)" and "NBA (WAS)" do not.
  const callsign = network ? /\(([WK][A-Z]{2,3})(?:-[A-Z0-9]+)?\)/.exec(name)?.[1].toLowerCase() : undefined
  const words = name.toLowerCase().split(/[^a-z]+/).filter((w) =>
    w.length >= 4 && w !== callsign && !NETWORK_WORD.test(w) && !/^(?:west|east|pacific|backup|hevc)$/.test(w))
  return {
    key: normalizeChannelName(name),
    us: isUs(name),
    west: /\b(?:west|pacific)\b/i.test(name),
    network: network?.startsWith('my') ? 'my' : network,
    callsign,
    words,
    tvgCountry: tvg ? countryOf(tvg) : null,
  }
}

/**
 * Why `id` cannot be this station's guide, or false. Every pass checks the
 * network (an NBC station never lists ABC or CNBC) and, for a station with a
 * callsign, that the id is that station: it carries the callsign, or names
 * the station's city and is not a bare network id. A US stream also keeps its
 * sub-brand, never takes a bare network id when its name says more (MyTV New
 * Jersey is not mytv.us), and takes a foreign id only when it starts like the
 * name and agrees with the country its tvg-id names (dubai.ae on News 12 New
 * Jersey, ginx.esports.gr on a stream tagged .ca). A name match (`key`) must
 * also keep the name's coast and channel number; a tvg-id need not, as the
 * provider's tag says which feed the stream carries.
 */
function rejects(st: Station, id: string, index: EpgNameIndex, key?: string): boolean {
  const stem = idStem(id)
  const idNetwork = ID_NETWORK.exec(stem)?.[1]
  if (st.network && idNetwork && idNetwork !== st.network) return true
  const country = countryOf(id)
  const foreign = st.us && country !== null && country !== 'us'
  if (st.callsign) {
    if (foreign) return true // kntv.jp is not NBC Bay Area
    if (index.idCallsigns.get(st.callsign)?.includes(id)) return false
    return BARE_NETWORK.test(stem) || !st.words.some((w) => stem.includes(w))
  }
  if (!st.us || !st.key) return false
  const name = key ?? st.key
  if (st.words.length > 0 && BARE_NETWORK.test(stem)) return true
  const brand = (s: string) => s.replace(/junior/g, 'jr')
  if (SUB_BRANDS.some((t) => brand(name).includes(t) !== brand(stem).includes(t))) return true
  if (foreign && (!stem.startsWith(name.slice(0, 3)) || (st.tvgCountry && st.tvgCountry !== country))) return true
  if (key === undefined || st.network) return false
  if (st.west !== /(?:(?<!mid|north|south)west|pacific)\W*$/.test(id.replace(/\.[^.]+$/, ''))) return true
  // A number only the id carries is another channel: showtime2west.us is not
  // Showtime West.
  const numbers: string[] = key.match(/\d+/g) ?? []
  return /[a-z]/.test(stem) && (stem.match(/\d+/g) ?? []).some((n) => !numbers.includes(n))
}

/**
 * The station's own id among those carrying its callsign: a US id of its
 * network, then the one whose schedule runs latest (the long
 * "<net><callsign><city><state>.us" ids run four days, the short provider ids
 * one), then the one naming its city.
 */
function byCallsign(st: Station, index: EpgNameIndex): string | null {
  const rank = (id: string): string => {
    const stem = idStem(id)
    return [
      (countryOf(id) ?? 'us') === 'us' ? 1 : 0,
      st.network && stem.startsWith(st.network) ? 1 : 0,
      (index.lastStop?.get(id) ?? '0').slice(0, 10),
      st.words.some((w) => stem.includes(w)) ? 1 : 0,
      index.lastStop?.get(id) ?? '0',
      String(id.length).padStart(3, '0'),
    ].join('|')
  }
  const best = (ids: string[] | undefined): string | null =>
    (ids ?? []).filter((id) => !rejects(st, id, index)).sort((a, b) => rank(b).localeCompare(rank(a)))[0] ?? null
  // A display name is weaker evidence than the id: it must also name the city.
  return best(index.idCallsigns.get(st.callsign!))
    ?? best(index.nameCallsigns.get(st.callsign!)?.filter((id) => st.words.some((w) => idStem(id).includes(w))))
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
  const idCallsigns = new Map<string, string[]>()
  const nameCallsigns = new Map<string, string[]>()
  const addCallsign = (map: Map<string, string[]>, callsign: string, id: string) => {
    const ids = map.get(callsign) ?? []
    if (!ids.includes(id)) map.set(callsign, [...ids, id])
  }

  for (const def of defs) {
    const id = normalizeEpgChannelId(def.id)
    if (!id || !feedWithEpg.has(id)) continue
    // Index each display-name alias…
    for (const nm of def.names) {
      add(normalizeChannelName(nm), id)
      for (const cs of nm.match(/\b[WK][A-Z]{2,3}\b/g) ?? []) addCallsign(nameCallsigns, cs.toLowerCase(), id)
    }
    // …and the id itself sans country suffix ("espn.us" → "espn"), which often
    // equals the channel name with no aliases present.
    add(normalizeChannelName(id.replace(/\.[a-z]{2,3}$/, '')), id)
    // A 3-letter callsign may be the start of a 4-letter one, so index both.
    const stem = idStem(id)
    const m = ID_CALLSIGN.exec(stem)
    if (m && (ID_NETWORK.test(stem) || ONLY_CALLSIGN.test(stem))) {
      addCallsign(idCallsigns, m[1], id)
      if (m[2]) addCallsign(idCallsigns, m[1] + m[2], id)
    }
  }

  // The feed lists one brand per country (disneyjunior.us, .ca, .de…): for a
  // US stream that is not ambiguous.
  const nameToFeedId = new Map<string, string>()
  const usNameToFeedId = new Map<string, string>()
  for (const [name, ids] of collisions) {
    if (ids.size === 1) nameToFeedId.set(name, [...ids][0])
    const us = [...ids].filter((id) => countryOf(id) === 'us')
    if (ids.size > 1 && us.length === 1) usNameToFeedId.set(name, us[0])
  }
  return { feedWithEpg, nameToFeedId, usNameToFeedId, idCallsigns, nameCallsigns }
}

/**
 * The tvg-id US streams of one normalized name agree on: "US HBO Hits (A)" and
 * "US HBO Hits (East) (H)" both carry hbo2.us. Two must agree and none
 * disagree, so one junk tag does not spread to its twins.
 */
export function catalogTvgIndex(
  channels: Array<{ name: string; epg_channel_id: string | null }>,
  feedWithEpg: Set<string>,
): Map<string, string> {
  const tvgs = new Map<string, string[]>()
  for (const ch of channels) {
    const key = normalizeChannelName(ch.name)
    const tvg = normalizeEpgChannelId(ch.epg_channel_id)
    if (key && tvg && isUs(ch.name) && feedWithEpg.has(tvg)) tvgs.set(key, [...(tvgs.get(key) ?? []), tvg])
  }
  return new Map([...tvgs].filter(([, ids]) => ids.length > 1 && new Set(ids).size === 1).map(([key, ids]) => [key, ids[0]]))
}

/**
 * Resolve a single catalog channel to the feed id whose EPG it should show, in
 * order: the station's callsign, its own tvg-id, the tvg-id same-named streams
 * carry, then its name (renamed, as written, without a trailing "east").
 * Returns null when nothing passes rejects(). The provider's CINEBOX genre
 * loops have no schedule anywhere.
 */
export function resolveEpgId(
  channel: { name: string; epg_channel_id: string | null },
  index: EpgNameIndex,
): string | null {
  if (/^\W*cinebox\b/i.test(channel.name)) return null
  const tvg = normalizeEpgChannelId(channel.epg_channel_id)
  const st = parseStation(channel.name, tvg)
  if (st.callsign) {
    const id = byCallsign(st, index)
    if (id) return id
  }
  if (tvg && index.feedWithEpg.has(tvg) && !rejects(st, tvg, index)) return tvg // the provider's own tag
  if (!st.key) return null
  // Some provider tags are junk (dubai.ae on WEAR, disneychannel.us on a
  // Disney XD stream), so a sibling's tvg-id must start like the name.
  const sibling = st.us ? index.catalogTvg?.get(st.key) : undefined
  if (sibling && idStem(sibling).startsWith(st.key.slice(0, 3)) && !rejects(st, sibling, index)) return sibling
  const keys = [st.key, st.key.replace(/(.{3,})east$/, '$1')]
  for (const key of [...keys.map((k) => RENAMES.reduce((acc, [from, to]) => acc.replace(from, to), k)), ...keys]) {
    const hit = index.nameToFeedId.get(key) ?? (st.us ? index.usNameToFeedId.get(key) : undefined)
    if (hit && !rejects(st, hit, index, key)) return hit // unambiguous name/alias
  }
  return null
}

/**
 * Benchmark/scoring aid — NOT used in the live resolve path. Returns a 0..1
 * title-similarity score between two raw channel names, computed as the Jaccard
 * similarity (|A ∩ B| / |A ∪ B|) of their character-trigram sets AFTER applying
 * the same normalizeChannelName() the resolver uses. This lets a deterministic,
 * network-free benchmark score how close two names are without TMDB calls:
 *   - identical normalized forms → 1 ("US: ESPN" and "ESPN FHD" both → "espn")
 *   - disjoint forms → 0
 * If either input normalizes to null (too short/empty), returns 0. A normalized
 * string shorter than 3 chars cannot occur (normalizeChannelName rejects <3),
 * but is guarded by treating the whole string as a single token.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeChannelName(a)
  const nb = normalizeChannelName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1

  const trigrams = (s: string): Set<string> => {
    if (s.length < 3) return new Set([s]) // guard: whole string as one token
    const set = new Set<string>()
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3))
    return set
  }

  const A = trigrams(na)
  const B = trigrams(nb)
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 0 : inter / union
}
