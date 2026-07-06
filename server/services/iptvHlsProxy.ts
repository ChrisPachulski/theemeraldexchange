// Upstream HLS / progressive proxy helpers for the IPTV routes.
// Extracted from routes/iptv.ts: the bounded-text reader, the HLS
// manifest fetch-and-rewrite, and the rangeable progressive proxy.
// All functions are Hono-free — they take explicit inputs and return a
// plain Response (success or the same JSON error shapes the route
// always produced), so they are unit-testable without a router.

import { env } from '../env.js'
import { rewriteManifest } from './iptvHlsRewrite.js'
import { signStreamToken } from './iptvStreamToken.js'
import {
  isPublicHttpsUpstream,
  guardedFetch,
  guardedFetchTrustedOrigin,
  SsrfBlockedError,
} from './ssrfGuard.js'

function jsonError(error: string, status: number, detail?: string): Response {
  return new Response(JSON.stringify(detail ? { error, detail } : { error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

// Read a response body as text, refusing past `maxBytes` (null = too large).
// HLS manifests are small; an attacker-influenceable upstream must not be able
// to balloon the proxy's memory with an unbounded .text() buffer.
export async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return ''
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined)
    return null
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Fetch an upstream HLS playlist and rewrite its segment/sub-playlist
 * lines to signed `/api/iptv/stream/segment` proxy URLs bound to `sub`.
 *
 * SSRF defense-in-depth: this is reached via the segment handler (which
 * already SSRF-checks) but also fetches a sub-playlist URL directly, so
 * it re-validates before egress rather than trusting the caller; then
 * guardedFetch re-validates the host's resolved IPs and every redirect
 * hop (DNS-rebinding + redirect-SSRF).
 *
 * Deadline + abort propagation: the manifest fetch (headers AND body) is
 * bounded by a whole-transfer timeout composed with the client's own
 * signal, and egress() adds a fresh per-hop timeout — a hung or
 * drip-feeding upstream cannot pin the request open, and a client that
 * gives up tears the upstream fetch down with it (matching the live/
 * segment byte paths, which propagate the request signal).
 */
export async function fetchAndRewriteHlsPlaylist(opts: {
  upstreamUrl: string
  sub: string
  clientSignal: AbortSignal
}): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(opts.upstreamUrl)
  } catch {
    return jsonError('bad_upstream', 400)
  }
  if (!isPublicHttpsUpstream(parsed)) return jsonError('bad_upstream', 400)

  const signal = AbortSignal.any([
    opts.clientSignal,
    AbortSignal.timeout(env.IPTV_MANIFEST_FETCH_TIMEOUT_MS),
  ])
  let upstream: Response
  let text: string | null
  try {
    upstream = await guardedFetch(opts.upstreamUrl, { signal }, {
      hopTimeoutMs: env.IPTV_MANIFEST_FETCH_TIMEOUT_MS,
    })
    if (!upstream.ok) return jsonError(`upstream_${upstream.status}`, 502)
    text = await readBoundedText(upstream, env.IPTV_MANIFEST_MAX_BYTES)
  } catch (err) {
    if (err instanceof SsrfBlockedError) return jsonError('bad_upstream', 400)
    if (isAbortError(err)) return jsonError('upstream_timeout', 504)
    throw err
  }
  if (text == null) return jsonError('manifest_too_large', 502)
  const sign = (url: string) =>
    signStreamToken(env.streamTokenSecret, {
      kind: 'segment',
      resourceId: url,
      sub: opts.sub,
      // This helper serves ONLY the on-demand HLS paths (VOD/series .m3u8 and
      // their sub-playlist recursion via /stream/segment) — never live, which
      // mints its own remux segment tokens in iptvLiveRemuxMap.ts on the short
      // TTL. hls.js fetches these segment URLs across the whole runtime, so a
      // VOD .m3u8 title froze at ~5min when segment tokens carried the 300s
      // finite-asset TTL. Mirror the grant's playback-duration TTL.
      ttlSecs: env.IPTV_ONDEMAND_TOKEN_TTL_SECS,
    })
  const rewritten = rewriteManifest(text, opts.upstreamUrl, sign, '/api/iptv/stream/segment')

  return new Response(rewritten, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Range-aware progressive proxy for VOD/series files.
 *
 * SSRF: the creds host is operator-trusted, but an upstream-issued
 * redirect is not — guardedFetchTrustedOrigin re-validates every 30x
 * target so a panel can't bounce us into the internal network.
 *
 * `onClientAbort` fires when the CLIENT disconnects mid-transfer; the
 * IPTV routes use it to free the concurrency slot immediately
 * (mirroring the live/catchup byte paths) instead of pinning it until
 * the 30s idle sweep.
 */
export async function proxyRangeableUpstream(opts: {
  upstreamUrl: string
  mime: string
  range: string | null
  clientSignal: AbortSignal
  onClientAbort?: () => void
}): Promise<Response> {
  const controller = new AbortController()
  opts.clientSignal.addEventListener(
    'abort',
    () => {
      controller.abort()
      try {
        opts.onClientAbort?.()
      } catch {
        // Slot release is best-effort; never let it break the teardown path.
      }
    },
    { once: true },
  )
  const headers: Record<string, string> = {}
  if (opts.range) headers.Range = opts.range

  let upstream: Response
  try {
    upstream = await guardedFetchTrustedOrigin(opts.upstreamUrl, {
      signal: controller.signal,
      headers,
    })
  } catch (err) {
    if (err instanceof SsrfBlockedError) return jsonError('bad_upstream', 400)
    throw err
  }
  if (!upstream.ok || !upstream.body) return jsonError(`upstream_${upstream.status}`, 502)

  const responseHeaders = new Headers({
    'Content-Type': opts.mime,
    'Cache-Control': 'no-store',
  })
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) responseHeaders.set('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) responseHeaders.set('Content-Range', contentRange)
  const acceptRanges = upstream.headers.get('accept-ranges')
  if (acceptRanges) responseHeaders.set('Accept-Ranges', acceptRanges)

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}
