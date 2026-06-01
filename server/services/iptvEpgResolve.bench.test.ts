import { describe, it, expect } from 'vitest'
import {
  normalizeChannelName,
  buildEpgNameIndex,
  resolveEpgId,
  titleSimilarity,
  type FeedChannelDef,
} from './iptvEpgResolve.js'

// Deterministic, network-free match-accuracy benchmark for the IPTV→EPG name
// resolver. Guards the documented fragility hotspot where name-match coverage
// has repeatedly collapsed (drops to ~820 of ~6k channels). No TMDB calls —
// everything is scored against this in-repo fixture corpus.

// Feed channel defs mirror what the XMLTV feed ships: a feed id plus its
// <display-name> aliases. Only ids in `feedWithEpg` (have programmes) are
// indexed. "tntsport1" (singular) and "tntsports1" (plural) are DISTINCT
// normalized names — the feed carries both aliases on the one TNT Sports feed
// channel so either catalog spelling resolves.
const defs: FeedChannelDef[] = [
  { id: 'espn.us', names: ['ESPN', 'US: ESPN', 'ESPN (Backup)'] },
  { id: 'tv3.dk', names: ['TV3', 'TV 3'] },
  // One TNT Sports 1 feed channel, both alias spellings.
  { id: 'tntsports1.uk', names: ['TNT Sport 1', 'TNT Sports 1'] },
  // Ambiguous: two distinct feed ids share the normalized name "sportstv".
  { id: 'sportsa.uk', names: ['Sports TV'] },
  { id: 'sportsb.uk', names: ['Sports TV'] },
  // Feed channel with NO programmes — must never be indexed/matched.
  { id: 'dead.us', names: ['Dead Channel'] },
]
const feedWithEpg = new Set([
  'espn.us',
  'tv3.dk',
  'tntsports1.uk',
  'sportsa.uk',
  'sportsb.uk',
])
const index = buildEpgNameIndex(defs, feedWithEpg)

// Realistic catalog cases: [label, catalogName, epg_channel_id, expectedFeedId|null]
// Positives mirror the prefix/quality-noise examples documented in the resolver.
// Negatives MUST resolve to null (too-generic or ambiguous).
type Case = [string, string, string | null, string | null]

const positives: Case[] = [
  ['country-prefix colon', 'US: ESPN', null, 'espn.us'],
  ['country-prefix pipe', 'USA | ESPN', null, 'espn.us'],
  ['country + FHD bare prefix', 'UK FHD TNT Sport 1', null, 'tntsports1.uk'],
  ['country-prefix dash', 'DK - TV3', null, 'tv3.dk'],
  ['HEVC prefix + FHD suffix', 'HEVC: TNT Sports 1 FHD', null, 'tntsports1.uk'],
  ['quality FHD suffix', 'ESPN FHD', null, 'espn.us'],
  ['quality UHD + fps', 'ESPN UHD 60FPS', null, 'espn.us'],
  ['parenthetical Backup', 'ESPN (Backup)', null, 'espn.us'],
  ['bracketed VIP prefix', '[VIP] ESPN', null, 'espn.us'],
]

const negatives: Case[] = [
  // Too-generic 2-char name → normalizes to null → no match.
  ['too-generic 2-char', 'US: TV', null, null],
  // Ambiguous: "Sports TV" maps to two feed ids → dropped from the index.
  ['ambiguous two-feed name', 'Sports TV', null, null],
  // Feed channel with no programmes.
  ['no-programmes channel', 'Dead Channel', 'dead.us', null],
]

const allCases: Case[] = [...positives, ...negatives]

describe('iptvEpgResolve match-accuracy benchmark', () => {
  // (a) Per-case correctness across the whole corpus.
  it.each(allCases)('resolves %s', (_label, name, epg, expected) => {
    expect(resolveEpgId({ name, epg_channel_id: epg }, index)).toBe(expected)
  })

  // (b) Aggregate accuracy regression floor. Computed from the actual run below
  // (all 9 positives currently resolve → 1.0). This is a floor: if a future
  // normalize change drops coverage, accuracy falls below it and this goes RED.
  it('positive-case accuracy stays above the regression floor', () => {
    const matched = positives.filter(
      ([, name, epg, expected]) =>
        resolveEpgId({ name, epg_channel_id: epg }, index) === expected,
    ).length
    const accuracy = matched / positives.length
    expect(accuracy).toBeGreaterThanOrEqual(1.0)
  })

  // (c) Ambiguity safety — precision over recall: a normalized name shared by
  // two distinct feed ids must NOT appear in the index.
  it('drops the ambiguous shared name from nameToFeedId', () => {
    const ambiguous = normalizeChannelName('Sports TV')
    expect(ambiguous).not.toBeNull()
    expect(index.nameToFeedId.has(ambiguous as string)).toBe(false)
  })
})

describe('titleSimilarity', () => {
  it('returns 1 for identical normalized names', () => {
    expect(titleSimilarity('ESPN', 'ESPN')).toBe(1)
  })

  it('returns 1 when noise tokens normalize two names to the same form', () => {
    // "US: ESPN" and "ESPN FHD" both normalize to "espn".
    expect(titleSimilarity('US: ESPN', 'ESPN FHD')).toBe(1)
  })

  it('returns a low/zero score for disjoint names', () => {
    expect(titleSimilarity('ESPN', 'Fox Sports')).toBeLessThan(0.2)
  })

  it('returns 0 when either input normalizes to null', () => {
    expect(titleSimilarity('US: HD', 'ESPN')).toBe(0)
    expect(titleSimilarity('', 'ESPN')).toBe(0)
  })

  it('always returns a score within [0, 1]', () => {
    const samples = ['US: ESPN', 'ESPN FHD', 'TNT Sports 1', 'Fox Sports', 'TV3', 'CNN']
    for (const a of samples) {
      for (const b of samples) {
        const s = titleSimilarity(a, b)
        expect(s).toBeGreaterThanOrEqual(0)
        expect(s).toBeLessThanOrEqual(1)
      }
    }
  })
})
