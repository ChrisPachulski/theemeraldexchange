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
// Reads (GET/HEAD) are not gated — they're idempotent and serving them
// to a forged origin leaks nothing the user couldn't already see by
// visiting the SPA directly.

import type { MiddlewareHandler } from 'hono'
import { env } from '../env.js'

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const requireSafeOrigin: MiddlewareHandler = async (c, next) => {
  if (!STATE_CHANGING.has(c.req.method)) {
    await next()
    return
  }
  if (env.allowedOrigins.length === 0) {
    // Dev / unconfigured: same-origin via Vite proxy. In prod env.ts
    // refuses to boot without ALLOWED_ORIGINS set, so reaching this
    // branch means NODE_ENV !== 'production'. Belt-and-suspenders:
    // also fail closed on prod here in case env.ts is bypassed.
    if (env.isProd) {
      return c.json({ error: 'forbidden', reason: 'csrf_misconfigured' }, 403)
    }
    await next()
    return
  }
  const origin = c.req.header('origin')
  if (!origin || !env.allowedOrigins.includes(origin)) {
    return c.json({ error: 'forbidden', reason: 'bad_origin' }, 403)
  }
  await next()
}
