import { describe, it, expect } from 'vitest'
import { parseXmltvProgramme, xmltvTimeToIso, streamXmltv } from './iptvEpg.js'
import { Readable } from 'node:stream'

describe('xmltv helpers', () => {
  it('parses xmltv UTC offset times', () => {
    expect(xmltvTimeToIso('20260524103000 +0000')).toBe('2026-05-24T10:30:00.000Z')
    expect(xmltvTimeToIso('20260524103000 -0400')).toBe('2026-05-24T14:30:00.000Z')
  })

  it('streams a programme element with title + desc', async () => {
    const xml = `<?xml version="1.0"?><tv>
      <programme start="20260524103000 +0000" stop="20260524110000 +0000" channel="c.1">
        <title>Hello</title><desc>World</desc>
      </programme>
    </tv>`
    const results: ReturnType<typeof parseXmltvProgramme>[] = []
    await streamXmltv(Readable.from(Buffer.from(xml)), (p) => results.push(p))
    expect(results).toEqual([
      { channel_id: 'c.1', start_utc: '2026-05-24T10:30:00.000Z', stop_utc: '2026-05-24T11:00:00.000Z', title: 'Hello', description: 'World' },
    ])
  })

  it('captures <channel> definitions via onChannelDef (regression: sniffer wire-up)', async () => {
    const xml = `<?xml version="1.0"?><tv>
      <channel id="cnn.us"><display-name>CNN</display-name><display-name>US: CNN</display-name></channel>
      <channel id="espn.us"><display-name>ESPN</display-name></channel>
      <programme start="20260524103000 +0000" stop="20260524110000 +0000" channel="cnn.us"><title>News</title></programme>
    </tv>`
    const rows: ReturnType<typeof parseXmltvProgramme>[] = []
    const defs: { id: string; names: string[] }[] = []
    await streamXmltv(Readable.from(Buffer.from(xml)), (p) => rows.push(p), undefined, (d) => defs.push(d))
    expect(rows).toHaveLength(1)
    // Without the `xmlStream.on('data', onSniffData)` wire-up in streamXmltv this
    // array is empty, channelDefs never reaches resolveEpgChannels, and name-based
    // EPG matching silently degrades to exact-tvg only (~820 channels instead of
    // ~14k). This guards that line — the shared-tree race has swept it before.
    expect(defs).toHaveLength(2)
    expect(defs.find((d) => d.id === 'cnn.us')?.names).toEqual(['CNN', 'US: CNN'])
    expect(defs.find((d) => d.id === 'espn.us')?.names).toEqual(['ESPN'])
  })
})

describe('xmltvTimeToIso offset normalization', () => {
  it('normalizes a half-hour positive offset (India, +0530)', () => {
    expect(xmltvTimeToIso('20260524103000 +0530')).toBe('2026-05-24T05:00:00.000Z')
  })

  it('normalizes a quarter-hour positive offset rolling back a day (Chatham, +1245)', () => {
    expect(xmltvTimeToIso('20260524103000 +1245')).toBe('2026-05-23T21:45:00.000Z')
  })

  it('parses an offset with no space separator', () => {
    expect(xmltvTimeToIso('20260524103000+0000')).toBe('2026-05-24T10:30:00.000Z')
  })

  it('handles a positive offset crossing a year boundary backward in UTC', () => {
    expect(xmltvTimeToIso('20251231233000 +0100')).toBe('2025-12-31T22:30:00.000Z')
  })

  it('handles a negative offset crossing a year boundary forward in UTC', () => {
    expect(xmltvTimeToIso('20260101003000 -0100')).toBe('2026-01-01T01:30:00.000Z')
  })

  it('trims surrounding whitespace', () => {
    expect(xmltvTimeToIso('  20260524103000 +0000  ')).toBe('2026-05-24T10:30:00.000Z')
  })
})

describe('xmltvTimeToIso rejects malformed input', () => {
  it('throws when the offset is missing entirely', () => {
    expect(() => xmltvTimeToIso('20260524103000')).toThrow(/xmltv_time_bad_format/)
  })

  it('throws on a literal Z (not a numeric offset)', () => {
    expect(() => xmltvTimeToIso('20260524103000 Z')).toThrow(/xmltv_time_bad_format/)
  })

  it('throws on non-time garbage', () => {
    expect(() => xmltvTimeToIso('not-a-time')).toThrow(/xmltv_time_bad_format/)
  })

  it('throws on a colon-delimited offset', () => {
    expect(() => xmltvTimeToIso('20260524103000 +05:30')).toThrow(/xmltv_time_bad_format/)
  })

  it('throws on a too-short (13-digit) datetime', () => {
    expect(() => xmltvTimeToIso('2026052410300 +0000')).toThrow(/xmltv_time_bad_format/)
  })
})
