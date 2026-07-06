// Server-side telemetry relay. The §15 contract says every self-hoster
// runs their own Glitchtip and crash/error data never leaves their
// infrastructure. The client path lives in routes/telemetry.ts (the SPA
// and native apps POST there); THIS module is the server-side equivalent
// so background failures that never reach the browser — e.g. a silently
// down recommender sidecar dropping click signal — are still observable
// in the mandatory telemetry pipeline rather than console-only.
//
// Best-effort and time-bounded: a slow or down Glitchtip must never
// block or break the caller. Failures here are swallowed — BUT they are
// no longer silent: a relay that never delivers is exactly the §S0-1
// failure (Glitchtip went blind for weeks because the DSN host was
// unresolvable from inside the backend's docker network), so a dropped
// send now logs LOUDLY instead of vanishing.

import { lookup as nodeDnsLookup } from 'node:dns/promises'
import { env } from '../env.js'
import { fetchWithTimeout } from './upstream.js'
import { scrubTelemetryValue } from './telemetryPiiScrub.js'
import { createLogger } from './logger.js'

const GLITCHTIP_RELAY_TIMEOUT_MS = 2000

const log = createLogger('telemetry')

export type ServerEventLevel = 'error' | 'warning' | 'info'

export type ServerEvent = {
  level?: ServerEventLevel
  message: string
  context?: Record<string, unknown>
}

type ParsedDsn = {
  /** Host WITHOUT port — what DNS resolves. */
  hostname: string
  /** Sentry `sentry_key` (the DSN userinfo). */
  key: string
  /** Fully-qualified Glitchtip store endpoint the relay POSTs to. */
  storeUrl: string
}

/**
 * Parse a Sentry/Glitchtip DSN (`https://<key>@<host>/<projectId>`) into the
 * fields the relay + the boot self-check both need. Returns null for an
 * absent, malformed, or incomplete DSN; the caller decides whether that is a
 * silent no-op (per-event relay) or a loud misconfiguration (boot self-check).
 */
function parseDsn(dsn: string | null | undefined): ParsedDsn | null {
  if (!dsn) return null
  let parsed: URL
  try {
    parsed = new URL(dsn)
  } catch {
    return null
  }
  const projectId = parsed.pathname.replace(/^\/+/, '')
  const key = parsed.username
  if (!projectId || !key) return null
  return {
    hostname: parsed.hostname,
    key,
    storeUrl: `${parsed.protocol}//${parsed.host}/api/${projectId}/store/`,
  }
}

// Fire-and-forget by design: returns a promise so callers can await in
// tests, but production callers `void` it. Never throws.
export async function reportServerEvent(event: ServerEvent): Promise<void> {
  // Same DSN the client SDKs fetch via /api/telemetry/config (§15.2), so
  // server-side events land in the same self-hosted Glitchtip project as
  // client crashes. Absent/malformed DSN (telemetry not yet provisioned)
  // is a no-op — never a hard failure. A truly broken DSN is surfaced
  // loudly at boot by runTelemetryDsnSelfCheck(), not once per event.
  const parsed = parseDsn(env.EEX_TELEMETRY_DSN)
  if (!parsed) return
  try {
    const res = await fetchWithTimeout(
      parsed.storeUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.key}`,
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
    // fetchWithTimeout NEVER throws: a DNS/connect failure comes back as a
    // synthesized 504, and a Glitchtip auth/quota rejection as a real 4xx/5xx.
    // Either way this server/background error was NOT delivered — the exact
    // silent-drop §S0-1 was filed for. Make it visible (host + status only, no
    // event payload, so a token in the message can never leak into local logs).
    if (!res.ok) {
      log.warn('relay dropped a server/background event — Glitchtip returned non-2xx', {
        status: res.status,
        host: parsed.hostname,
      })
    }
  } catch (err) {
    // Defensive: fetchWithTimeout is not expected to throw, but a serialization
    // or other unexpected error must still surface once rather than vanish —
    // while never breaking the caller.
    log.warn('relay threw — server/background event not delivered', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Injection seam for the boot self-check's DNS resolver (real DNS is
 *  network-bound and would make the unit test flaky). Mirrors ssrfGuard's
 *  __setSsrfLookupForTests pattern. */
type DnsResolver = (hostname: string) => Promise<unknown>

export type TelemetrySelfCheckResult =
  | { status: 'disabled' }
  | { status: 'misconfigured' }
  | { status: 'unresolvable'; hostname: string; error: string }
  | { status: 'probe_failed'; hostname: string; detail: string }
  | { status: 'ok'; hostname: string }

/**
 * Boot-time self-check for the Glitchtip DSN (§S0-1).
 *
 * Glitchtip went blind in production for weeks: the configured DSN host was
 * unresolvable from inside the backend's docker network, so every relay send
 * (and every @sentry/node transport send — same DSN) threw ENOTFOUND and was
 * swallowed. "No errors in Glitchtip" silently meant "no errors DELIVERED",
 * creating false confidence that the app was healthy.
 *
 * This runs once at boot and:
 *   1. DNS-resolves the DSN host — the exact thing that was failing — and logs
 *      LOUDLY (error level, actionable remediation) if it does not resolve.
 *   2. Live-probes the store endpoint so an auth/project misconfig (DNS fine,
 *      endpoint rejects) is also loud, and — when healthy — lands a boot row in
 *      Glitchtip that doubles as the deploy-gate's "direct store test".
 *
 * Never throws and never blocks boot: telemetry must not be able to fail the
 * process it exists to observe. Callers `void` it. Returns the outcome so
 * tests (and a future health endpoint) can assert on it.
 */
export async function runTelemetryDsnSelfCheck(
  resolveHost: DnsResolver = (hostname) => nodeDnsLookup(hostname),
): Promise<TelemetrySelfCheckResult> {
  const dsn = env.EEX_TELEMETRY_DSN
  if (!dsn) {
    // Telemetry not provisioned is a legitimate config (opt-in per plan 006).
    // env.ts already prints the "telemetry disabled" boot warning; stay quiet.
    return { status: 'disabled' }
  }
  const parsed = parseDsn(dsn)
  if (!parsed) {
    log.error(
      'EEX_TELEMETRY_DSN is set but MALFORMED — telemetry is disabled and every ' +
        'server/background error will be silently dropped. Fix the DSN shape ' +
        '(https://<key>@<host>/<projectId>).',
    )
    return { status: 'misconfigured' }
  }

  // 1) DNS — the actual production failure. If the host does not resolve from
  //    inside this container, NOTHING will ever reach Glitchtip.
  try {
    await resolveHost(parsed.hostname)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.error(
      `Glitchtip DSN host "${parsed.hostname}" is UNRESOLVABLE from inside this ` +
        'container — ALL server-side + background-job telemetry will be silently ' +
        'dropped (this is exactly the outage §S0-1 was filed for). Point ' +
        'EEX_TELEMETRY_DSN at a host this network can resolve (a LAN / reverse-proxy ' +
        'address, or a sidecar on the same docker network) — not a bare MagicDNS name.',
      { hostname: parsed.hostname, error: detail },
    )
    return { status: 'unresolvable', hostname: parsed.hostname, error: detail }
  }

  // 2) Live probe — DNS can resolve while the endpoint still rejects (bad key,
  //    wrong project, quota). Send a benign info-level ping and inspect the
  //    HTTP result so an auth/project misconfig is loud at boot too.
  try {
    const res = await fetchWithTimeout(
      parsed.storeUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.key}`,
        },
        body: JSON.stringify({
          level: 'info',
          message: 'eex telemetry self-check (boot)',
          platform: 'node',
        }),
      },
      GLITCHTIP_RELAY_TIMEOUT_MS,
      'telemetry.selfcheck',
    )
    if (!res.ok) {
      log.error(
        `Glitchtip DSN host "${parsed.hostname}" resolves but the store endpoint ` +
          `rejected the boot self-check (HTTP ${res.status}) — telemetry delivery ` +
          'is broken. Verify the DSN key/project and that Glitchtip is reachable.',
        { hostname: parsed.hostname, status: res.status },
      )
      return { status: 'probe_failed', hostname: parsed.hostname, detail: `http_${res.status}` }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.error(
      `Glitchtip DSN host "${parsed.hostname}" resolves but the boot self-check ` +
        'probe threw — telemetry delivery is broken.',
      { hostname: parsed.hostname, error: detail },
    )
    return { status: 'probe_failed', hostname: parsed.hostname, detail }
  }

  log.info('Glitchtip DSN self-check passed — telemetry pipeline reachable', {
    hostname: parsed.hostname,
  })
  return { status: 'ok', hostname: parsed.hostname }
}
