// Resolve a YouTube trailer/extra (by 11-char video id) to a directly-playable
// progressive URL, so the Apple TV — which has NO WebKit and thus can't embed
// the YouTube player — can hand the URL straight to AVPlayer.
//
// We shell to the bundled `yt-dlp` standalone binary with `-g` (print the media
// URL, don't download) and ask for a single muxed mp4 so AVPlayer gets one
// progressive stream (YouTube's higher rungs are split DASH that AVPlayer can't
// mux). The googlevideo URLs are signature-locked, not IP-locked, so the device
// can fetch the URL the server resolved (proven via cross-host ffprobe).
//
// The resolved URL is cached briefly: googlevideo links carry an ~6h `expire`,
// so a 3h TTL keeps re-taps instant without ever serving a dead link.

import { execFile } from 'node:child_process'

const CACHE_TTL_MS = 3 * 60 * 60 * 1000
const RESOLVE_TIMEOUT_MS = 20_000
// itag 18 (360p) is the always-present muxed mp4; the ext=mp4 preference picks a
// higher muxed rung when YouTube offers one, else falls back to 18, then to
// whatever single file exists. NEVER a bare DASH video-only stream (no audio).
const FORMAT = 'best[ext=mp4][acodec!=none][vcodec!=none]/18/best[ext=mp4]/best'

const YT_ID = /^[A-Za-z0-9_-]{11}$/

interface CacheEntry {
  url: string
  exp: number
}
const cache = new Map<string, CacheEntry>()

export function isValidYouTubeId(id: string): boolean {
  return YT_ID.test(id)
}

/**
 * Resolve a YouTube video id to a playable URL, or null if yt-dlp is missing /
 * fails / the id is malformed. Caches successful resolutions for CACHE_TTL_MS.
 */
export async function resolveTrailerUrl(id: string): Promise<string | null> {
  if (!isValidYouTubeId(id)) return null

  const hit = cache.get(id)
  if (hit && hit.exp > Date.now()) return hit.url

  const url = await runYtDlp(id)
  if (url) cache.set(id, { url, exp: Date.now() + CACHE_TTL_MS })
  return url
}

function runYtDlp(id: string): Promise<string | null> {
  // execFile (no shell) + the strict id regex above means `id` can't inject
  // args or shell metacharacters; we build the watch URL ourselves.
  const watchUrl = `https://www.youtube.com/watch?v=${id}`
  return new Promise((resolve) => {
    execFile(
      'yt-dlp',
      ['--no-cache-dir', '--no-playlist', '--quiet', '-f', FORMAT, '-g', watchUrl],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: '/tmp' } },
      (err, stdout) => {
        if (err) {
          console.warn(`[ytdlp] resolve failed for ${id}: ${err.message.split('\n')[0]}`)
          return resolve(null)
        }
        // `-g` prints one URL per selected stream; our format is a single muxed
        // file, so take the first https line.
        const line = stdout.split('\n').map((s) => s.trim()).find((s) => s.startsWith('https://'))
        resolve(line ?? null)
      },
    )
  })
}
