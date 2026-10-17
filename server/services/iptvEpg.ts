import { Readable } from 'node:stream'
import { env } from '../env.js'
import { contracts } from './contractsBinding.js'
import { webStreamToNodeReadable } from './streamBridge.js'
import { guardedFetchTrustedOrigin } from './ssrfGuard.js'
import type { IptvDb } from './iptvDb.js'

const EPG_FETCH_TIMEOUT_MS = 5 * 60_000
const EPG_WALL_TIMEOUT_MS = 30 * 60_000

export interface EpgProgrammeRow {
  channel_id: string
  start_utc: string
  stop_utc: string
  title: string | null
  description: string | null
}

/**
 * Canonical form for an EPG channel id (tvg-id). Lowercased + trimmed so the
 * stream-catalog side (which preserves the provider's mixed case, e.g.
 * "CNBC.us") joins the XMLTV side (emitted lowercase, e.g. "cnbc.us"). Shared
 * by xtream.parseLiveStreams (channel side) and streamXmltv (programme side) so
 * both namespaces are written in the same form. Returns null for empty/missing.
 */
export function normalizeEpgChannelId(id: string | null | undefined): string | null {
  if (id == null) return null
  const v = id.trim().toLowerCase()
  return v.length > 0 ? v : null
}

export function xmltvTimeToIso(s: string): string {
  // Format: YYYYMMDDhhmmss [+-]HHMM
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/)
  if (!m) throw new Error(`xmltv_time_bad_format:${s}`)
  const [, y, mo, d, h, mi, se, off] = m
  const sign = off[0] === '+' ? 1 : -1
  const offH = Number(off.slice(1, 3))
  const offM = Number(off.slice(3, 5))
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
    - sign * (offH * 60 + offM) * 60_000
  return new Date(utcMs).toISOString()
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
}

export interface XmltvChannelDef {
  id: string
  names: string[]
}

/**
 * Parse an XMLTV feed (plain or gzipped, detected from its first two bytes)
 * as it streams in, calling onProgramme per programme and onChannelDef per
 * <channel> alias block. The parsing runs in Rust (XmltvParser,
 * crates/emerald-contracts-napi/src/xmltv.rs); malformed XML or a corrupt
 * gzip stream rejects.
 *
 * Channel defs come from a regex sniffer over the raw text, not the XML
 * parser: this provider's feed once had unescaped '&' in <display-name>,
 * which the strict parser skipped, emitting zero <channel> tags from the
 * 151MB feed while every <programme> still parsed. The sniffer scans the whole
 * stream (some channel defs follow the first <programme>) and keeps at most
 * one partial <channel> block buffered, capped at 1MB for a block that never
 * closes. Without it name-based EPG matching degrades to exact-tvg only (~820
 * channels instead of ~12k).
 */
export async function streamXmltv(
  input: Readable,
  onProgramme: (row: EpgProgrammeRow) => void,
  signal?: AbortSignal,
  onChannelDef?: (def: XmltvChannelDef) => void,
): Promise<void> {
  if (signal?.aborted) throw abortReason(signal)
  const parser = new contracts.XmltvParser(Boolean(onChannelDef))
  // Defs first: iptvEpgExternal resolves against the defs seen by the first programme.
  const emit = (json: string): void => {
    const batch = JSON.parse(json) as { programmes: EpgProgrammeRow[]; channels: XmltvChannelDef[] }
    for (const def of batch.channels) onChannelDef?.(def)
    for (const row of batch.programmes) onProgramme(row)
  }
  // Abort rejects at once: destroying a stalled source can wait forever.
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason = abortReason(signal as AbortSignal)
      reject(reason)
      input.destroy(reason)
    }
  })
  signal?.addEventListener('abort', onAbort, { once: true })
  const consume = async (): Promise<void> => {
    for await (const chunk of input) {
      emit(parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string)))
    }
    emit(parser.finish())
  }
  try {
    await Promise.race([consume(), aborted])
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function fetchAndStreamEpg(
  onProgramme: (row: EpgProgrammeRow) => void,
  hostOverride?: { host: string; username: string; password: string },
  onChannelDef?: (def: XmltvChannelDef) => void,
): Promise<void> {
  const host = (hostOverride?.host ?? env.XTREAM_HOST).replace(/\/+$/, '')
  const user = hostOverride?.username ?? env.XTREAM_USERNAME
  const pass = hostOverride?.password ?? env.XTREAM_PASSWORD
  const epgPath = (env.IPTV_EPG_PATH ?? '/xmltv.php').replace(/^([^/])/, '/$1')
  const url = `${host}${epgPath}?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
  const controller = new AbortController()
  const idleMs = Math.max(env.IPTV_LIST_TIMEOUT_MS, EPG_FETCH_TIMEOUT_MS)
  const abortWith = (label: 'epg_idle_timeout' | 'epg_wall_timeout') => {
    if (!controller.signal.aborted) controller.abort(new Error(label))
  }
  const wallTimer = setTimeout(() => abortWith('epg_wall_timeout'), EPG_WALL_TIMEOUT_MS)
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abortWith('epg_idle_timeout'), idleMs)
  }
  try {
    resetIdleTimer()
    // SSRF: same trusted-creds Xtream origin the segment/catchup routes guard —
    // the panel URL is operator-configured, but any 30x it issues is
    // attacker-influenceable and is re-validated before being followed.
    const res = await guardedFetchTrustedOrigin(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`xtream.xmltv_${res.status}`)
    const source = webStreamToNodeReadable(res.body)
    const nodeStream = Readable.from((async function* () {
      for await (const chunk of source) {
        resetIdleTimer()
        yield chunk
      }
    })())
    await streamXmltv(nodeStream, onProgramme, controller.signal, onChannelDef)
  } catch (err) {
    if (controller.signal.aborted) throw abortReason(controller.signal)
    throw err
  } finally {
    clearTimeout(wallTimer)
    if (idleTimer) clearTimeout(idleTimer)
  }
}

// 2026-10-15: feeds fill slots they have no listing for with filler titles.
// fox.us carried nothing but "No Match Today" and "SIGN OFF", so 11 Fox locals
// resolved to it and their guide rows said "No Match Today" all day; others:
// smithsonianchannel.us "Channel No Longer Available", hbohits.ph "No Data",
// outdoorchannel.us a 4h "Channel Off Air" over its real schedule. Filler is
// not stored, so an id that only has filler has no EPG and resolution can look
// elsewhere.
// ponytail: exact titles seen in the 2026-10-15 snapshot (case and punctuation
// folded); a new filler wording shows until it is added here. Not "Unknown":
// every such row in the snapshot was the 2011 or 2006 film.
const PLACEHOLDER_TITLES = new Set([
  'no match today', 'sign off', 'signing off', 'to be announced', 'movie to be announced', 'tba', 'tbd',
  'channel off air', 'off air', 'no data', 'no event today', 'channel no longer available',
  'programming will resume shortly', 'end of transmission',
])

export function isPlaceholderTitle(title: string | null): boolean {
  return title != null && PLACEHOLDER_TITLES.has(title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
}

/**
 * Collect one feed's programmes, then make them each delivered channel id's
 * schedule from its first delivered start on. 2026-10-15: the sync upserted by
 * (channel, start), so a programme whose start moved between syncs stayed next
 * to its replacement, and 47 guide rows showed stacked or interleaved
 * schedules (cinemaxclassics.us, a hallmark.us layer 7h off, disneyjrwest.us).
 * Rows wait in a temp table and land in one transaction after the feed parsed
 * cleanly, so a failed fetch changes nothing, and an id the feed did not
 * deliver keeps its rows. An id that delivered only filler is cleared.
 */
export function stageEpg(db: IptvDb): {
  add: (row: EpgProgrammeRow) => boolean
  commit: () => { ids: Set<string>; replaced: number; placeholders: number }
} {
  db.raw.exec(`DROP TABLE IF EXISTS temp.epg_stage;
    CREATE TEMP TABLE epg_stage (channel_id TEXT NOT NULL, start_utc TEXT NOT NULL, stop_utc TEXT NOT NULL,
      title TEXT, description TEXT, PRIMARY KEY (channel_id, start_utc))`)
  const insert = db.raw.prepare(`INSERT OR REPLACE INTO temp.epg_stage (channel_id, start_utc, stop_utc, title, description)
    VALUES (@channel_id, @start_utc, @stop_utc, @title, @description)`)
  const flush = db.raw.transaction((rows: EpgProgrammeRow[]) => {
    for (const r of rows) insert.run(r)
  })
  const firstStart = new Map<string, string>()
  const ids = new Set<string>()
  let placeholders = 0
  let batch: EpgProgrammeRow[] = []
  return {
    add(row) {
      const first = firstStart.get(row.channel_id)
      if (first === undefined || row.start_utc < first) firstStart.set(row.channel_id, row.start_utc)
      if (isPlaceholderTitle(row.title)) {
        placeholders += 1
        return false
      }
      ids.add(row.channel_id)
      batch.push(row)
      if (batch.length >= 1_000) {
        flush(batch)
        batch = []
      }
      return true
    },
    commit() {
      flush(batch)
      batch = []
      // Rows that end after the first delivered start, so a stored programme
      // airing then does not overlap the delivered one that replaces it.
      const clear = db.raw.prepare('DELETE FROM epg_programs WHERE channel_id = ? AND stop_utc > ?')
      db.raw.transaction(() => {
        for (const [id, start] of firstStart) clear.run(id, start)
        db.raw.exec(`INSERT INTO epg_programs (channel_id, start_utc, stop_utc, title, description)
          SELECT channel_id, start_utc, stop_utc, title, description FROM temp.epg_stage;
          DROP TABLE temp.epg_stage`)
      })()
      return { ids, replaced: firstStart.size, placeholders }
    },
  }
}
