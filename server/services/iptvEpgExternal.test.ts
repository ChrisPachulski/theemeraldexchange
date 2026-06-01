import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { openIptvDb, type IptvDb } from './iptvDb.js'
import {
  DEFAULT_EXTERNAL_EPG_URLS,
  externalEpgUrls,
  ingestAllExternalEpg,
  ingestExternalEpg,
} from './iptvEpgExternal.js'

const FETCHED_AT = '2026-05-24T12:00:00Z'

// ---- helpers ---------------------------------------------------------------

/** Format ms-since-epoch as an XMLTV timestamp: `YYYYMMDDHHmmss +0000`. */
function xmltvTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
  )
}

/** Build a Web ReadableStream over the XML bytes — the shape `res.body` has. */
function webBody(xml: string): ReadableStream<Uint8Array> {
  // Node's static Readable.toWeb yields a Web ReadableStream the production
  // code can consume via Readable.fromWeb. Fall back to a hand-built stream if
  // the runtime lacks toWeb.
  const node = Readable.from(Buffer.from(xml))
  const toWeb = (Readable as unknown as { toWeb?: (r: Readable) => ReadableStream<Uint8Array> }).toWeb
  if (typeof toWeb === 'function') return toWeb(node)
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(xml))
      c.close()
    },
  })
}

/** Stub global fetch to return `xml` as a 200 response body. */
function stubFetchXml(xml: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, status: 200, body: webBody(xml) }) as unknown as Response)
  vi.stubGlobal('fetch', fn)
  return fn
}

function insertChannel(
  db: IptvDb,
  opts: { stream_id: number; name: string; epg_channel_id?: string | null },
): void {
  db.stmts.upsertChannel.run({
    stream_id: opts.stream_id,
    num: opts.stream_id,
    name: opts.name,
    stream_icon: null,
    epg_channel_id: opts.epg_channel_id ?? null,
    category_id: 1,
    is_adult: 0,
    tv_archive: 0,
    tv_archive_duration: null,
    added_ts: null,
    fetched_at: FETCHED_AT,
  })
}

function resolvedId(db: IptvDb, streamId: number): string | null {
  const row = db.raw
    .prepare(`SELECT epg_resolved_id FROM channels WHERE stream_id = ?`)
    .get(streamId) as { epg_resolved_id: string | null } | undefined
  return row?.epg_resolved_id ?? null
}

function countPrograms(db: IptvDb, channelId: string): number {
  const row = db.raw
    .prepare(`SELECT COUNT(*) AS n FROM epg_programs WHERE channel_id = ?`)
    .get(channelId) as { n: number }
  return row.n
}

// A standard XMLTV doc: all <channel> defs precede all <programme>s.
function buildFeed(
  channels: Array<{ id: string; name: string }>,
  programmes: Array<{ channel: string; startMs: number; stopMs: number; title?: string }>,
): string {
  const chans = channels
    .map((c) => `<channel id="${c.id}"><display-name>${c.name}</display-name></channel>`)
    .join('')
  const progs = programmes
    .map(
      (p) =>
        `<programme channel="${p.channel}" start="${xmltvTime(p.startMs)}" stop="${xmltvTime(p.stopMs)}">` +
        `<title>${p.title ?? 'Show'}</title></programme>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${chans}${progs}</tv>`
}

// ---- tests -----------------------------------------------------------------

describe('externalEpgUrls', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.IPTV_EXTERNAL_EPG_URLS
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.IPTV_EXTERNAL_EPG_URLS
    else process.env.IPTV_EXTERNAL_EPG_URLS = saved
  })

  it('returns DEFAULT_EXTERNAL_EPG_URLS when the env var is unset', () => {
    delete process.env.IPTV_EXTERNAL_EPG_URLS
    expect(externalEpgUrls()).toEqual(DEFAULT_EXTERNAL_EPG_URLS)
  })

  it('returns the default when the env var is whitespace-only', () => {
    process.env.IPTV_EXTERNAL_EPG_URLS = '   '
    expect(externalEpgUrls()).toEqual(DEFAULT_EXTERNAL_EPG_URLS)
  })

  it('splits a comma list, trimming whitespace and dropping empties', () => {
    process.env.IPTV_EXTERNAL_EPG_URLS = ' https://a/x.xml , , https://b/y.xml.gz '
    expect(externalEpgUrls()).toEqual(['https://a/x.xml', 'https://b/y.xml.gz'])
  })
})

describe('ingestExternalEpg — happy path', () => {
  let db: IptvDb
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
  })

  it('resolves a catalog channel by name and stores its in-window programme', async () => {
    // null tvg-id ⇒ must match by name. Feed id "espn.us" strips ".us" → "espn",
    // which equals normalizeChannelName("US: ESPN").
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    const xml = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: now, stopMs: now + 3600_000, title: 'Game' }],
    )
    const fetchFn = stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x')

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(1)
    expect(result.programmesStored).toBe(1)
    expect(resolvedId(db, 100)).toBe('espn.us')
    expect(countPrograms(db, 'espn.us')).toBe(1)
  })
})

describe('ingestExternalEpg — filtering / provider-wins', () => {
  let db: IptvDb
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
  })

  it('does not store a programme whose channel no catalog channel resolves to', async () => {
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    // Feed carries ESPN (matched) defs, but the programme is for an unmatched id.
    const xml = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'unmatched.zz', startMs: now, stopMs: now + 3600_000 }],
    )
    stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(1)
    expect(result.programmesStored).toBe(0)
    expect(countPrograms(db, 'unmatched.zz')).toBe(0)
  })

  it('drops a stale programme (stop before now-24h) even when its channel matched', async () => {
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    const old = now - 48 * 3600_000 // well before the now-24h cutoff
    const xml = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: old, stopMs: old + 3600_000 }],
    )
    stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(1)
    expect(resolvedId(db, 100)).toBe('espn.us') // channel still resolved
    expect(result.programmesStored).toBe(0) // but the stale programme is dropped
    expect(countPrograms(db, 'espn.us')).toBe(0)
  })

  it('drops a programme beyond a tiny horizon', async () => {
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    const far = now + 30 * 24 * 3600_000 // far past a 1s horizon
    const xml = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: far, stopMs: far + 3600_000 }],
    )
    stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x', { horizonMs: 1000 })

    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(1)
    expect(result.programmesStored).toBe(0)
  })

  it('leaves an already-resolved channel untouched and does not re-count it', async () => {
    // Provider already resolved this channel to some id; external pass must skip it.
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    db.raw.prepare(`UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ?`).run('provider.id', 100)
    const now = Date.now()
    const xml = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: now, stopMs: now + 3600_000 }],
    )
    stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(0) // already-resolved channel not re-counted
    expect(resolvedId(db, 100)).toBe('provider.id') // provider wins, untouched
    // espn.us never entered the wanted set, so its programme is not stored.
    expect(result.programmesStored).toBe(0)
    expect(countPrograms(db, 'espn.us')).toBe(0)
  })
})

describe('ingestExternalEpg — error paths', () => {
  let db: IptvDb
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
  })

  it('returns http_<status> when the response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, body: null }) as unknown as Response),
    )

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result).toEqual({
      url: 'http://x',
      ok: false,
      channelsMatched: 0,
      programmesStored: 0,
      error: 'http_503',
    })
  })

  it('returns http_<status> when ok but the body is null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response),
    )

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result).toEqual({
      url: 'http://x',
      ok: false,
      channelsMatched: 0,
      programmesStored: 0,
      error: 'http_200',
    })
  })

  it('returns ok:false with the thrown error message when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(result.channelsMatched).toBe(0)
    expect(result.programmesStored).toBe(0)
  })
})

describe('ingestExternalEpg — channel defs but zero programmes', () => {
  let db: IptvDb
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
  })

  it('resolves channels via the post-stream branch when the feed has no programmes', async () => {
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const xml = buildFeed([{ id: 'espn.us', name: 'ESPN' }], [])
    stubFetchXml(xml)

    const result = await ingestExternalEpg(db, 'http://x')

    expect(result.ok).toBe(true)
    expect(result.channelsMatched).toBe(1)
    expect(result.programmesStored).toBe(0)
    expect(resolvedId(db, 100)).toBe('espn.us')
  })
})

describe('ingestAllExternalEpg', () => {
  let db: IptvDb
  let saved: string | undefined
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
    saved = process.env.IPTV_EXTERNAL_EPG_URLS
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
    if (saved === undefined) delete process.env.IPTV_EXTERNAL_EPG_URLS
    else process.env.IPTV_EXTERNAL_EPG_URLS = saved
  })

  it('ingests each configured url once, in order', async () => {
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    insertChannel(db, { stream_id: 200, name: 'US: CNN', epg_channel_id: null })
    process.env.IPTV_EXTERNAL_EPG_URLS = 'http://a,http://b'
    const now = Date.now()
    const feedA = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: now, stopMs: now + 3600_000 }],
    )
    const feedB = buildFeed(
      [{ id: 'cnn.us', name: 'CNN' }],
      [{ channel: 'cnn.us', startMs: now, stopMs: now + 3600_000 }],
    )
    const calls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, body: webBody(url === 'http://a' ? feedA : feedB) } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchFn)

    const results = await ingestAllExternalEpg(db)

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.url)).toEqual(['http://a', 'http://b'])
    expect(calls).toEqual(['http://a', 'http://b'])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(countPrograms(db, 'espn.us')).toBe(1)
    expect(countPrograms(db, 'cnn.us')).toBe(1)
  })
})
