export const SESSION_EXPIRED_EVENT = 'exchange:session-expired'

const DISPATCH_DEBOUNCE_MS = 2_000
let lastDispatchAt: number | null = null

function numericStatus(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('status' in value)) return undefined
  const status = (value as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function authCode(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as { code?: unknown; error?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return typeof candidate.error === 'string' ? candidate.error : undefined
}

/**
 * Report an edge-auth expiry. Both parts of the server contract are required:
 * HTTP 401 and `{ error: 'unauthenticated' }`. This prevents an upstream
 * service's own 401 from signing the browser out.
 */
export function notifySessionExpired(error: unknown): void {
  if (numericStatus(error) !== 401 || authCode(error) !== 'unauthenticated') return
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return

  const now = Date.now()
  if (lastDispatchAt !== null && now - lastDispatchAt < DISPATCH_DEBOUNCE_MS) return
  lastDispatchAt = now
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
}

/** Read a clone so callers remain free to consume the original response. */
export async function notifySessionExpiredResponse(response: Response): Promise<void> {
  if (response.status !== 401) return
  const body = (await response.clone().json().catch(() => null)) as unknown
  notifySessionExpired({ ...(body && typeof body === 'object' ? body : {}), status: response.status })
}
