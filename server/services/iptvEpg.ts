import sax from 'sax'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { env } from '../env.js'

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

// Exported only so the test file can `import` it — the real parsing happens in streamXmltv.
export function parseXmltvProgramme(_unused: never): EpgProgrammeRow {
  throw new Error('use streamXmltv')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
}

async function waitForReadable(input: Readable, signal?: AbortSignal): Promise<'readable' | 'end'> {
  if (input.readableEnded) return 'end'
  if (signal?.aborted) throw abortReason(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off('readable', onReadable)
      input.off('end', onEnd)
      input.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onReadable = () => {
      cleanup()
      resolve('readable')
    }
    const onEnd = () => {
      cleanup()
      resolve('end')
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal as AbortSignal))
    }
    input.once('readable', onReadable)
    input.once('end', onEnd)
    input.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface XmltvChannelDef {
  id: string
  names: string[]
}

export async function streamXmltv(
  input: Readable,
  onProgramme: (row: EpgProgrammeRow) => void,
  signal?: AbortSignal,
  onChannelDef?: (def: XmltvChannelDef) => void,
): Promise<void> {
  // Auto-detect gzip by reading the first two bytes.
  const headChunks: Buffer[] = []
  let total = 0
  while (total < 2) {
    const chunk = input.read() as Buffer | Uint8Array | string | null
    if (chunk !== null) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      headChunks.push(buf)
      total += buf.length
      continue
    }
    if (await waitForReadable(input, signal) === 'end') break
  }
  const head = Buffer.concat(headChunks, total)
  const isGzip = head[0] === 0x1f && head[1] === 0x8b
  const stream = Readable.from((async function* () {
    for (const chunk of headChunks) yield chunk
    for await (const chunk of input) yield chunk as Buffer
  })())
  const xmlStream: Readable = isGzip ? (stream.pipe(createGunzip()) as unknown as Readable) : stream

  const parser = sax.createStream(true, { trim: true, normalize: true })
  let cur: Partial<EpgProgrammeRow> | null = null
  let text = ''
  let inTitle = false
  let inDesc = false
  let counter = 0
  // Channel-definition capture (<channel id="…"><display-name>…</display-name>).
  // The feed ships many display-name aliases per channel so players can match
  // schedules by name, not just by exact tvg-id. Captured in the same pass.
  let chanId: string | null = null
  let chanNames: string[] = []
  let inDisplayName = false
  let dnText = ''

  parser.on('opentag', (node) => {
    if (node.name === 'programme') {
      const a = node.attributes as Record<string, string>
      try {
        cur = {
          channel_id: normalizeEpgChannelId(a.channel) ?? '',
          start_utc: xmltvTimeToIso(a.start),
          stop_utc: xmltvTimeToIso(a.stop),
          title: null,
          description: null,
        }
      } catch {
        cur = null
      }
    } else if (node.name === 'channel') {
      const a = node.attributes as Record<string, string>
      chanId = a.id ?? null
      chanNames = []
    } else if (chanId && node.name === 'display-name') {
      inDisplayName = true; dnText = ''
    } else if (cur && node.name === 'title') {
      inTitle = true; text = ''
    } else if (cur && node.name === 'desc') {
      inDesc = true; text = ''
    }
  })
  parser.on('text', (t) => {
    if (inTitle || inDesc) text += t
    else if (inDisplayName) dnText += t
  })
  parser.on('closetag', (name) => {
    if (name === 'title' && inTitle && cur) { cur.title = text || null; inTitle = false; text = '' }
    else if (name === 'desc' && inDesc && cur) { cur.description = text || null; inDesc = false; text = '' }
    else if (name === 'display-name' && inDisplayName) {
      if (dnText) chanNames.push(dnText)
      inDisplayName = false; dnText = ''
    } else if (name === 'channel') {
      if (chanId && onChannelDef) onChannelDef({ id: chanId, names: chanNames })
      chanId = null; chanNames = []
      counter += 1
      if (counter % 500 === 0) void yieldEventLoop()
    } else if (name === 'programme' && cur) {
      if (cur.channel_id && cur.start_utc && cur.stop_utc) {
        onProgramme(cur as EpgProgrammeRow)
      }
      cur = null
      counter += 1
      if (counter % 500 === 0) void yieldEventLoop()
    }
  })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      parser.off('error', fail)
      parser.off('end', done)
      xmlStream.off('error', fail)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      input.destroy(err)
      xmlStream.destroy(err)
      reject(err)
    }
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onAbort = () => fail(abortReason(signal as AbortSignal))
    if (signal?.aborted) {
      fail(abortReason(signal))
      return
    }
    parser.on('error', fail)
    parser.on('end', done)
    xmlStream.on('error', fail)
    signal?.addEventListener('abort', onAbort, { once: true })
    xmlStream.pipe(parser)
  })
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
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`xtream.xmltv_${res.status}`)
    const source = Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>)
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
