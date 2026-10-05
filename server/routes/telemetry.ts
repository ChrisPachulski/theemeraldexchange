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
import { bodyLimit } from 'hono/body-limit'
import type { Env } from '../middleware/auth.js'
import { rateLimit } from '../middleware/rateLimit.js'
import { env } from '../env.js'
import { serverSideDsn } from '../services/serverTelemetry.js'
import { fetchWithTimeout } from '../services/upstream.js'

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

// POST /api/telemetry/tunnel — Sentry `tunnel` for the SPA. The public DSN's
// host (a Tailscale MagicDNS name) is unreachable from browsers off the
// tailnet, and GlitchTip answers a CORS preflight with a 302 to /login, so the
// SPA's crash reports never arrived: a web live player that threw on every
// channel for five weeks left zero events. The SPA now posts envelopes here,
// over the API origin it already talks to, and the backend forwards them to
// GlitchTip on the docker network (serverSideDsn).
//
// Open (crashes happen before sign-in) but narrow: the envelope header's DSN
// must name OUR key + project, the body is capped, and callers are
// rate-limited, so the route cannot be used to post anywhere else.
const TUNNEL_BODY_LIMIT_BYTES = 256 * 1024
const TUNNEL_TIMEOUT_MS = 5000
const tunnelRateLimit = rateLimit({ name: 'telemetry-tunnel', capacity: 30, refill: 30, intervalMs: 60_000 })

function dsnIdentity(dsn: string | null | undefined): { key: string; projectId: string } | null {
  if (!dsn) return null
  try {
    const u = new URL(dsn)
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '')
    return u.username && projectId ? { key: u.username, projectId } : null
  } catch {
    return null
  }
}

telemetry.post(
  '/tunnel',
  tunnelRateLimit,
  bodyLimit({ maxSize: TUNNEL_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
  async (c) => {
    const pub = dsnIdentity(env.EEX_TELEMETRY_DSN)
    const target = serverSideDsn()
    if (!pub || !target) return c.json({ error: 'telemetry_not_configured' }, 503)

    const body = await c.req.text()
    let header: { dsn?: unknown }
    try {
      header = JSON.parse(body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n')))
    } catch {
      return c.json({ error: 'invalid_envelope' }, 400)
    }
    const claimed = dsnIdentity(typeof header.dsn === 'string' ? header.dsn : null)
    if (!claimed || claimed.key !== pub.key || claimed.projectId !== pub.projectId) {
      return c.json({ error: 'dsn_mismatch' }, 403)
    }

    const t = new URL(target)
    // GlitchTip (unlike Sentry) does not authenticate an envelope by the DSN in
    // its header: without sentry_key in the query it answers 403 Denied.
    const url = `${t.protocol}//${t.host}/api/${pub.projectId}/envelope/?sentry_version=7&sentry_key=${encodeURIComponent(pub.key)}`
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body },
        TUNNEL_TIMEOUT_MS,
        'telemetry.tunnel',
      )
      return c.body(null, res.ok ? 200 : 502)
    } catch {
      return c.body(null, 502)
    }
  },
)
