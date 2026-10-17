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

fs.writeFileSync(path.join(here, 'epg-goldens.json'), JSON.stringify({ syncs, resolved }, null, 1) + '\n')
console.log('wrote', path.join(here, 'epg-goldens.json'))
