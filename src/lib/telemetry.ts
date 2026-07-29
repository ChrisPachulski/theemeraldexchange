import * as Sentry from '@sentry/react'
import { apiUrl } from './api/base'

// §15 contract: per-self-hoster Glitchtip (Sentry-SDK compatible). The DSN is
// delivered server -> app at boot, so it is NEVER hardcoded here (the repo may
// be public). Resolution order:
//   1. window.__EXCHANGE_CONFIG__.glitchtipDsn  (server-injected boot config)
//   2. import.meta.env.VITE_GLITCHTIP_DSN       (build-time fallback)
// When no DSN is present the SDK is never initialised, so self-hosters without
// Glitchtip keep running with zero overhead and zero outbound crash traffic.

interface ExchangeBootConfig {
  glitchtipDsn?: string
}

declare global {
  interface Window {
    __EXCHANGE_CONFIG__?: ExchangeBootConfig
  }
}

let initialised = false
let handlersRegistered = false

interface ServerTelemetryConfig {
  dsn: string
  environment: string
  release: string
}

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|email|username|\bsub\b|device|media_?path|title/i
const TOKEN_QUERY = /([?&](?:t|u|token)=)[^&#\s]+/gi
const INVITE_FRAGMENT = /(#[/]invite[/])[^/?#\s]+/gi

function scrubTelemetryString(value: string): string {
  return value
    .replace(TOKEN_QUERY, '$1[redacted]')
    .replace(INVITE_FRAGMENT, '$1[redacted]')
}

function scrubTelemetryValue(value: unknown, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return scrubTelemetryString(value)
  if (Array.isArray(value)) return value.map((item) => scrubTelemetryValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        scrubTelemetryValue(child, childKey),
      ]),
    )
  }
  return value
}

function scrubCapturedError(error: unknown): unknown {
  if (!(error instanceof Error)) return scrubTelemetryValue(error)
  const scrubbed = new Error(scrubTelemetryString(error.message))
  scrubbed.name = scrubTelemetryString(error.name)
  if (error.stack) scrubbed.stack = scrubTelemetryString(error.stack)
  return scrubbed
}

function resolveDsn(): string | undefined {
  const injected =
    typeof window !== 'undefined' ? window.__EXCHANGE_CONFIG__?.glitchtipDsn : undefined
  const buildTime = import.meta.env.VITE_GLITCHTIP_DSN as string | undefined
  const dsn = (injected || buildTime || '').trim()
  return dsn.length > 0 ? dsn : undefined
}

function registerGlobalHandlers(): void {
  if (handlersRegistered || typeof window === 'undefined') return
  handlersRegistered = true
  window.addEventListener('error', (event) => {
    captureError(event.error ?? event.message, { source: 'window.error' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    captureError(event.reason, { source: 'unhandledrejection' })
  })
}

/**
 * Initialise crash/error telemetry. No-ops when no DSN is configured. Safe to
 * call more than once. Returns true when telemetry is active.
 */
function initialize(dsn: string, environment: string, release?: string): boolean {
  if (initialised) return true

  Sentry.init({
    dsn,
    environment,
    release,
    // Crash-data islands: error capture only. No performance tracing so we don't
    // ship spans to a self-hoster's Glitchtip.
    tracesSampleRate: 0,
    // Don't leak PII into a self-hosted island unless explicitly opted in.
    sendDefaultPii: false,
    integrations: (defaults) => defaults.filter((integration) => integration.name !== 'BrowserSession'),
    beforeSend: (event) => scrubTelemetryValue(event) as typeof event,
  })

  initialised = true
  registerGlobalHandlers()
  return true
}

export function initTelemetry(): boolean {
  const dsn = resolveDsn()
  return dsn ? initialize(dsn, import.meta.env.MODE) : false
}

/** Resolve build/server-injected config first, then fetch the public,
 * non-secret per-install DSN in the background. Network and unconfigured
 * responses degrade to telemetry-off without delaying startup. */
export async function initTelemetryFromServer(): Promise<boolean> {
  if (initTelemetry()) return true
  try {
    const response = await fetch(apiUrl('/api/telemetry/config'), {
      credentials: 'include',
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) return false
    const config = (await response.json()) as Partial<ServerTelemetryConfig>
    if (
      typeof config.dsn !== 'string' ||
      typeof config.environment !== 'string' ||
      typeof config.release !== 'string'
    ) {
      return false
    }
    return initialize(config.dsn.trim(), config.environment, config.release)
  } catch {
    return false
  }
}

/**
 * Forward a captured error to telemetry. No-ops when telemetry is not active,
 * so callers (e.g. the ErrorBoundary) can call it unconditionally.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) return
  Sentry.captureException(
    scrubCapturedError(error),
    context ? { extra: scrubTelemetryValue(context) as Record<string, unknown> } : undefined,
  )
}

export function isTelemetryActive(): boolean {
  return initialised
}
