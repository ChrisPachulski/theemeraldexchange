// Proxy + remux delivery for adaptive YouTube trailers.
//
// The iOS Innertube client (eex-ytresolve) returns, for most videos, only an
// ADAPTIVE pair: a video-only and an audio-only googlevideo URL. AVPlayer can't
// play those: (a) the URLs reject plain / open-ended / over-cap GETs with 403 —
// they only serve bounded sub-cap byte ranges (`&range=0-1048575` → 200,
// full-file → 403), so a manifest pointing straight at them never plays; and
// (b) they're two separate streams, not one muxed file.
//
// So we do what yt-dlp does, natively: pull each stream down in sub-cap
// `&range=` chunks, then `ffmpeg -c copy` them into ONE faststart mp4 (moov atom
// at the front so AVPlayer starts before the whole file lands). Trailers are
// short (seconds to a few minutes / a few MB), so download-then-serve is simpler
// and entirely adequate — no live streaming proxy needed. The backend then
// serves that local mp4 (with Range support) and AVPlayer plays it directly.
//
// ponytail: lazy-cache to a temp dir keyed by video id, no background eviction —
// files are reused while fresh and overwritten when stale; /tmp grows by a few
// MB per distinct trailer until the OS clears it. Add a cron sweep only if disk
// pressure ever shows up.

import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { YtResolveResult } from './ytresolve.js'

const MUX_DIR = join(tmpdir(), 'eex-ytmux')
// googlevideo rejects full-file GETs; 1 MiB windows reliably return 200/206.
const CHUNK = 1_048_576
const CHUNK_TIMEOUT_MS = 20_000
// Trailers are small; bound total download so a bad URL can't fill the disk.
const MAX_BYTES = 256 * 1024 * 1024
// googlevideo `expire` is ~6h; 3h reuse keeps re-taps instant without a dead file.
const CACHE_TTL_MS = 3 * 60 * 60 * 1000

const YT_ID = /^[A-Za-z0-9_-]{11}$/

// Dedupe concurrent mux requests for the same id (a detail screen can fire the
// trailer fetch more than once) so we don't download + ffmpeg the same video
// twice in parallel.
const inFlight = new Map<string, Promise<string>>()

/** Deterministic on-disk path for a video id's muxed trailer. */
export function muxedTrailerPath(videoId: string): string {
  return join(MUX_DIR, `${videoId}.mp4`)
}

/**
 * Fetch a googlevideo URL fully by requesting bounded `&range=` windows and
 * concatenating them (a single open-ended GET is 403'd). Returns the bytes.
 * `fetchImpl` is injectable for tests.
 */
export async function fetchRanged(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const parts: Buffer[] = []
  let start = 0
  let totalBytes = 0
  // Hard ceiling on iterations as a runaway guard (MAX_BYTES / CHUNK + slack).
  const maxChunks = Math.ceil(MAX_BYTES / CHUNK) + 1
  for (let i = 0; i < maxChunks; i++) {
    const end = start + CHUNK - 1
    const u = url + (url.includes('?') ? '&' : '?') + `range=${start}-${end}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), CHUNK_TIMEOUT_MS)
    let buf: Buffer
    try {
      const res = await fetchImpl(u, { signal: ctrl.signal })
      if (res.status !== 200 && res.status !== 206) {
        throw new Error(`range ${start}-${end}: HTTP ${res.status}`)
      }
      buf = Buffer.from(await res.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
    if (buf.length === 0) break
    parts.push(buf)
    totalBytes += buf.length
    if (totalBytes > MAX_BYTES) throw new Error(`stream exceeds ${MAX_BYTES} byte cap`)
    // A short read means we reached EOF (googlevideo returns the whole window
    // when more data exists).
    if (buf.length < CHUNK) break
    start += buf.length
  }
  return Buffer.concat(parts)
}

async function isFresh(path: string): Promise<boolean> {
  try {
    const s = await stat(path)
    return s.size > 0 && Date.now() - s.mtimeMs < CACHE_TTL_MS
  } catch {
    return false
  }
}

function runFfmpegCopy(videoPath: string, audioPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-nostdin',
        '-loglevel', 'error',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        // Explicit format: the output path is a `.part` temp (atomic rename
        // follows), so ffmpeg can't infer mp4 from the extension.
        '-f', 'mp4',
        '-y',
        outPath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`ffmpeg mux failed: ${(stderr || '').trim() || err.message}`))
          return
        }
        resolve()
      },
    )
  })
}

/**
 * Ensure a muxed faststart mp4 exists for `videoId` and return its local path.
 * Reuses a fresh cached file; otherwise downloads the adaptive video+audio
 * streams in sub-cap chunks and muxes them with `-c copy`. Throws on any failure
 * (the caller falls back to yt-dlp). `resolved` must carry both video and audio.
 */
export async function ensureMuxedTrailer(
  videoId: string,
  resolved: YtResolveResult,
): Promise<string> {
  if (!YT_ID.test(videoId)) throw new Error('invalid video id')
  if (!resolved.video?.url || !resolved.audio?.url) {
    throw new Error('resolved result is not an adaptive video+audio pair')
  }
  const out = muxedTrailerPath(videoId)
  if (await isFresh(out)) return out

  const existing = inFlight.get(videoId)
  if (existing) return existing

  const task = (async () => {
    await mkdir(MUX_DIR, { recursive: true })
    const vTmp = join(MUX_DIR, `${videoId}.v.part`)
    const aTmp = join(MUX_DIR, `${videoId}.a.part`)
    const outTmp = join(MUX_DIR, `${videoId}.out.part`)
    try {
      const [v, a] = await Promise.all([
        fetchRanged(resolved.video!.url),
        fetchRanged(resolved.audio!.url),
      ])
      await Promise.all([writeFile(vTmp, v), writeFile(aTmp, a)])
      await runFfmpegCopy(vTmp, aTmp, outTmp)
      // Atomic publish so a concurrent reader never sees a half-written mp4.
      await rename(outTmp, out)
      return out
    } finally {
      await Promise.allSettled([rm(vTmp, { force: true }), rm(aTmp, { force: true }), rm(outTmp, { force: true })])
    }
  })()

  inFlight.set(videoId, task)
  try {
    return await task
  } finally {
    inFlight.delete(videoId)
  }
}
