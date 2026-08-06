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
import { __setSsrfLookupForTests } from './ssrfGuard.js'

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

/**
 * Stub fetch as an aggregator that 302s to `target`, modelling REAL platform
 * fetch redirect semantics: with the WHATWG default `redirect: 'follow'` the
 * runtime follows the 30x itself and hands back the TARGET's response, so the
 * caller never sees the hop. Only `redirect: 'manual'` — which the SSRF egress
 * loop sets — surfaces the 302 for re-validation.
 *
 * So the un-guarded plain-`fetch()` code path gets `payload` (the internal
 * target's body) as a clean 200 and ingests it; the guarded path gets the 302
 * and must refuse before the second hop. A request to any url OTHER than
 * `origin` means the redirect target was dialed, and also answers with the
 * payload — so a guard that fails open surfaces as ingested rows, not an error.
 */
function stubFetchRedirect(origin: string, target: string, payload: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== origin || init?.redirect !== 'manual') {
      return { ok: true, status: 200, body: webBody(payload) } as unknown as Response
    }
    return new Response(null, { status: 302, headers: { location: target } })
  })
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

describe('ingestExternalEpg — SSRF redirect guard', () => {
  let db: IptvDb
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'extepg-'))
    db = openIptvDb(path.join(tmp, 'iptv.db'))
  })
  afterEach(() => {
    db.close()
    vi.unstubAllGlobals()
  })

  it('refuses a 302 into cloud metadata (169.254.169.254) and never dials it', async () => {
    // The external EPG feed is a THIRD-PARTY aggregator. Its URL is operator-
    // configured (trusted initial hop), but the 30x it answers with is not: a
    // compromised/hostile mirror can bounce ingestion at the link-local cloud
    // metadata address and have the server fetch + parse whatever comes back.
    // With plain fetch() the platform follows that redirect silently, so this
    // ingests the internal payload and reports ok:true. guardedFetchTrustedOrigin
    // sets redirect:'manual' and re-validates every hop, so the metadata address
    // is refused before a second request is issued.
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    const internalPayload = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: now, stopMs: now + 3600_000, title: 'Leaked' }],
    )
    const fetchFn = stubFetchRedirect(
      'https://epgshare01.example/all.xml.gz',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      internalPayload,
    )

    const result = await ingestExternalEpg(db, 'https://epgshare01.example/all.xml.gz')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/blocked non-public upstream/)
    expect(result.error).toContain('169.254.169.254')
    // The decisive assertion: exactly ONE request left the box — the trusted
    // origin. The redirect target was never dialed.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0][0]).toBe('https://epgshare01.example/all.xml.gz')
    // Nothing from the internal target was parsed or persisted.
    expect(result.channelsMatched).toBe(0)
    expect(result.programmesStored).toBe(0)
    expect(countPrograms(db, 'espn.us')).toBe(0)
    expect(resolvedId(db, 100)).toBe(null)
  })

  it('refuses a 302 into a loopback/internal service host', async () => {
    const fetchFn = stubFetchRedirect(
      'https://epgshare01.example/all.xml.gz',
      'http://localhost:8000/admin',
      buildFeed([], []),
    )

    const result = await ingestExternalEpg(db, 'https://epgshare01.example/all.xml.gz')

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/blocked non-public upstream/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('still follows a public->public redirect to the real mirror (guard is not a blanket block)', async () => {
    // Legitimate CDN behaviour must keep working: epgshare01 30x-ing to its own
    // mirror resolves normally through the guarded egress loop.
    insertChannel(db, { stream_id: 100, name: 'US: ESPN', epg_channel_id: null })
    const now = Date.now()
    const feed = buildFeed(
      [{ id: 'espn.us', name: 'ESPN' }],
      [{ channel: 'espn.us', startMs: now, stopMs: now + 3600_000 }],
    )
    // 8.8.8.8 is public, so the resolve-and-validate hop passes deterministically
    // without touching real DNS.
    __setSsrfLookupForTests(async () => [{ address: '8.8.8.8' }])
    const fetchFn = stubFetchRedirect(
      'https://epgshare01.example/all.xml.gz',
      'https://mirror.example.com/all.xml',
      feed,
    )
    try {
      const result = await ingestExternalEpg(db, 'https://epgshare01.example/all.xml.gz')

      expect(result.ok).toBe(true)
      expect(result.programmesStored).toBe(1)
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(fetchFn.mock.calls[1][0]).toBe('https://mirror.example.com/all.xml')
    } finally {
      __setSsrfLookupForTests(null)
    }
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
