import * as Sentry from '@sentry/react'

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
export function initTelemetry(): boolean {
  if (initialised) return true
  const dsn = resolveDsn()
  if (!dsn) return false

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Crash-data islands: error capture only. No performance tracing so we don't
    // ship spans to a self-hoster's Glitchtip.
    tracesSampleRate: 0,
    // Don't leak PII into a self-hosted island unless explicitly opted in.
    sendDefaultPii: false,
  })

  initialised = true
  registerGlobalHandlers()
  return true
}

/**
 * Forward a captured error to telemetry. No-ops when telemetry is not active,
 * so callers (e.g. the ErrorBoundary) can call it unconditionally.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) return
  Sentry.captureException(error, context ? { extra: context } : undefined)
}

export function isTelemetryActive(): boolean {
  return initialised
}
