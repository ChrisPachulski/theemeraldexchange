// Telemetry configuration endpoint — §15.2 DSN distribution.
//
//   GET /api/telemetry/config  (public bootstrap metadata)
//
// Returns the Sentry-compatible DSN and environment metadata that client
// apps (iOS, tvOS, SPA) fetch at boot to initialize their SDK pointing at
// the self-hoster's own Glitchtip instance. The DSN is not a secret — it
// is an ingestion endpoint whose project key only authorizes writes to that
// project. See §15.2 for the rationale.
//
// Contract reference: §15.2

import { Hono } from 'hono'
import type { Env } from '../middleware/auth.js'
import { env } from '../env.js'

export const telemetry = new Hono<Env>()

telemetry.get('/config', (c) => {
  const dsn = env.EEX_TELEMETRY_DSN
  if (!dsn) {
    // EEX_TELEMETRY_DSN missing means Glitchtip hasn't been configured
    // yet on this installation. 503 is appropriate — the service exists
    // but its backing dependency (Glitchtip) is not provisioned.
    return c.json(
      {
        error: 'telemetry_not_configured',
        detail:
          'EEX_TELEMETRY_DSN is not set. Create an EEX project in ' +
          'Glitchtip, copy the DSN, and set EEX_TELEMETRY_DSN in your ' +
          'environment. Telemetry remains disabled until configured.',
      },
      503,
    )
  }

  // Validate the DSN is a well-formed URL before distributing it to clients.
  // A misconfigured DSN (e.g. a bare hostname, a typo, or an injected value)
  // would cause every client SDK init to silently fail. Validate at the
  // distribution point so the self-hoster gets an immediate 500 rather than
  // a fleet of clients that appear to have telemetry but are actually silent.
  let dsnUrl: URL
  try {
    dsnUrl = new URL(dsn)
  } catch {
    return c.json(
      {
        error: 'telemetry_dsn_invalid',
        detail:
          'EEX_TELEMETRY_DSN is set but is not a valid URL. ' +
          'Sentry-compatible DSNs must be a URL of the form ' +
          'https://<key>@<host>/<projectId>. ' +
          'Correct EEX_TELEMETRY_DSN and restart the server.',
      },
      500,
    )
  }
  if (!['http:', 'https:'].includes(dsnUrl.protocol)) {
    return c.json(
      {
        error: 'telemetry_dsn_invalid',
        detail:
          'EEX_TELEMETRY_DSN must use the http or https scheme. ' +
          `Received scheme: ${dsnUrl.protocol}`,
      },
      500,
    )
  }

  return c.json({
    dsn,
    environment: env.isProd ? 'production' : 'staging',
    release: env.EEX_RELEASE,
  })
})
