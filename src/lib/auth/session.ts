import { apiUrl } from '../api/base'
import type { AuthUser, SessionReadResult } from './types'

const SESSION_READ_ATTEMPTS = 3
const SESSION_READ_TIMEOUT_MS = 3_000
const SESSION_READ_RETRY_BASE_MS = 100
export const SESSION_UNAVAILABLE_ERROR =
  'We couldn’t verify your session. Check your connection and try again.'
export const SESSION_NOT_ESTABLISHED_ERROR =
  'Sign-in succeeded, but the browser session could not be established. Try again.'
export const SESSION_CONFIRMATION_UNAVAILABLE_ERROR =
  'Sign-in succeeded, but the browser session could not be confirmed. Check your connection and try again.'
export const SESSION_MISMATCH_ERROR =
  'Sign-in could not be completed because the confirmed session did not match. Try again.'

function isProviderSub(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()) return false
  const separator = value.indexOf(':')
  const provider = value.slice(0, separator)
  const providerId = value.slice(separator + 1)
  return (
    separator > 0 &&
    ['plex', 'apple', 'google', 'workos', 'local'].includes(provider) &&
    Boolean(providerId.trim())
  )
}

export function providerSubFromApi(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const sub = (value as Record<string, unknown>).sub
  return isProviderSub(sub) ? sub : null
}

export function authUserFromApi(value: unknown): AuthUser | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const sub = candidate.sub
  const username = candidate.username
  const role = candidate.role
  const authMode = candidate.auth_mode
  if (!isProviderSub(sub)) return null
  if (typeof username !== 'string' || !username.trim()) return null
  if (role !== 'admin' && role !== 'user') return null
  if (
    authMode !== undefined &&
    authMode !== 'plex' &&
    authMode !== 'apple' &&
    authMode !== 'google' &&
    authMode !== 'workos' &&
    authMode !== 'local'
  ) {
    return null
  }
  return {
    sub,
    username,
    role,
    ...(authMode === undefined ? {} : { auth_mode: authMode }),
  }
}

function waitForSessionRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = () => finish(false)
    const timer = window.setTimeout(() => finish(true), delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function readBrowserSession(signal: AbortSignal): Promise<SessionReadResult> {
  for (let attempt = 0; attempt < SESSION_READ_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return { status: 'aborted' }
    const controller = new AbortController()
    let rejectBoundary!: (reason: unknown) => void
    const boundary = new Promise<never>((_resolve, reject) => {
      rejectBoundary = reject
    })
    const onAbort = () => {
      controller.abort()
      rejectBoundary(new Error('session read aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = window.setTimeout(() => {
      controller.abort()
      rejectBoundary(new Error('session read timed out'))
    }, SESSION_READ_TIMEOUT_MS)

    try {
      const result = await Promise.race([
        (async (): Promise<SessionReadResult> => {
          const response = await fetch(apiUrl('/api/me'), {
            credentials: 'include',
            signal: controller.signal,
          })
          if (signal.aborted) return { status: 'aborted' }
          if (response.status === 401) return { status: 'anonymous' }
          if (response.status !== 200) throw new Error(`unexpected status ${response.status}`)
          const body = (await response.json()) as { user?: unknown }
          if (signal.aborted) return { status: 'aborted' }
          const user = authUserFromApi(body?.user)
          if (!user) throw new Error('invalid session response')
          return { status: 'authenticated', user }
        })(),
        boundary,
      ])
      return result
    } catch {
      if (signal.aborted) return { status: 'aborted' }
    } finally {
      window.clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }

    if (
      attempt < SESSION_READ_ATTEMPTS - 1 &&
      !(await waitForSessionRetry(SESSION_READ_RETRY_BASE_MS * (attempt + 1), signal))
    ) {
      return { status: 'aborted' }
    }
  }
  return { status: 'unavailable' }
}
