// Live reconnect policy — a port of the Apple app's EmeraldKit
// `LiveReconnectPolicy` + `LiveOfflineReprobePolicy`. IPTV clients (TiviMate,
// IPTV Smarters) never eject the viewer on a transient drop: they keep the
// surface up, re-grant with backoff, and only then offer a manual retry.

/** Backoff before each re-grant attempt: about a 45 s window over 5 tries. */
export const RECONNECT_BACKOFF_MS = [0, 3_000, 6_000, 12_000, 24_000]
export const RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length

/** Floor wait between freeing the old session and re-dialing. Re-dialing before
 *  the provider releases the slot looks like two connections from one plan,
 *  which trips its abuse cap and corrupts video on every channel. */
export const SLOT_RELEASE_GRACE_MS = 2_500

/** Re-probe cadence behind "Channel offline", matched to the server's ~60 s
 *  dead-feed memory so a blip clears within about one extra cycle. */
export const OFFLINE_REPROBE_MS = 30_000

/** Total wait before 0-based `attempt`, or null once the budget is spent. */
export function reconnectWaitMs(attempt: number): number | null {
  if (attempt < 0 || attempt >= RECONNECT_BACKOFF_MS.length) return null
  return RECONNECT_BACKOFF_MS[attempt] + SLOT_RELEASE_GRACE_MS
}
