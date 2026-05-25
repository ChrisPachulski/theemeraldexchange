import sax from 'sax'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { env } from '../env.js'

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

export async function streamXmltv(
  input: Readable,
  onProgramme: (row: EpgProgrammeRow) => void,
): Promise<void> {
  // Auto-detect gzip by reading the first two bytes.
  const head: Buffer = await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    input.on('error', reject)
    input.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= 2) {
        input.pause()
        resolve(Buffer.concat(chunks, total))
      }
    })
    input.on('end', () => resolve(Buffer.concat(chunks, total)))
  })
  const isGzip = head[0] === 0x1f && head[1] === 0x8b
  const merged = Readable.from((async function* () {
    yield head
    input.resume()
    for await (const c of input) yield c as Buffer
  })())
  const xmlStream: Readable = isGzip ? (merged.pipe(createGunzip()) as unknown as Readable) : merged

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
  const url = `${host}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`xtream.xmltv_${res.status}`)
  const nodeStream = Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>)
  await streamXmltv(nodeStream, onProgramme)
}
