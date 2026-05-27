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
  } else if (code === 'default_quality_profile_missing') {
    const expected = typeof data.expected_name === 'string' ? data.expected_name : 'choose me'
    const avail = Array.isArray(data.available_names) ? (data.available_names as string[]) : []
    const availText = avail.length > 0 ? ` Available profiles: ${avail.join(', ')}.` : ''
    message =
      `No quality profile named "${expected}" found.${availText} ` +
      `Set DEFAULT_PROFILE_NAME in your server env to one of the available names, ` +
      `or rename a profile in Sonarr/Radarr to match.`
  } else if (code === 'default_root_folder_missing') {
    message =
      'The configured DEFAULT_*_ROOT_FOLDER_PATH does not exist in Sonarr/Radarr. ' +
      'Update the env var to a path that the upstream service actually lists.'
  } else if (code === 'admin_must_configure_upstream') {
    message = 'Sonarr/Radarr has no root folders configured. Set one up there first.'
  } else if (code === 'rootfolder_unreachable' || code === 'qualityprofile_unreachable') {
    message = 'Sonarr/Radarr is unreachable. Check the service is running and the API key is correct.'
  } else if (typeof data.message === 'string') {
    message = data.message
  }

  throw new ApiError(res.status, message, code, data)
}

export function isInsufficientDiskSpace(e: unknown): e is ApiError {
  return e instanceof ApiError && e.code === 'insufficient_disk_space'
}
