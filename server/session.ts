// Encrypted-cookie session. The session payload is a JWE (A256GCM
// content-encrypted with a SHA-256-derived key from SESSION_SECRET)
// that lives in the `eex.session` HttpOnly cookie. Stateless — no
// server-side store. Rotating SESSION_SECRET invalidates every existing
// session, which is the right behavior for a forced sign-out.
//
// Why JWE instead of plain SignJWT: the payload includes the user's
// Plex auth token (so admin routes can call plex.tv on their behalf).
// SignJWT only signs — the payload is base64-readable, so a copied or
// logged cookie would expose the Plex token to anyone holding it.
// JWE encrypts the payload end-to-end so the cookie is opaque even if
// captured.

import { EncryptJWT, jwtDecrypt } from 'jose'
import { createHash } from 'node:crypto'
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
  /** The user's Plex auth token, threaded through so admin-only routes
   *  (e.g. /api/users) can call plex.tv on their behalf without us
   *  storing a long-lived owner token in env. Optional for forward-
   *  compatibility with existing sessions issued before this field
   *  existed — those users will need to re-auth before token-using
   *  endpoints work for them. */
  plexAuthToken?: string
  verifiedPlexServerId?: string
}

// A256GCM requires a 32-byte key. SESSION_SECRET is arbitrary-length
// user input, so derive a fixed-size key with SHA-256.
const key = createHash('sha256').update(env.sessionSecret, 'utf8').digest()

export async function createSession(payload: Session): Promise<string> {
  return await new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .encrypt(key)
}

export async function verifySession(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtDecrypt(token, key)
    if (typeof payload.sub !== 'string') return null
    if (typeof payload.username !== 'string') return null
    const role = payload.role
    if (role !== 'admin' && role !== 'user') return null
    const plexAuthToken =
      typeof payload.plexAuthToken === 'string' ? payload.plexAuthToken : undefined
    const verifiedPlexServerId =
      typeof payload.verifiedPlexServerId === 'string' ? payload.verifiedPlexServerId : undefined
    return {
      sub: payload.sub,
      username: payload.username,
      role,
      ...(plexAuthToken ? { plexAuthToken } : {}),
      ...(verifiedPlexServerId ? { verifiedPlexServerId } : {}),
    }
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
