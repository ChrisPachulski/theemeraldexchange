// Signed-cookie session. The session payload is a tiny JWT (HS256)
// that lives in the `eex.session` HttpOnly cookie. Stateless — no
// server-side store. Rotating SESSION_SECRET invalidates every existing
// session, which is the right behavior for a forced sign-out.

import { SignJWT, jwtVerify } from 'jose'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { env } from './env.js'

const COOKIE_NAME = 'eex.session'
const SESSION_TTL_DAYS = 30

export type Role = 'admin' | 'user'

export type Session = {
  sub: string // plex user id (string for jwt sub claim)
  username: string
  role: Role
}

const secret = new TextEncoder().encode(env.sessionSecret)

export async function createSession(payload: Session): Promise<string> {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(secret)
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    if (typeof payload.sub !== 'string') return null
    if (typeof payload.username !== 'string') return null
    const role = payload.role
    if (role !== 'admin' && role !== 'user') return null
    return { sub: payload.sub, username: payload.username, role }
  } catch {
    return null
  }
}

export async function setSessionCookie(c: Context, session: Session): Promise<void> {
  const token = await createSession(session)
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' })
}

export async function readSession(c: Context): Promise<Session | null> {
  const token = getCookie(c, COOKIE_NAME)
  if (!token) return null
  return await verifySession(token)
}
