// Server-side telemetry relay. The §15 contract says every self-hoster
// runs their own Glitchtip and crash/error data never leaves their
// infrastructure. The client path lives in routes/telemetry.ts (the SPA
// and native apps POST there); THIS module is the server-side equivalent
// so background failures that never reach the browser — e.g. a silently
// down recommender sidecar dropping click signal — are still observable
// in the mandatory telemetry pipeline rather than console-only.
//
// Best-effort and time-bounded: a slow or down Glitchtip must never
// block or break the caller. Failures here are swallowed.

import { env } from '../env.js'
import { fetchWithTimeout } from './upstream.js'
import { scrubTelemetryValue } from './telemetryPiiScrub.js'

const GLITCHTIP_RELAY_TIMEOUT_MS = 2000

export type ServerEventLevel = 'error' | 'warning' | 'info'

export type ServerEvent = {
  level?: ServerEventLevel
  message: string
  context?: Record<string, unknown>
}

// Fire-and-forget by design: returns a promise so callers can await in
// tests, but production callers `void` it. Never throws.
export async function reportServerEvent(event: ServerEvent): Promise<void> {
  // Same DSN the client SDKs fetch via /api/telemetry/config (§15.2), so
  // server-side events land in the same self-hosted Glitchtip project as
  // client crashes. Absent DSN (telemetry not yet provisioned) is a
  // no-op — never a hard failure.
  const dsn = env.EEX_TELEMETRY_DSN
  if (!dsn) return
  try {
    let parsed: URL
    try {
      parsed = new URL(dsn)
    } catch {
      return
    }
    // Sentry/Glitchtip DSN shape: https://<key>@<host>/<projectId>
    const projectId = parsed.pathname.replace(/^\/+/, '')
    const key = parsed.username
    if (!projectId || !key) return
    const storeUrl = `${parsed.protocol}//${parsed.host}/api/${projectId}/store/`
    await fetchWithTimeout(
      storeUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${key}`,
        },
        body: JSON.stringify({
          level: event.level ?? 'error',
          // §15.3: hold the relay payload to the SAME PII redaction as the SDK
          // beforeSend path. The message may embed a stream-grant token / JWE,
          // and a caller-supplied context could carry a redacted-key field.
          message: scrubTelemetryValue(event.message) as string,
          extra: event.context ? (scrubTelemetryValue(event.context) as Record<string, unknown>) : {},
          platform: 'node',
        }),
      },
      GLITCHTIP_RELAY_TIMEOUT_MS,
      'telemetry.relay',
    )
  } catch {
    // Telemetry itself failing must not surface anywhere — swallow.
  }
}
