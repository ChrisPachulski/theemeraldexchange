// Third-party EPG supplementation.
//
// The Xtream provider's own XMLTV (/epg.xml) only carries schedules for the
// ~6k channels the provider bothered to map — but our catalog has ~50k. Real
// IPTV setups (xTeVe/Threadfin/iptv-org) close this gap by layering a community
// EPG source on top, matched by channel name. iptv-org/epg (28k+ channels) is
// mirrored as aggregated XMLTV at epgshare01; we ingest it here and reuse the
// exact same name-resolver the provider feed uses.
//
// To keep epg_programs lean we DON'T store all 6.7M external programmes — only
// those for channels our catalog actually matches (~8k). The feed is standard
// XMLTV (all <channel> defs precede all <programme>s), so by the first programme
// the channel section is fully parsed: we resolve the still-unresolved catalog
// channels against the external aliases, then store only the matched channels'
// programmes as the rest of the stream flows by.

import { streamXmltv, normalizeEpgChannelId, type XmltvChannelDef, type EpgProgrammeRow } from './iptvEpg.js'
import { webStreamToNodeReadable } from './streamBridge.js'
import { buildEpgNameIndex, resolveEpgId, type FeedChannelDef } from './iptvEpgResolve.js'
import type { IptvDb } from './iptvDb.js'

// Aggregated iptv-org EPG (epgshare01). Comma-separated override via env.
export const DEFAULT_EXTERNAL_EPG_URLS = [
  'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz',
]

export function externalEpgUrls(): string[] {
  const raw = process.env.IPTV_EXTERNAL_EPG_URLS
  if (!raw || !raw.trim()) return DEFAULT_EXTERNAL_EPG_URLS
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

const EXT_FETCH_TIMEOUT_MS = 8 * 60_000

export interface ExternalEpgResult {
  url: string
  ok: boolean
  channelsMatched: number
  programmesStored: number
  error?: string
}

/**
 * Resolve every still-unresolved catalog channel against the external feed's
 * channel aliases, pointing epg_resolved_id at the matched external id and
 * returning the set of external ids we now want programmes for. Only touches
 * channels the provider feed left unresolved, so the provider always wins.
 */
function resolveAgainstExternal(db: IptvDb, defs: XmltvChannelDef[]): { wanted: Set<string>; matched: number } {
  const feedWithEpg = new Set<string>()
  for (const d of defs) {
    const id = normalizeEpgChannelId(d.id)
    if (id) feedWithEpg.add(id)
  }
  const index = buildEpgNameIndex(defs as FeedChannelDef[], feedWithEpg)
  const unresolved = db.raw
    .prepare(`SELECT stream_id, name, epg_channel_id FROM channels WHERE COALESCE(NULLIF(TRIM(epg_resolved_id), ''), '') = ''`)
    .all() as Array<{ stream_id: number; name: string; epg_channel_id: string | null }>

  const setResolved = db.raw.prepare(`UPDATE channels SET epg_resolved_id = ? WHERE stream_id = ?`)
  const wanted = new Set<string>()
  let matched = 0
  const apply = db.raw.transaction((rows: typeof unresolved) => {
    for (const ch of rows) {
      const id = resolveEpgId(ch, index)
      if (id) {
        setResolved.run(id, ch.stream_id)
        wanted.add(id)
        matched += 1
      }
    }
  })
  apply(unresolved)
  return { wanted, matched }
}

export async function ingestExternalEpg(
  db: IptvDb,
  url: string,
  opts: { horizonMs?: number } = {},
): Promise<ExternalEpgResult> {
  const now = Date.now()
  const horizonIso = new Date(now + (opts.horizonMs ?? 7 * 24 * 3600_000)).toISOString()
  const cutoffIso = new Date(now - 24 * 3600_000).toISOString()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error('external_epg_timeout'))
  }, EXT_FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      return { url, ok: false, channelsMatched: 0, programmesStored: 0, error: `http_${res.status}` }
    }
    const src = webStreamToNodeReadable(res.body)

    const defs: XmltvChannelDef[] = []
    let wanted: Set<string> | null = null
    let channelsMatched = 0
    let programmesStored = 0
    let batch: EpgProgrammeRow[] = []
    const flush = db.raw.transaction((rows: EpgProgrammeRow[]) => {
      for (const r of rows) db.stmts.upsertEpg.run(r)
    })

    await streamXmltv(
      src,
      (row) => {
        // First programme ⇒ the channel section is fully parsed (standard XMLTV
        // ordering). Resolve now, once, and learn which external ids to keep.
        if (!wanted) {
          const r = resolveAgainstExternal(db, defs)
          wanted = r.wanted
          channelsMatched = r.matched
        }
        if (!wanted.has(row.channel_id)) return
        if (row.stop_utc < cutoffIso || row.stop_utc > horizonIso) return
        batch.push(row)
        programmesStored += 1
        if (batch.length >= 1000) {
          flush(batch)
          batch = []
        }
      },
      controller.signal,
      (def) => {
        defs.push(def)
      },
    )

    // Feed had channel defs but we never hit a programme (edge) — still resolve.
    if (!wanted) {
      const r = resolveAgainstExternal(db, defs)
      channelsMatched = r.matched
    }
    if (batch.length) flush(batch)
    return { url, ok: true, channelsMatched, programmesStored }
  } catch (e) {
    return { url, ok: false, channelsMatched: 0, programmesStored: 0, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

/** Ingest every configured external EPG source in sequence. */
export async function ingestAllExternalEpg(db: IptvDb): Promise<ExternalEpgResult[]> {
  const out: ExternalEpgResult[] = []
  for (const url of externalEpgUrls()) {
    out.push(await ingestExternalEpg(db, url))
  }
  return out
}
