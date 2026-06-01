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

describe('streamXmltv sniffBuf bound', () => {
  it('does not grow unbounded when a <channel block the sniffer cannot pair floods junk', async () => {
    // A <channel> open that the sniffer regex never matches (no id="" attribute),
    // followed by ~5MB of junk text. Pre-fix the sniffer pins sniffBuf at the
    // <channel offset and appends forever (OOM risk) because CHANNEL_RE never
    // matches so the trim's lastEnd stays 0. Post-fix the 1MB cap holds and the
    // stream completes cleanly with no channel defs. The XML stays well-formed so
    // the SAX programme parser does not abort — the bound is the only thing under
    // test here.
    const junk = 'x'.repeat(5_000_000)
    async function* gen() {
      yield Buffer.from('<?xml version="1.0"?><tv>')
      // No id="" attribute -> CHANNEL_RE cannot match -> never "closes" for the
      // sniffer even though it is valid XML for SAX.
      yield Buffer.from('<channel><display-name>Broken</display-name>')
      // flood junk (valid character data inside the open element) in several chunks
      for (let i = 0; i < 5; i++) yield Buffer.from(junk.slice(i * 1_000_000, (i + 1) * 1_000_000))
      yield Buffer.from('</channel></tv>')
    }
    const defs: { id: string; names: string[] }[] = []
    await expect(
      streamXmltv(Readable.from(gen()), () => {}, undefined, (d) => defs.push(d)),
    ).resolves.toBeUndefined()
    expect(defs).toHaveLength(0)
  })

  it('still captures a valid <channel> that follows a large junk gap', async () => {
    const junk = 'y'.repeat(2_000_000)
    async function* gen() {
      yield Buffer.from('<?xml version="1.0"?><tv>')
      yield Buffer.from(junk.slice(0, 1_000_000))
      yield Buffer.from(junk.slice(1_000_000))
      yield Buffer.from('<channel id="late.us"><display-name>Late</display-name></channel>')
      yield Buffer.from('</tv>')
    }
    const defs: { id: string; names: string[] }[] = []
    await streamXmltv(Readable.from(gen()), () => {}, undefined, (d) => defs.push(d))
    expect(defs.find((d) => d.id === 'late.us')?.names).toEqual(['Late'])
  })

  it('drops a single <channel> block whose interior exceeds the 1MB cap (proves the bound engages)', async () => {
    // This is the falsifiable witness for the cap. An attacker opens one
    // <channel id="..."> then streams >1MB of junk before the close. WITHOUT the
    // cap the entire (multi-MB) block stays buffered and the channel is matched
    // and emitted. WITH the cap, the trailing-window slice discards the front of
    // the buffer — including the "<channel ... id=" open token — long before the
    // </channel> arrives, so CHANNEL_RE can no longer pair the block and no def is
    // emitted. The dropped def is the observable signature that sniffBuf was held
    // to its 1MB ceiling rather than allowed to grow with the block. The XML stays
    // well-formed (junk is character data inside the open element) so SAX does not
    // abort.
    const junk = 'z'.repeat(2_000_000) // 2MB interior, well over the 1MB cap
    async function* gen() {
      yield Buffer.from('<?xml version="1.0"?><tv>')
      yield Buffer.from('<channel id="huge.us"><display-name>Huge</display-name>')
      for (let i = 0; i < 2; i++) yield Buffer.from(junk.slice(i * 1_000_000, (i + 1) * 1_000_000))
      yield Buffer.from('</channel></tv>')
    }
    const defs: { id: string; names: string[] }[] = []
    await streamXmltv(Readable.from(gen()), () => {}, undefined, (d) => defs.push(d))
    expect(defs.find((d) => d.id === 'huge.us')).toBeUndefined()
  })

  it('captures a <channel> block split across chunk boundaries', async () => {
    const full = '<channel id="split.us"><display-name>Split</display-name></channel>'
    const mid = Math.floor(full.length / 2)
    async function* gen() {
      yield Buffer.from('<?xml version="1.0"?><tv>')
      yield Buffer.from(full.slice(0, mid))
      yield Buffer.from(full.slice(mid))
      yield Buffer.from('</tv>')
    }
    const defs: { id: string; names: string[] }[] = []
    await streamXmltv(Readable.from(gen()), () => {}, undefined, (d) => defs.push(d))
    expect(defs.find((d) => d.id === 'split.us')?.names).toEqual(['Split'])
  })
})
