// Shared upstream fetch wrapper. Wraps a vanilla fetch with an
// AbortController-driven timeout, then synthesizes a 504 Response on
// abort so every caller path treats the timeout as a normal non-2xx
// upstream response instead of a thrown exception. That keeps the
// route layer's existing "non-ok → forward / wrap as error" branches
// in charge — no per-route try/catch retrofit needed.
//
// Service layers (radarr / sonarr / sab) wrap their fetch through
// here; route layers that build their own fetch (plex, tmdb) do the
// same. The exported constants document the budget per surface:
//
//   - LAN_TIMEOUT_MS (15s) for Sonarr / Radarr / SAB calls. A NAS-
//     local API on the same LAN should never need this much; the
//     budget covers genuinely-slow operations like Sonarr's release
//     search across many indexers.
//   - WAN_TIMEOUT_MS (10s) for plex.tv and TMDB. These cross the
//     internet, but plex.tv's /pins is typically <1s; 10s leaves
//     plenty of headroom for spikes while still freeing the request
//     handler before users notice.

export const LAN_TIMEOUT_MS = 15_000
export const WAN_TIMEOUT_MS = 10_000

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.arrayBuffer()
    const replayBody =
      body.byteLength === 0 || [101, 204, 205, 304].includes(response.status)
        ? null
        : body
    return new Response(replayBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (err) {
    // AbortError → bounded timeout fired. Network/DNS errors also land
    // here. Map both to a synthesized 504 so the route's existing
    // non-ok handling kicks in; without this an unhandled rejection
    // would 500 the whole request.
    const name = (err as { name?: string }).name
    const message = err instanceof Error ? err.message : String(err)
    const reason = name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable'
    console.error(`[upstream] ${label} ${reason}: ${message}`)
    return new Response(
      JSON.stringify({ error: reason, service: label, message }),
      {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Streaming-safe upstream fetch. Unlike {@link fetchWithTimeout}, this does NOT
 * buffer the body with `arrayBuffer()` and does NOT impose a whole-transfer
 * deadline. It bounds only TIME-TO-FIRST-BYTE (until the response headers
 * arrive) with an AbortController, then returns the live Response so the caller
 * can pipe `response.body` straight through.
 *
 * This is the correct wrapper for the media proxy: routing multi-GB direct-play
 * (or multi-hour) streams through the buffering wrapper loaded the entire file
 * into the Node heap before a byte reached the client, and the 15s body deadline
 * truncated any transfer that legitimately took longer — both negate media-
 * core's own design of separating streaming routes from its request timeout.
 *
 * On connect/DNS failure or a TTFB timeout it synthesizes a 504 (same shape as
 * fetchWithTimeout) so the route's existing non-ok handling still applies.
 */
export async function fetchStreamWithConnectTimeout(
  url: string | URL,
  init: RequestInit,
  connectTimeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    // Headers are in — cancel the TTFB deadline so the body can stream for as
    // long as the transfer legitimately takes (large file / slow client). A
    // client disconnect cancels the returned body stream, which propagates back
    // to this upstream fetch and frees the media-core connection.
    clearTimeout(timer)
    return response
  } catch (err) {
    clearTimeout(timer)
    const name = (err as { name?: string }).name
    const message = err instanceof Error ? err.message : String(err)
    const reason = name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable'
    console.error(`[upstream] ${label} ${reason}: ${message}`)
    return new Response(JSON.stringify({ error: reason, service: label, message }), {
      status: 504,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export async function fetchJsonWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) {
      // Cancel the unread body before throwing so undici can return the
      // socket to its pool instead of churning connections on every non-ok
      // response (same pattern as ssrfGuard's redirect handling).
      await response.body?.cancel().catch(() => {})
      throw new Error(`${label}_${response.status}`)
    }
    return response.json()
  } catch (err) {
    const name = (err as { name?: string }).name
    const message = err instanceof Error ? err.message : String(err)
    if (name !== 'AbortError' && message.startsWith(`${label}_`)) {
      throw err
    }
    const reason = name === 'AbortError' ? 'upstream_timeout' : 'upstream_unreachable'
    console.error(`[upstream] ${label} ${reason}: ${message}`)
    throw new Error(`${label}_${reason}`, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}
