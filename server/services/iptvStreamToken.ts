import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type StreamKind = 'live' | 'vod' | 'series' | 'catchup' | 'segment' | 'remux' | 'playlist'

// V1 canonical claim shape (§5.2). Short key names to save bytes in URL query params.
// Alphabetical key order matches the fixed-template serializer below.
export interface StreamClaims {
  exp: number    // Unix seconds — expiry
  iat: number    // Unix seconds — issued-at
  jti: string    // 26-char ULID — unique token ID
  k: StreamKind  // token kind
  nbf: number    // Unix seconds — not-before (== iat at mint)
  rid: string    // resource identifier
  sub: string    // subject (namespace-prefixed per §8)
  v: 1           // contract version
}

// ---------------------------------------------------------------------------
// ULID generation (Crockford base32, 26 chars, 48-bit ms timestamp + 80-bit random)
// We hand-roll a minimal ULID rather than pulling a dependency so the token
// service has zero non-crypto external surface.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeBase32Crockford(bytes: Buffer, bits: number): string {
  let result = ''
  let bitsLeft = 0
  let current = 0
  const totalChars = Math.ceil(bits / 5)
  // Fill from the buffer in 5-bit groups, MSB first
  let byteIdx = 0
  for (let i = 0; i < totalChars; i++) {
    if (bitsLeft < 5) {
      current = (current << 8) | (byteIdx < bytes.length ? bytes[byteIdx++] : 0)
      bitsLeft += 8
    }
    bitsLeft -= 5
    result += CROCKFORD[(current >> bitsLeft) & 0x1f]
  }
  return result
}

export function generateUlid(): string {
  const now = Date.now()
  // 10 chars for 48-bit timestamp
  const tsBuf = Buffer.allocUnsafe(6)
  tsBuf.writeUIntBE(now & 0xffffffffffff, 0, 6)
  const tsPart = encodeBase32Crockford(tsBuf, 50).slice(-10)
  // 16 chars for 80-bit random
  const rndBuf = randomBytes(10)
  const rndPart = encodeBase32Crockford(rndBuf, 80)
  return tsPart + rndPart
}

// ---------------------------------------------------------------------------
// Fixed-template canonical serializer (§5.1)
// Produces the exact byte sequence:
//   {"exp":<int>,"iat":<int>,"jti":"<ulid>","k":"<kind>","nbf":<int>,"rid":"<rid>","sub":"<sub>","v":1}
// Keys are alphabetical. Integers are bare decimal. Strings use minimal JSON escaping.
// No whitespace. UTF-8 output.
// ---------------------------------------------------------------------------

function jsonEscapeString(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; ) {
    // codePointAt decodes surrogate pairs; charCodeAt would return the bare
    // surrogate value which Buffer.from(..., 'utf-8') replaces with U+FFFD,
    // causing an HMAC mismatch against any cross-language verifier that
    // properly encodes the code point.
    const cp = s.codePointAt(i)!
    if (cp === 0x22) { out += '\\"'; i++; continue }
    if (cp === 0x5c) { out += '\\\\'; i++; continue }
    if (cp === 0x08) { out += '\\b'; i++; continue }
    if (cp === 0x09) { out += '\\t'; i++; continue }
    if (cp === 0x0a) { out += '\\n'; i++; continue }
    if (cp === 0x0c) { out += '\\f'; i++; continue }
    if (cp === 0x0d) { out += '\\r'; i++; continue }
    if (cp < 0x20) {
      out += '\\u' + cp.toString(16).padStart(4, '0')
      i++
      continue
    }
    // Emit as UTF-16 code units (the natural string slice); surrogate pairs
    // occupy two code units so we advance i by 2 for code points above U+FFFF.
    if (cp > 0xffff) {
      out += s[i] + s[i + 1]
      i += 2
    } else {
      out += s[i]
      i++
    }
  }
  return out
}

export function canonicalBytes(claims: StreamClaims): Uint8Array {
  const s =
    '{"exp":' + claims.exp +
    ',"iat":' + claims.iat +
    ',"jti":"' + jsonEscapeString(claims.jti) +
    '","k":"' + jsonEscapeString(claims.k) +
    '","nbf":' + claims.nbf +
    ',"rid":"' + jsonEscapeString(claims.rid) +
    '","sub":"' + jsonEscapeString(claims.sub) +
    '","v":1}'
  return Buffer.from(s, 'utf-8')
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

const b64url = (b: Uint8Array): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

// ---------------------------------------------------------------------------
// Sign / Verify
// ---------------------------------------------------------------------------

function hmac(secret: string, data: Uint8Array): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

export function signStreamToken(
  secret: string,
  opts: { kind: StreamKind; resourceId: string; sub: string; ttlSecs: number },
): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: StreamClaims = {
    exp: now + opts.ttlSecs,
    iat: now,
    jti: generateUlid(),
    k: opts.kind,
    nbf: now,
    rid: opts.resourceId,
    sub: opts.sub,
    v: 1,
  }
  const canonical = canonicalBytes(claims)
  const body = b64url(canonical)
  const sig = b64url(hmac(secret, canonical))
  return `${body}.${sig}`
}

// Clock-skew tolerance per §5.7:
//   accept if  nbf - 30s  <=  now  <=  exp + 5s
const NBF_SKEW_SECS = 30
const EXP_SKEW_SECS = 5

export function verifyStreamToken(secret: string, token: string): StreamClaims {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) throw new Error('invalid_token')
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const payloadBytes = b64urlDecode(body)

  // Verify HMAC over the raw canonical bytes (not re-serialised from parsed struct)
  const expected = b64url(hmac(secret, payloadBytes))
  const aBuf = Buffer.from(sig)
  const bBuf = Buffer.from(expected)
  if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) throw new Error('invalid_signature')

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(payloadBytes.toString('utf-8')) as Record<string, unknown>
  } catch {
    throw new Error('invalid_payload')
  }

  // Version check per §5.2
  if (raw['v'] == null || typeof raw['v'] !== 'number' || raw['v'] !== 1) {
    throw new Error('token_version_unsupported')
  }

  const claims: StreamClaims = {
    exp: raw['exp'] as number,
    iat: raw['iat'] as number,
    jti: raw['jti'] as string,
    k: raw['k'] as StreamKind,
    nbf: raw['nbf'] as number,
    rid: raw['rid'] as string,
    sub: raw['sub'] as string,
    v: 1,
  }

  const now = Math.floor(Date.now() / 1000)
  if (now > claims.exp + EXP_SKEW_SECS) throw new Error('expired_token')
  if (now < claims.nbf - NBF_SKEW_SECS) throw new Error('token_not_yet_valid')

  return claims
}
