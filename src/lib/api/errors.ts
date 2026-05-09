// Typed error envelope for backend responses. The Hono routes return
// JSON bodies like { error: 'insufficient_disk_space', free_bytes: ...,
// threshold_bytes: ... } or { error: 'forbidden', reason: 'admin_only' }
// for non-2xx responses. ApiError preserves those fields so the UI can
// render specific messages instead of "Sonarr /series: 507".

export class ApiError extends Error {
  status: number
  code?: string
  details?: Record<string, unknown>

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function throwApiError(res: Response, scope: string): Promise<never> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body — fall through with the status text
  }
  const data = (body ?? {}) as Record<string, unknown>
  const code = typeof data.error === 'string' ? data.error : undefined
  const reason = typeof data.reason === 'string' ? data.reason : undefined

  let message = `${scope}: ${res.status} ${res.statusText}`
  if (code === 'insufficient_disk_space') {
    const free = Number(data.free_bytes ?? 0)
    const threshold = Number(data.threshold_bytes ?? 0)
    const freeGb = (free / 1024 ** 3).toFixed(1)
    const thresholdGb = (threshold / 1024 ** 3).toFixed(0)
    message = `Not enough disk space. ${freeGb} GB free, need ${thresholdGb} GB.`
  } else if (code === 'forbidden' && reason === 'admin_only') {
    message = "That action is admin-only."
  } else if (code === 'unauthenticated' || res.status === 401) {
    message = 'Your session expired. Sign in again.'
  } else if (typeof data.message === 'string') {
    message = data.message
  }

  throw new ApiError(res.status, message, code, data)
}

export function isInsufficientDiskSpace(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'insufficient_disk_space'
}
