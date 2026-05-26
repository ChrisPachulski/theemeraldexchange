import { createHmac, timingSafeEqual } from 'node:crypto'
import { ulid } from 'ulid'

/**
 * Valid stream token kinds. Note that `'remux'` has dual membership: it is a valid kind
 * for stream tokens (used in `rewriteRemuxManifest` to mint per-segment tokens, and by
 * `checkToken` to validate them) AND a valid concurrency-tracker kind in `SessionKind`.
 * An earlier draft incorrectly proposed removing `'remux'` from this enum; that would have
 * broken AVPlayer segment playback on the same remux session. See §5.3 of the M1.5 contract.
 */
export type StreamKind = 'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'

export interface StreamClaims {
  kind: StreamKind
  resourceId: string
  sub: string
  exp: number
  /** Unique token ID (26-char ULID). Used for replay defence per §5.5 of the M1.5 contract. */
  jti: string
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
  const now = Math.floor(Date.now() / 1000)
  const claims: StreamClaims = {
    kind: opts.kind,
    resourceId: opts.resourceId,
    sub: opts.sub,
    exp: now + opts.ttlSecs,
    jti: ulid(),
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
