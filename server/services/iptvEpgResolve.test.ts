import { describe, it, expect } from 'vitest'
import { normalizeChannelName, buildEpgNameIndex, resolveEpgId } from './iptvEpgResolve.js'

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
