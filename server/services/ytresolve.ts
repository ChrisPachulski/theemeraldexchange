// Native Rust YouTube resolver — thin Node wrapper around the eex-ytresolve
// binary.  The binary is the Rust `ytresolve` crate's CLI output; it speaks
// JSON on stdout and exits non-zero when the iOS Innertube client can't
// deliver usable streams, at which point the caller falls back to yt-dlp.
//
// Cache contract:  googlevideo URLs carry an ~6h `expire` embedded in the
// query string.  A 3h TTL keeps re-taps instant without ever serving a dead
// URL.  The TTL is consistent with ytdlp.ts's CACHE_TTL_MS.
//
// Binary path:  resolved from EEX_YTRESOLVE_BIN env var or the PATH.  Set
// EEX_YTRESOLVE_BIN=/app/bin/eex-ytresolve in the Docker image; in dev the
// cargo-built binary (target/debug/eex-ytresolve) must be on PATH or set
// via the env var.  When the binary is absent, resolveViaRustBinary throws
// so the caller can fall back gracefully.

import { execFile } from 'node:child_process'

const CACHE_TTL_MS = 3 * 60 * 60 * 1000
const RESOLVE_TIMEOUT_MS = 20_000

/**
 * JSON shape emitted by `eex-ytresolve <id>`.  Mirrors the Rust
 * `Resolved` struct's `#[derive(Serialize)]` output.
 */
export interface StreamRef {
  url: string
  mime: string
  height: number | null
  bitrate: number | null
}

export interface YtResolveResult {
  video_id: string
  hls: string | null
  progressive: string | null
  video: StreamRef | null
  audio: StreamRef | null
  duration_secs: number | null
}

interface CacheEntry {
  result: YtResolveResult
  exp: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Shell out to `eex-ytresolve <videoId>` and parse its single JSON line.
 * Throws when the binary is missing or exits non-zero (caller must catch and
 * fall back to yt-dlp).
 */
export function resolveViaRustBinary(videoId: string): Promise<YtResolveResult> {
  const bin = process.env.EEX_YTRESOLVE_BIN ?? 'eex-ytresolve'
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [videoId],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr?.trim() || err.message
          reject(new Error(`eex-ytresolve failed for ${videoId}: ${detail}`))
          return
        }
        const line = stdout.trim()
        if (!line) {
          reject(new Error(`eex-ytresolve produced no output for ${videoId}`))
          return
        }
        let parsed: YtResolveResult
        try {
          parsed = JSON.parse(line) as YtResolveResult
        } catch {
          reject(new Error(`eex-ytresolve: invalid JSON for ${videoId}: ${line.slice(0, 200)}`))
          return
        }
        resolve(parsed)
      },
    )
  })
}

/**
 * Return a cached resolution or call the Rust binary.  A cache miss or
 * expired entry invokes `resolveViaRustBinary`; on failure the error
 * propagates to the caller (not stored in cache so the next call retries).
 */
export async function getOrFetchResolved(videoId: string): Promise<YtResolveResult> {
  const hit = cache.get(videoId)
  if (hit && hit.exp > Date.now()) return hit.result

  const result = await resolveViaRustBinary(videoId)
  cache.set(videoId, { result, exp: Date.now() + CACHE_TTL_MS })
  return result
}

/**
 * PARKED — not wired into the /trailer route. A single-segment (or byte-range)
 * HLS manifest pointing straight at the iOS adaptive googlevideo URLs does NOT
 * play on AVPlayer: those URLs 403 on plain/over-cap GETs (they require bounded
 * sub-cap byte ranges) and AVPlayer is HLS-only over non-fragmented mp4. Native
 * delivery of the adaptive-only case needs a proxy+remux service (future phase);
 * until then the route falls back to yt-dlp. Kept (with tests) as the manifest
 * scaffold that phase will build on.
 *
 * Build the three HLS playlist strings from a resolved adaptive pair.
 * Returns null when either the video or audio stream is absent.
 *
 * The playlist names passed to this function are the URI strings embedded
 * in the master (e.g. `"/trailer/<id>/video.m3u8"`).
 *
 * This is a plain reimplementation of the Rust `manifest::build_hls` logic
 * in Node so the backend can serve manifests without spawning any extra
 * process.
 */
export function buildHlsBundle(
  resolved: YtResolveResult,
  videoPlName: string,
  audioPlName: string,
): { master: string; video: string; audio: string } | null {
  const v = resolved.video
  const a = resolved.audio
  if (!v || !a) return null

  const durSecs = resolved.duration_secs ?? 600
  const bandwidth = v.bitrate ?? 2_000_000
  const height = v.height ?? 720
  const width = (height * 16 / 9) & ~1 // nearest even, 16:9
  const resolution = `${width}x${height}`

  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioPlName}"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"`,
    videoPlName,
    '',
  ].join('\n')

  const mediaPl = (url: string): string =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXT-X-TARGETDURATION:${durSecs}`,
      `#EXTINF:${durSecs.toFixed(3)},`,
      url,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')

  return {
    master,
    video: mediaPl(v.url),
    audio: mediaPl(a.url),
  }
}

/** Evict a video id from the cache (used in tests to force a fresh fetch). */
export function _evictFromCache(videoId: string): void {
  cache.delete(videoId)
}
