// API base URL plumbing.
//
// Dev:  VITE_API_BASE_URL is empty. apiUrl() returns same-origin URLs;
//       Vite's /api/* proxy forwards them to the Hono backend.
// Prod: VITE_API_BASE_URL=https://api.theemeraldexchange.com. apiUrl()
//       returns absolute URLs to the backend, which sets cross-origin
//       cookies (SameSite=None; Secure) so credentialed fetches work.

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')

export function apiUrl(
  path: string,
  params?: Record<string, string | number | boolean>,
): string {
  const base = API_BASE || window.location.origin
  const url = new URL(path, base)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}
