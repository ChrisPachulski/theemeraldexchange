// CSRF defense: reject cross-origin state-changing requests.
//
// Background: session cookies are SameSite=None in prod (Netlify SPA on
// one origin, NAS API on another). That makes them attached to any
// cross-site request, which is exactly what CSRF exploits — an
// attacker's page can fire fetch()/img-src requests at our API and the
// browser will helpfully include the cookie.
//
// Defense: for any state-changing method (POST/PUT/PATCH/DELETE), the
// Origin header must match one of env.allowedOrigins. In dev,
// allowedOrigins is empty (Vite proxy makes everything same-origin),
// so we let those through. Browsers always set Origin on
// non-same-origin POSTs, so an empty Origin in prod => not from a
// trusted SPA tab => reject.
//
// Reads (GET/HEAD) are not gated by the global middleware — they're
// idempotent and serving them to a forged origin leaks nothing the
// user couldn't already see by visiting the SPA directly. The
// exception is a small number of GET routes that DO have side effects
// (e.g. /api/suggestions/:type writes rec_log and recently_shown via
// the local recommender) — those mount requireTrustedOrigin below to
// opt back in to the Origin check regardless of method.

import type { MiddlewareHandler } from 'hono'
import { env } from '../env.js'

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Native clients (the iOS/tvOS app) authenticate with a bearer token and
// send NO cookie. The entire CSRF rationale above is cookie-based: the
// attack is a browser auto-attaching a SameSite=None session cookie to a
// forged cross-origin request. A request carrying `Authorization: Bearer`
// and NO `Cookie` has no ambient credential to ride — the browser never
// auto-attaches an Authorization header, and a bearer can't be forged from
// a victim's tab — so the Origin check is moot for it. A request that
// presents BOTH a bearer and a cookie is still gated: the cookie remains a
// CSRF vector regardless of the bearer.
function isBearerOnly(c: Parameters<MiddlewareHandler>[0]): boolean {
  const auth = c.req.header('authorization')
  if (!auth || !auth.startsWith('Bearer ')) return false
  return !c.req.header('cookie')
}

function checkOrigin(origin: string | undefined): { ok: true } | { ok: false; reason: string } {
  if (env.allowedOrigins.length === 0) {
    // Dev / unconfigured: same-origin via Vite proxy. In prod env.ts
    // refuses to boot without ALLOWED_ORIGINS set, so reaching this
    // branch means NODE_ENV !== 'production'. Belt-and-suspenders:
    // also fail closed on prod here in case env.ts is bypassed.
    if (env.isProd) {
      return { ok: false, reason: 'csrf_misconfigured' }
    }
    return { ok: true }
  }
  if (!origin || !env.allowedOrigins.includes(origin)) {
    return { ok: false, reason: 'bad_origin' }
  }
  return { ok: true }
}

export const requireSafeOrigin: MiddlewareHandler = async (c, next) => {
  if (!STATE_CHANGING.has(c.req.method)) {
    await next()
    return
  }
  if (isBearerOnly(c)) {
    await next()
    return
  }
  const verdict = checkOrigin(c.req.header('origin'))
  if (!verdict.ok) {
    return c.json({ error: 'forbidden', reason: verdict.reason }, 403)
  }
  await next()
}

// Sibling of requireSafeOrigin that does NOT bypass GET/HEAD. Use on
// any route whose handler mutates server state despite being a read
// method — without this, a hostile origin can fire a credentialed GET
// (cookies are SameSite=None in prod) and poison server-side state
// like the recommender's recently_shown rotation.
export const requireTrustedOrigin: MiddlewareHandler = async (c, next) => {
  if (isBearerOnly(c)) {
    await next()
    return
  }
  const verdict = checkOrigin(c.req.header('origin'))
  if (!verdict.ok) {
    return c.json({ error: 'forbidden', reason: verdict.reason }, 403)
  }
  await next()
}
