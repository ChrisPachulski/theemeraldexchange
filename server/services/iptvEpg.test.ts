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
