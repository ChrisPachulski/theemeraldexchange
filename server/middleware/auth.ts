// Auth gates for the API. `requireAuth` rejects anyone without a valid
// session cookie with 401. `requireAdmin` further rejects non-admins
// with 403 — used on every destructive (delete / pause / cancel /
// blocklist) endpoint.

import type { MiddlewareHandler } from 'hono'
import { readSession } from '../session.js'
import type { Session } from '../session.js'

export type Env = {
  Variables: {
    session: Session
  }
}

export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  const session = await readSession(c)
  if (!session) return c.json({ error: 'unauthenticated' }, 401)
  c.set('session', session)
  await next()
}

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  const session = await readSession(c)
  if (!session) return c.json({ error: 'unauthenticated' }, 401)
  if (session.role !== 'admin') {
    return c.json({ error: 'forbidden', reason: 'admin_only' }, 403)
  }
  c.set('session', session)
  await next()
}
