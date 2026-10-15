import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import {
  normalizeChannelName, buildEpgNameIndex, catalogTvgIndex, resolveEpgId, titleSimilarity, type FeedChannelDef,
} from './iptvEpgResolve.js'

describe('normalizeChannelName', () => {
  it('strips country prefix, quality tags, punctuation', () => {
    expect(normalizeChannelName('US: ESPN')).toBe('espn')
    expect(normalizeChannelName('UK FHD TNT Sport 1')).toBe('tntsport1')
    expect(normalizeChannelName('HEVC: TNT Sports 1 FHD')).toBe('tntsports1')
    // Parenthetical qualifiers are stripped — matches the feed's own normalized
    // aliases (a feed channel carries a bare "CBS" alias that this resolves to).
    expect(normalizeChannelName('US: CBS (New York)')).toBe('cbs')
  })

  it('keeps a West feed and the USA in USA Network', () => {
    expect(normalizeChannelName('US: Oxygen (West)')).toBe('oxygenwest')
    expect(normalizeChannelName('USA Network HD (Pacific)')).toBe('usanetworkwest')
    expect(normalizeChannelName('US: USA NETWORK WEST')).toBe('usanetworkwest')
    expect(normalizeChannelName('USA HGTV')).toBe('hgtv')
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

describe('resolveEpgId vetoes (2026-10-15 guide audit)', () => {
  const index = (defs: FeedChannelDef[], lastStop: Record<string, string> = {}) => {
    const ix = buildEpgNameIndex(defs, new Set(defs.map((d) => d.id)))
    ix.lastStop = new Map(Object.entries(lastStop))
    return ix
  }
  const resolve = (name: string, defs: FeedChannelDef[], tvg: string | null = null) =>
    resolveEpgId({ name, epg_channel_id: tvg }, index(defs))

  it('lists a station by its callsign, preferring the id whose schedule runs longest', () => {
    const ix = index([
      { id: 'cbskztv.us', names: ['CBS 10 Corpus Christi'] },
      { id: 'cbskztvcorpuschristitx.us', names: [] },
    ], { 'cbskztv.us': '2026-10-15T12:00:00.000Z', 'cbskztvcorpuschristitx.us': '2026-10-17T23:00:00.000Z' })
    expect(resolveEpgId({ name: 'US: CBS 10 Corpus Christi (KZTV)', epg_channel_id: 'cbs10kztv.us' }, ix))
      .toBe('cbskztvcorpuschristitx.us')
  })

  it("never lists another market's station or a bare network id for a station", () => {
    // wcbs.us is WCBS New York; abc5.us is KOCO Oklahoma City; fox.us is a placeholder.
    expect(resolve('US: CBS 2 Pittsburgh (KDKA)', [{ id: 'wcbs.us', names: ['CBS 2 Pittsburgh'] }])).toBeNull()
    expect(resolve('US: ABC 6 Philadelphia (WPVI)', [{ id: 'abc5.us', names: ['ABC 6 Philadelphia'] }])).toBeNull()
    expect(resolve('US: FOX 13 Seattle (KCPQ)', [{ id: 'fox.us', names: ['FOX 13 Seattle'] }])).toBeNull()
    expect(resolve('US: MyTV (New Jersey)', [{ id: 'mytv.us', names: ['MyTV'] }])).toBeNull()
    // Without a callsign id, the station's own city still counts.
    expect(resolve('US: ABC 30 Fresno (KFSN)', [{ id: 'abc30fresno.us', names: [] }])).toBe('abc30fresno.us')
    expect(resolve('US: Telemundo', [{ id: 'telemundo.us', names: [] }])).toBe('telemundo.us')
  })

  it('never crosses networks, even on the callsign', () => {
    expect(resolve('US: NBC 2 Orlando (WESH)', [{ id: 'abcorlando.us', names: ['NBC 2 Orlando'] }])).toBeNull()
    expect(resolve('US: NBC 3 Cleveland (WKYC)', [{ id: 'cnbc.us', names: ['NBC 3 Cleveland'] }])).toBeNull()
    expect(resolve('US: Telemundo El Paso (KTSM)', [{ id: 'nbcktsmelpasotx.us', names: [] }])).toBeNull()
  })

  it('does not honor a junk tvg-id', () => {
    expect(resolve('US: ABC 3 Mobile (WEAR)', [{ id: 'dubai.ae', names: ['Dubai TV'] }], 'dubai.ae')).toBeNull()
    expect(resolve('US: News 12 New Jersey', [{ id: 'dubai.ae', names: [] }], 'dubai.ae')).toBeNull()
    expect(resolve('US: Al Jazeera', [{ id: 'aljazeera.english.net', names: [] }], 'aljazeera.english.net'))
      .toBe('aljazeera.english.net')
    expect(resolve('US: GINX eSports', [{ id: 'ginx.esports.gr', names: ['GINX eSports'] }], 'ginxesportstvcanada.ca'))
      .toBeNull()
  })

  it('keeps the coast, sub-brand and channel number of the name', () => {
    expect(resolve('US: SHOWTIME WEST', [{ id: 'showtime2west.us', names: ['Showtime West'] }])).toBeNull()
    expect(resolve('US: Oxygen (West)', [{ id: 'oxygen.us', names: ['Oxygen'] }, { id: 'oxygenwest.us', names: [] }]))
      .toBe('oxygenwest.us')
    expect(resolve('US: DISNEY JR WEST HD', [{ id: 'disney.us', names: ['Disney Jr West'] }])).toBeNull()
    expect(resolve('US: SPECTRUM SPORTSNET DODGERS', [
      { id: 'spectrumsportsnet.us', names: ['Spectrum SportsNet Dodgers'] },
      { id: 'spectrumsportsnetla.us', names: [] },
    ])).toBe('spectrumsportsnetla.us')
    // The provider's own tag says which feed a stream carries.
    expect(resolve('US: IndiePlex (West)', [{ id: 'indieplex.us', names: [] }], 'indieplex.us')).toBe('indieplex.us')
  })

  it('finds renamed channels under their feed id', () => {
    const defs = [
      { id: 'hbohits.ph', names: ['HBO Hits'] }, { id: 'hbo2.us', names: [] }, { id: 'hbo2west.us', names: [] },
      { id: 'showtime.us', names: ['Showtime BET'] }, { id: 'shoxbet.us', names: [] },
      { id: 'snews.us', names: ['Newsy'] }, { id: 'scrippsnews.us', names: [] },
    ]
    expect(resolve('US: HBO Hits', defs, '3778')).toBe('hbo2.us')
    expect(resolve('US HBO Hits (West) (H)', defs)).toBe('hbo2west.us')
    expect(resolve('US: SHOWTIME BET', defs)).toBe('shoxbet.us')
    expect(resolve('US: NEWSY HD', defs, 'newsy.us')).toBe('scrippsnews.us')
  })

  it('takes the tvg-id same-named streams agree on, and the US id of a brand every country carries', () => {
    const defs = [{ id: 'cnbc.us', names: [] }, { id: 'disneyjunior.us', names: [] }, { id: 'disneyjunior.ca', names: [] }]
    const ix = index(defs)
    ix.catalogTvg = catalogTvgIndex([
      { name: 'US CNBC (A)', epg_channel_id: 'cnbc.us' },
      { name: 'US: CNBC', epg_channel_id: 'cnbc.us' },
      { name: 'US CNBC (S)', epg_channel_id: null },
    ], ix.feedWithEpg)
    expect(resolveEpgId({ name: 'US CNBC (S)', epg_channel_id: null }, ix)).toBe('cnbc.us')
    expect(resolveEpgId({ name: 'US: DISNEY JR EAST HD', epg_channel_id: null }, ix)).toBe('disneyjunior.us')
    expect(resolveEpgId({ name: 'CA: Disney Junior', epg_channel_id: null }, ix)).toBeNull()
  })

  it("never lists the provider's CINEBOX genre loops", () => {
    expect(resolve('CINEBOX: ACTION', [{ id: 'cinemaxactionwest.us', names: ['CINEBOX: ACTION'] }])).toBeNull()
  })

  // Every guide row the 2026-10-15 audit judged, from the production snapshot:
  // the re-judged wrong rows at their correct id (or none), the right rows
  // unchanged or moved to the same station's longer schedule. Each case's
  // `why` says why it differs from `was`.
  it('lists every audited guide row as the audit settled it', () => {
    type Def = FeedChannelDef & { lastStop?: string; stored?: boolean }
    const f = JSON.parse(fs.readFileSync(new URL('./__fixtures__/epg-resolve-2026-10-15.json', import.meta.url), 'utf8')) as {
      provider: Def[]; external: Def[]; catalog: Array<{ name: string; epg_channel_id: string | null }>
      cases: Array<{ stream_id: number; name: string; tvg: string | null; expect: string | null }>
    }
    const provider = buildEpgNameIndex(f.provider, new Set(f.provider.map((d) => d.id)))
    provider.catalogTvg = catalogTvgIndex(f.catalog, provider.feedWithEpg)
    provider.lastStop = new Map(f.provider.map((d) => [d.id, d.lastStop!]))
    const external = buildEpgNameIndex(f.external, new Set(f.external.map((d) => d.id)))
    const stored = new Set(f.external.filter((d) => d.stored).map((d) => d.id))
    // Provider feed first, then the external one, keeping only ids it stored.
    const resolve = (ch: { name: string; epg_channel_id: string | null }) => {
      const id = resolveEpgId(ch, provider) ?? resolveEpgId(ch, external)
      return id && (provider.feedWithEpg.has(id) || stored.has(id)) ? id : null
    }
    expect(f.cases.length).toBeGreaterThan(290)
    const wrong = f.cases
      .map((c) => ({ stream_id: c.stream_id, name: c.name, expect: c.expect, got: resolve({ name: c.name, epg_channel_id: c.tvg }) }))
      .filter((c) => c.got !== c.expect)
    expect(wrong).toEqual([])
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
