import { afterEach, describe, it, expect, vi } from 'vitest'
import { xmltvTimeToIso, streamXmltv, fetchAndStreamEpg, type EpgProgrammeRow } from './iptvEpg.js'
import { SsrfBlockedError, __setSsrfLookupForTests } from './ssrfGuard.js'
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
    const results: EpgProgrammeRow[] = []
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
    const rows: EpgProgrammeRow[] = []
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

describe('fetchAndStreamEpg SSRF redirect guard', () => {
  const PANEL = 'http://panel.example.com'
  const CREDS = { host: PANEL, username: 'example-user', password: 'placeholder' }

  /** A Web ReadableStream over `xml` — the shape `res.body` has. */
  function webBody(xml: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from(Buffer.from(xml))) as unknown as ReadableStream<Uint8Array>
  }

  /**
   * Stub fetch as the Xtream panel 302-ing to `target`. Models REAL platform
   * fetch semantics: with the WHATWG default `redirect: 'follow'` the runtime
   * follows the hop itself and returns the TARGET's response, so unguarded code
   * parses internal bytes without ever seeing the redirect. Only the SSRF egress
   * loop's `redirect: 'manual'` surfaces the 302 for re-validation. Any request
   * to a NON-panel url is the redirect target being dialed, and answers with the
   * payload — so a guard that fails open shows up as parsed rows, not an error.
   */
  function stubFetchRedirect(target: string, payload: string) {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      const isPanel = url.startsWith(PANEL)
      if (!isPanel || init?.redirect !== 'manual') {
        return { ok: true, status: 200, body: webBody(payload) } as unknown as Response
      }
      return new Response(null, { status: 302, headers: { location: target } })
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    __setSsrfLookupForTests(null)
  })

  it('rejects a panel 302 into cloud metadata instead of parsing the target response', async () => {
    // The panel host is operator-configured (trusted initial hop) — but the
    // redirect it answers with is attacker-influenceable, exactly like the
    // live-segment and catchup routes that already guard this same host. With
    // plain fetch() the platform follows the hop and streamXmltv happily parses
    // whatever the internal address returned; guardedFetchTrustedOrigin refuses
    // it before a second request leaves the box.
    const internalXml =
      `<?xml version="1.0"?><tv><programme start="20260524103000 +0000" ` +
      `stop="20260524110000 +0000" channel="leak.1"><title>Leaked</title></programme></tv>`
    const fetchFn = stubFetchRedirect('http://169.254.169.254/latest/meta-data/', internalXml)
    const rows: EpgProgrammeRow[] = []

    const err = await fetchAndStreamEpg((r) => rows.push(r), CREDS).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(SsrfBlockedError)
    expect(String(err)).toMatch(/blocked non-public upstream.*169\.254\.169\.254/)
    // Nothing from the redirect target was parsed...
    expect(rows).toHaveLength(0)
    // ...and only the trusted panel was ever dialed.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0][0]).startsWith(PANEL)).toBe(true)
  })

  it('rejects a panel 302 into an internal service hostname', async () => {
    const fetchFn = stubFetchRedirect('http://recommender:8000/x', '<?xml version="1.0"?><tv></tv>')
    await expect(fetchAndStreamEpg(() => {}, CREDS)).rejects.toBeInstanceOf(SsrfBlockedError)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('still follows a public->public panel redirect and streams the final feed', async () => {
    // The guard must not break the legitimate case: panels routinely 30x to a
    // separate public CDN. 8.8.8.8 keeps resolve-and-validate off real DNS.
    __setSsrfLookupForTests(async () => [{ address: '8.8.8.8' }])
    const xml =
      `<?xml version="1.0"?><tv><programme start="20260524103000 +0000" ` +
      `stop="20260524110000 +0000" channel="cnn.us"><title>News</title></programme></tv>`
    const fetchFn = stubFetchRedirect('https://cdn.example.com/xmltv.php', xml)
    const rows: EpgProgrammeRow[] = []

    await fetchAndStreamEpg((r) => rows.push(r), CREDS)

    expect(rows.map((r) => r.title)).toEqual(['News'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[1][0]).toBe('https://cdn.example.com/xmltv.php')
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
