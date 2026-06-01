import { describe, it, expect } from 'vitest'
import { normalizeChannelName, buildEpgNameIndex, resolveEpgId, titleSimilarity } from './iptvEpgResolve.js'

describe('normalizeChannelName', () => {
  it('strips country prefix, quality tags, punctuation', () => {
    expect(normalizeChannelName('US: ESPN')).toBe('espn')
    expect(normalizeChannelName('UK FHD TNT Sport 1')).toBe('tntsport1')
    expect(normalizeChannelName('HEVC: TNT Sports 1 FHD')).toBe('tntsports1')
    // Parenthetical qualifiers are stripped — matches the feed's own normalized
    // aliases (a feed channel carries a bare "CBS" alias that this resolves to).
    expect(normalizeChannelName('US: CBS (New York)')).toBe('cbs')
  })

  it('returns null for too-short or empty names', () => {
    expect(normalizeChannelName('')).toBeNull()
    expect(normalizeChannelName(null)).toBeNull()
    expect(normalizeChannelName('US: HD')).toBeNull() // all tokens stripped
  })
})

describe('buildEpgNameIndex + resolveEpgId', () => {
  const defs = [
    { id: 'espn.us', names: ['ESPN', 'US: ESPN', 'ESPN (Backup)'] },
    { id: 'cnn.us', names: ['CNN', 'US: CNN'] },
    // Two different feed channels share a normalized name "sportstv" → ambiguous
    { id: 'sportsa.uk', names: ['Sports TV'] },
    { id: 'sportsb.uk', names: ['Sports TV'] },
    // A feed channel with NO programmes — must never be indexed.
    { id: 'dead.us', names: ['Dead Channel'] },
  ]
  const feedWithEpg = new Set(['espn.us', 'cnn.us', 'sportsa.uk', 'sportsb.uk'])
  const index = buildEpgNameIndex(defs, feedWithEpg)

  it('resolves by exact tvg-id (authoritative)', () => {
    expect(resolveEpgId({ name: 'whatever', epg_channel_id: 'ESPN.us' }, index)).toBe('espn.us')
  })

  it('resolves by name/alias when tvg-id does not match the feed', () => {
    // catalog tagged espn2.us (not in feed) but named "US: ESPN" → matches alias
    expect(resolveEpgId({ name: 'US: ESPN', epg_channel_id: 'espn2.us' }, index)).toBe('espn.us')
    // no tvg-id at all, name matches
    expect(resolveEpgId({ name: 'HEVC CNN FHD', epg_channel_id: null }, index)).toBe('cnn.us')
  })

  it('drops ambiguous names (same normalized name on two feed ids)', () => {
    expect(resolveEpgId({ name: 'Sports TV', epg_channel_id: null }, index)).toBeNull()
  })

  it('never matches a feed channel that has no programmes', () => {
    expect(resolveEpgId({ name: 'Dead Channel', epg_channel_id: 'dead.us' }, index)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveEpgId({ name: 'Totally Unknown XYZ', epg_channel_id: 'nope.zz' }, index)).toBeNull()
  })
})

describe('titleSimilarity', () => {
  it('returns 1 when both names normalize to the same form', () => {
    // "US: ESPN" and "ESPN FHD" both normalize to "espn"
    expect(titleSimilarity('US: ESPN', 'ESPN FHD')).toBe(1)
  })

  it('returns 0 for disjoint normalized forms', () => {
    expect(titleSimilarity('ESPN', 'CNN')).toBe(0)
  })

  it('returns 0 when either input normalizes to null (too short)', () => {
    expect(titleSimilarity('US: HD', 'ESPN')).toBe(0) // first normalizes to null
    expect(titleSimilarity('ESPN', '')).toBe(0)
    expect(titleSimilarity('US: HD', 'UK SD')).toBe(0) // both null
  })

  it('returns the Jaccard trigram similarity for partially overlapping names', () => {
    // "TNT Sports 1" -> "tntsports1", "TNT Sports 2" -> "tntsports2"
    // shared trigrams give 7/9 overlap.
    expect(titleSimilarity('TNT Sports 1', 'TNT Sports 2')).toBeCloseTo(0.7777777, 5)
  })

  it('is symmetric in its arguments', () => {
    const ab = titleSimilarity('Disney Channel', 'Disney XD')
    const ba = titleSimilarity('Disney XD', 'Disney Channel')
    expect(ab).toBe(ba)
    expect(ab).toBeGreaterThan(0)
    expect(ab).toBeLessThan(1)
  })
})
