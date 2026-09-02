export const AUTH_NETWORK_TIMEOUT_MS = 15_000

export class AuthRequestTimeoutError extends Error {
  constructor() {
    super('auth request timed out')
    this.name = 'AuthRequestTimeoutError'
  }
}

export class AuthRequestCancelledError extends Error {
  constructor() {
    super('auth request cancelled')
    this.name = 'AbortError'
  }
}

/** Bound one non-interactive network leg to both its auth attempt and a hard
 * timeout. The explicit race also settles when a test double or browser fetch
 * fails to reject promptly after abort. Interactive Apple UI never
 * runs inside this boundary. */
export async function boundedAuthRequest<T>(
  attemptSignal: AbortSignal,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (attemptSignal.aborted) throw new AuthRequestCancelledError()
  if (timeoutMs <= 0) throw new AuthRequestTimeoutError()

  const controller = new AbortController()
  let settled = false
  let rejectBoundary!: (reason: unknown) => void
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject
  })
  const cancel = (error: Error) => {
    if (settled) return
    controller.abort()
    rejectBoundary(error)
  }
  const onAbort = () => cancel(new AuthRequestCancelledError())
  attemptSignal.addEventListener('abort', onAbort, { once: true })
  const timeout = window.setTimeout(
    () => cancel(new AuthRequestTimeoutError()),
    timeoutMs,
  )

  try {
    return await Promise.race([request(controller.signal), boundary])
  } finally {
    settled = true
    window.clearTimeout(timeout)
    attemptSignal.removeEventListener('abort', onAbort)
  }
}
