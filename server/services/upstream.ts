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
