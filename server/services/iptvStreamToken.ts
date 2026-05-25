import { createHmac, timingSafeEqual } from 'node:crypto'

export type StreamKind = 'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'

export interface StreamClaims {
  kind: StreamKind
  resourceId: string
  sub: string
  exp: number
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

function payload(claims: StreamClaims): string {
  return b64url(Buffer.from(JSON.stringify(claims), 'utf-8'))
}

function sign(secret: string, body: string): string {
  return b64url(createHmac('sha256', secret).update(body).digest())
}

export function signStreamToken(
  secret: string,
  opts: { kind: StreamKind; resourceId: string; sub: string; ttlSecs: number },
): string {
  const claims: StreamClaims = {
    kind: opts.kind,
    resourceId: opts.resourceId,
    sub: opts.sub,
    exp: Math.floor(Date.now() / 1000) + opts.ttlSecs,
  }
  const body = payload(claims)
  const sig = sign(secret, body)
  return `${body}.${sig}`
}

export function verifyStreamToken(secret: string, token: string): StreamClaims {
  const [body, sig] = token.split('.')
  if (!body || !sig) throw new Error('invalid_token')
  const expected = sign(secret, body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('invalid_signature')
  let claims: StreamClaims
  try {
    claims = JSON.parse(b64urlDecode(body).toString('utf-8')) as StreamClaims
  } catch {
    throw new Error('invalid_payload')
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired_token')
  return claims
}
