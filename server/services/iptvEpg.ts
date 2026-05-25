import sax from 'sax'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { env } from '../env.js'

const EPG_FETCH_TIMEOUT_MS = 5 * 60_000

export interface EpgProgrammeRow {
  channel_id: string
  start_utc: string
  stop_utc: string
  title: string | null
  description: string | null
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

async function waitForReadable(input: Readable): Promise<'readable' | 'end'> {
  if (input.readableEnded) return 'end'
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off('readable', onReadable)
      input.off('end', onEnd)
      input.off('error', onError)
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
    input.once('readable', onReadable)
    input.once('end', onEnd)
    input.once('error', onError)
  })
}

export async function streamXmltv(
  input: Readable,
  onProgramme: (row: EpgProgrammeRow) => void,
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
    if (await waitForReadable(input) === 'end') break
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

  parser.on('opentag', (node) => {
    if (node.name === 'programme') {
      const a = node.attributes as Record<string, string>
      try {
        cur = {
          channel_id: a.channel,
          start_utc: xmltvTimeToIso(a.start),
          stop_utc: xmltvTimeToIso(a.stop),
          title: null,
          description: null,
        }
      } catch {
        cur = null
      }
    } else if (cur && node.name === 'title') {
      inTitle = true; text = ''
    } else if (cur && node.name === 'desc') {
      inDesc = true; text = ''
    }
  })
  parser.on('text', (t) => { if (inTitle || inDesc) text += t })
  parser.on('closetag', (name) => {
    if (name === 'title' && inTitle && cur) { cur.title = text || null; inTitle = false; text = '' }
    else if (name === 'desc' && inDesc && cur) { cur.description = text || null; inDesc = false; text = '' }
    else if (name === 'programme' && cur) {
      if (cur.channel_id && cur.start_utc && cur.stop_utc) {
        onProgramme(cur as EpgProgrammeRow)
      }
      cur = null
      counter += 1
      if (counter % 500 === 0) void yieldEventLoop()
    }
  })

  await new Promise<void>((resolve, reject) => {
    parser.on('error', reject)
    parser.on('end', () => resolve())
    xmlStream.on('error', reject)
    xmlStream.pipe(parser)
  })
}

export async function fetchAndStreamEpg(
  onProgramme: (row: EpgProgrammeRow) => void,
  hostOverride?: { host: string; username: string; password: string },
): Promise<void> {
  const host = (hostOverride?.host ?? env.XTREAM_HOST).replace(/\/+$/, '')
  const user = hostOverride?.username ?? env.XTREAM_USERNAME
  const pass = hostOverride?.password ?? env.XTREAM_PASSWORD
  const epgPath = (env.IPTV_EPG_PATH ?? '/xmltv.php').replace(/^([^/])/, '/$1')
  const url = `${host}${epgPath}?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(env.IPTV_LIST_TIMEOUT_MS, EPG_FETCH_TIMEOUT_MS))
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) throw new Error(`xtream.xmltv_${res.status}`)
    const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>)
    await streamXmltv(nodeStream, onProgramme)
  } finally {
    clearTimeout(timer)
  }
}
