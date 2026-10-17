// Writes the EPG goldens the Rust iptv tests must match, from the TS stack.
// Run from the repo root while the TS IPTV code still exists (it goes at S8):
//   npx tsx crates/iptv/tests/fixtures/gen-epg-goldens.ts
// Local servers only: the panel, its XMLTV and the external feeds are served
// from 127.0.0.1, never the provider or epgshare01.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TEST_ENV } from '../../../../vitest.env.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'epg-sync-scenario.json'), 'utf8'))
const resolveFixture = JSON.parse(fs.readFileSync(
  path.join(here, '../../../../server/services/__fixtures__/epg-resolve-2026-10-15.json'), 'utf8'))

// The sync reads Date.now() / new Date(); pin both to the scenario's now.
const FIXED = Date.parse(scenario.now)
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(FIXED)
    else super(...(a as [string]))
  }
  static now(): number { return FIXED }
}
globalThis.Date = FixedDate as DateConstructor

let current = 0
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const sync = scenario.syncs[current]
  if (url.pathname === '/player_api.php') {
    const action = url.searchParams.get('action')
    const body = action === 'get_live_categories' ? scenario.live_categories
      : action === 'get_live_streams' ? scenario.live_streams : []
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  } else if (url.pathname === '/xmltv.php') {
    res.end(sync.provider_xml)
  } else if (sync.external[url.pathname] !== undefined) {
    const xml = sync.external[url.pathname]
    res.end(url.pathname.endsWith('.gz') ? gzipSync(Buffer.from(xml)) : xml)
  } else {
    res.statusCode = 404
    res.end()
  }
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

Object.assign(process.env, TEST_ENV, {
  VITEST: '1',
  XTREAM_HOST: base,
  XTREAM_USERNAME: 'u',
  XTREAM_PASSWORD: 'p',
  IPTV_EXTERNAL_EPG_URLS: scenario.external_paths.map((p: string) => base + p).join(','),
})

const { openIptvDb } = await import('../../../../server/services/iptvDb.js')
const { syncOnce } = await import('../../../../server/services/iptvSync.js')
const resolve = await import('../../../../server/services/iptvEpgResolve.js')

// 1. Full mock sync: epg_programs and epg_resolved_id after each sync.
const db = openIptvDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epg-goldens-')), 'iptv.db'))
const syncs = []
for (current = 0; current < scenario.syncs.length; current++) {
  const r = await syncOnce(db)
  syncs.push({
    epg: r.epg,
    epg_programs: db.raw.prepare(`SELECT channel_id, start_utc, stop_utc, title, description, derived
      FROM epg_programs ORDER BY channel_id, start_utc`).all(),
    channels: db.raw.prepare('SELECT stream_id, epg_resolved_id FROM channels ORDER BY stream_id').all(),
  })
}

// 3. The read API on the synced DB (S3): grid, search, now/next and one
//    channel's window, with one feed-check override so the effective-EPG join
//    is exercised. The Rust api tests replay the same calls on the same DB.
const { epgGrid, epgSearch, epgNow, epgChannelWindow } = await import('../../../../server/services/iptvEpgQuery.js')
db.raw.prepare(`INSERT INTO channel_feed_checks (stream_id, verdict, listed_epg_id, actual_epg_id, checked_at)
  VALUES (200163566, 'mislabeled', 'showtime.us', 'cinemaxclassics.us', ?)`).run(scenario.now)
const W = { from: '2026-10-15T02:00:00.000Z', to: '2026-10-15T06:00:00.000Z' }
const DAY = { from: '2026-10-14T00:00:00.000Z', to: '2026-10-16T00:00:00.000Z' }
const gridCases = [
  { window: W, opts: {} },
  { window: W, opts: { hasEpgOnly: true } },
  { window: W, opts: { categoryIds: [1], hasEpgOnly: true, limit: 5 } },
  { window: W, opts: { categoryId: 1, q: 'cmt' } },
  { window: DAY, opts: { q: 'US:', hasEpgOnly: true } },
  { window: W, opts: { categoryIds: [2] } },
]
const searchCases = [
  { window: DAY, opts: { q: 'news' } },
  { window: DAY, opts: { q: 'ten' } },
  { window: W, opts: { q: 'provider' } },
  { window: DAY, opts: { q: 'son of', limit: 1 } },
  { window: DAY, opts: { q: 'e', categoryIds: [1], limit: 3 } },
  { window: W, opts: { q: 'news', categoryIds: [2] } },
]
const streamIds = (db.raw.prepare('SELECT stream_id FROM channels ORDER BY stream_id').all() as Array<{ stream_id: number }>)
  .map((r) => r.stream_id)
const api = {
  grid: gridCases.map((c) => ({ ...c, rows: epgGrid(db, c.window.from, c.window.to, c.opts) })),
  search: searchCases.map((c) => ({ ...c, result: epgSearch(db, c.window.from, c.window.to, c.opts) })),
  now: { ids: [...streamIds, 999999], rows: epgNow(db, [...streamIds, 999999], new Date(scenario.now)) },
  channel: [200163566, 30800, 100, 9].map((id) => ({ id, rows: epgChannelWindow(db, id, DAY.from, DAY.to) })),
}
db.close()
server.close()

// 2. The 2026-10-15 resolver fixture: what each index resolves, not only the
//    guide id the TS test derives from it.
type Def = { id: string; names: string[]; lastStop?: string }
const f = resolveFixture as { provider: Def[]; external: Def[]; catalog: Array<{ name: string; epg_channel_id: string | null }>
  cases: Array<{ stream_id: number; name: string; tvg: string | null }> }
const provider = resolve.buildEpgNameIndex(f.provider, new Set(f.provider.map((d) => d.id)))
provider.catalogTvg = resolve.catalogTvgIndex(f.catalog, provider.feedWithEpg)
provider.lastStop = new Map(f.provider.map((d) => [d.id, d.lastStop!]))
const external = resolve.buildEpgNameIndex(f.external, new Set(f.external.map((d) => d.id)))
const names = new Set<string>()
for (const c of f.catalog) names.add(c.name)
for (const c of f.cases) names.add(c.name)
for (const d of [...f.provider, ...f.external]) for (const n of d.names) names.add(n)
const resolved = {
  catalog_tvg: Object.fromEntries([...provider.catalogTvg].sort()),
  cases: f.cases.map((c) => {
    const ch = { name: c.name, epg_channel_id: c.tvg }
    return {
      stream_id: c.stream_id,
      provider: resolve.resolveEpgId(ch, provider),
      external: resolve.resolveEpgId(ch, external),
      callsign_ids: resolve.callsignIds(ch, external),
    }
  }),
  normalized: Object.fromEntries([...names].sort().map((n) => [n, resolve.normalizeChannelName(n)])),
}

fs.writeFileSync(path.join(here, 'epg-goldens.json'), JSON.stringify({ syncs, resolved, api }, null, 1) + '\n')
console.log('wrote', path.join(here, 'epg-goldens.json'))
