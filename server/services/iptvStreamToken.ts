import { randomBytes } from 'node:crypto'
import { contracts, type ContractsTypes } from './contractsBinding.js'

// Sign / verify is delegated to the Rust crate (@emerald/contracts-napi).
// The crate produces byte-identical output to the prior `node:crypto.createHmac`
// path — locked by tests/vectors/stream-token-canonical.json. ULID generation
// and canonicalBytes stay in JS (still exported for tests + as a parity
// oracle against the crate).

/**
 * StreamKind — the `kind` claim embedded in every stream token (§5.3).
 *
 * `'remux'` is a DUAL-MEMBERSHIP kind: it appears here (token kind) AND in
 * SessionKind (concurrency-tracker kind) in iptvConcurrency.ts. An AVPlayer
 * HLS remux session emits `kind: 'remux'` tokens for both the manifest URL and
 * per-segment proxy URLs, and simultaneously holds a `SessionKind = 'remux'`
 * concurrency slot. Both enums must keep `'remux'`; removing it from either
 * enum independently breaks AVPlayer segment playback — an earlier contract
 * draft proposed stripping it from StreamKind, which was incorrect. See §5.3
 * for the full dual-membership mapping and the rationale for keeping it here.
 *
 * `'recording'` was reserved for M6 and is now minted by the DVR playback
 * grant. It remains mirrored by Rust `stream_token::StreamKind::Recording`
 * and the original `recording-m6-reserved` compatibility vector.
 */
export type StreamKind =
  | 'live'
  | 'vod'
  | 'series'
  | 'catchup'
  | 'segment'
  | 'remux'
  | 'playlist'
  | 'recording'

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

export function generateUlid(nowMs: number = Date.now()): string {
  // 10 chars for 48-bit timestamp. writeUIntBE natively validates the value is
  // in [0, 2**48); Date.now() stays in that range until ~year 10889. The prior
  // `& 0xffffffffffff` mask was a bug: JS bitwise-AND coerces both operands to
  // 32-bit SIGNED ints, so the 48-bit mask became -1 and the timestamp became a
  // negative int32, which made writeUIntBE throw on every call.
  const tsBuf = Buffer.allocUnsafe(6)
  tsBuf.writeUIntBE(nowMs, 0, 6)
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
// Sign / Verify — delegated to @emerald/contracts-napi
// ---------------------------------------------------------------------------

// Map crate error strings to the legacy `Error('invalid_signature')` /
// `Error('expired_token')` / `Error('token_not_yet_valid')` shape callers
// already match on. The crate emits `verify failed: <Variant>` or
// `<Variant>` — extract and rename.
function rethrowAsLegacy(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('Expired') || msg.includes('expired_token')) throw new Error('expired_token')
  if (msg.includes('NotYetValid') || msg.includes('token_not_yet_valid'))
    throw new Error('token_not_yet_valid')
  // Crate's strict-struct serde parse fails on missing `v`/`iat`/`nbf` with
  // BadPayload before reaching UnsupportedVersion. Pre-crate JS reached the
  // version check first; preserve that user-visible labeling so the
  // "rejected token" classifier and tests stay stable.
  if (
    msg.includes('UnsupportedVersion') ||
    msg.includes('BadPayload') ||
    msg.includes('token_version_unsupported')
  )
    throw new Error('token_version_unsupported')
  // Anything else (signature mismatch, base64 decode, malformed) maps to
  // the legacy `invalid_signature` opaque error — callers branch on this.
  throw new Error('invalid_signature')
}

export function signStreamToken(
  secret: string,
  opts: { kind: StreamKind; resourceId: string; sub: string; ttlSecs: number; jti?: string },
): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: StreamClaims = {
    exp: now + opts.ttlSecs,
    iat: now,
    jti: opts.jti ?? generateUlid(),
    k: opts.kind,
    nbf: now,
    rid: opts.resourceId,
    sub: opts.sub,
    v: 1,
  }
  // Crate accepts the canonical JSON-ordered shape directly; v is a u32.
  return contracts.streamTokenSign(Buffer.from(secret, 'utf-8'), {
    exp: claims.exp,
    iat: claims.iat,
    jti: claims.jti,
    k: claims.k,
    nbf: claims.nbf,
    rid: claims.rid,
    sub: claims.sub,
    v: claims.v,
  })
}

export function verifyStreamToken(secret: string, token: string): StreamClaims {
  let c: ContractsTypes.StreamClaimsJs
  try {
    c = contracts.streamTokenVerify(Buffer.from(secret, 'utf-8'), token)
  } catch (e) {
    rethrowAsLegacy(e)
  }
  // Crate's enforce_time_window applies the ±30s/±5s skew.
  try {
    contracts.streamTokenEnforceTimeWindow(c, Math.floor(Date.now() / 1000))
  } catch (e) {
    rethrowAsLegacy(e)
  }
  return {
    exp: c.exp,
    iat: c.iat,
    jti: c.jti,
    k: c.k as StreamKind,
    nbf: c.nbf,
    rid: c.rid,
    sub: c.sub,
    v: 1,
  }
}

/**
 * Verify a stream token against TWO secrets — the canonical (primary) and a
 * fallback (legacy / pre-rotation). The crate's verify_dual_key computes both
 * HMACs unconditionally so a timing-side-channel cannot reveal which key
 * matched (§5.4).
 *
 * Reserved for a future STREAM_TOKEN_SECRET rotation window: pass the OLD
 * stream-token secret as the fallback while the longest token TTL drains, and
 * mint with the new primary only. No production verify site uses this today —
 * the D2a SESSION_SECRET fallback expired and was removed (single-key
 * verification everywhere), and the fallback must never again be a secret of
 * a *different* class (key separation, §5.4).
 */
export function verifyStreamTokenDualKey(
  primarySecret: string,
  fallbackSecret: string,
  token: string,
): StreamClaims {
  let r: ContractsTypes.DualKeyVerifyResult
  try {
    r = contracts.streamTokenVerifyDualKey(
      Buffer.from(primarySecret, 'utf-8'),
      Buffer.from(fallbackSecret, 'utf-8'),
      token,
    )
  } catch (e) {
    rethrowAsLegacy(e)
  }
  try {
    contracts.streamTokenEnforceTimeWindow(r.claims, Math.floor(Date.now() / 1000))
  } catch (e) {
    rethrowAsLegacy(e)
  }
  return {
    exp: r.claims.exp,
    iat: r.claims.iat,
    jti: r.claims.jti,
    k: r.claims.k as StreamKind,
    nbf: r.claims.nbf,
    rid: r.claims.rid,
    sub: r.claims.sub,
    v: 1,
  }
}
