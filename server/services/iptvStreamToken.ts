import { contracts, type ContractsTypes } from './contractsBinding.js'
import { ulid } from './ulid.js'

// Sign / verify is delegated to the Rust crate (@emerald/contracts-napi),
// locked by tests/vectors/stream-token-canonical.json.

/**
 * StreamKind — the `kind` claim embedded in every stream token (§5.3), mirrored
 * by Rust `stream_token::StreamKind`. The iptv service mints the IPTV and DVR
 * kinds; Hono verifies them on the ?t= routes before forwarding, and mints
 * 'vod'/'remux' for local media (mediaStreamToken.ts).
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
  opts: { kind: StreamKind; resourceId: string; sub: string; ttlSecs: number },
): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: StreamClaims = {
    exp: now + opts.ttlSecs,
    iat: now,
    jti: ulid(),
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
