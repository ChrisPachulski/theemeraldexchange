// Hand-authored type declarations mirroring crates/emerald-contracts-napi/src/lib.rs.
// Kept in lock-step with the Rust #[napi] exports. The napi-rs v3 CLI does
// not auto-emit a .d.ts for napi 2.16 crates, so this file is the contract.
//
// Wire-format parity with `jose` / `node:crypto` is enforced by the test
// vectors under tests/vectors/ — these types are just the TypeScript view
// of the surface area.

export interface DerivedKey {
  /** 32-byte HKDF-Expand output as a Node Buffer. */
  bytes: Buffer
}

/** HKDF-Expand(secret, INFO_SESSION, 32) per contract §3.1. */
export function hkdfSession(secret: Buffer): DerivedKey
/** HKDF-Expand(secret, INFO_DEVICE_TOKEN, 32) per contract §3.4. */
export function hkdfDeviceToken(secret: Buffer): DerivedKey
/** HKDF-Expand(secret, INFO_INTERNAL_PRINCIPAL, 32) per contract §4. */
export function hkdfInternalPrincipal(secret: Buffer): DerivedKey
/**
 * Generic HKDF-Extract+Expand (RFC 5869, SHA-256, zero-length salt,
 * 32-byte OKM) with a caller-supplied info label. Backs the production
 * `deriveKey()` in server/services/keyDerivation.ts. `info` MUST be one
 * of the frozen INFO_* labels — it is a wire-contract value, not a
 * free-form string.
 */
export function hkdfDerive(secret: Buffer, info: string): DerivedKey

// ---------------------------------------------------------------------------
// Stream tokens (HMAC-SHA256, raw env-var bytes — see contract D18)
// ---------------------------------------------------------------------------

export interface StreamClaimsJs {
  exp: number
  iat: number
  jti: string
  /** Stream kind tag: 'live' | 'segment' | 'playlist' | 'recording' (M6). */
  k: string
  nbf: number
  rid: string
  sub: string
  v: number
}

export function streamTokenSign(secret: Buffer, claims: StreamClaimsJs): string
export function streamTokenVerify(secret: Buffer, token: string): StreamClaimsJs

export interface DualKeyVerifyResult {
  claims: StreamClaimsJs
  usedFallback: boolean
}
export function streamTokenVerifyDualKey(
  primary: Buffer,
  fallback: Buffer,
  token: string,
): DualKeyVerifyResult

/** Throws on nbf/exp violation; ±30s/±5s skew per contract §6. */
export function streamTokenEnforceTimeWindow(claims: StreamClaimsJs, nowSecs: number): void

// ---------------------------------------------------------------------------
// Device tokens (JWE A256GCM, kid-aware multi-key dispatch)
// ---------------------------------------------------------------------------

export interface DeviceClaimsJs {
  aud: string
  iss: string
  sub: string
  role: string
  authMode: string
  deviceId: string
  devicePlatform: string
  serverId: string
  jti: string
  iat: number
  nbf: number
  exp: number
}

export function deviceTokenEncrypt(key: Buffer, kid: string, claims: DeviceClaimsJs): string

export interface KidKey {
  kid: string
  key: Buffer
}
export function deviceTokenDecrypt(keys: Array<KidKey>, token: string): DeviceClaimsJs

// ---------------------------------------------------------------------------
// Internal principal (server→service JWE)
// ---------------------------------------------------------------------------

export interface InternalClaimsJs {
  iss: string
  sub: string
  role: string
  authMode: string
  serverId: string
  /** Optional. Omit the property entirely when absent — passing
   *  explicit `null` raises a napi conversion error in 2.16. */
  deviceId?: string
  reqId: string
  iat: number
  exp: number
}

export function internalPrincipalEncrypt(
  key: Buffer,
  kid: string,
  claims: InternalClaimsJs,
): string

// ---------------------------------------------------------------------------
// Sub namespace parsing (plex:<id> | local:<ulid> | apple:<siwa-id>)
// ---------------------------------------------------------------------------

export interface SubJs {
  provider: 'plex' | 'local' | 'apple'
  id: string
  raw: string
}
export function parseSub(s: string): SubJs

// ---------------------------------------------------------------------------
// Telemetry PII scrub
// ---------------------------------------------------------------------------

export function piiScrubKeys(): Array<string>
/** Returns a JSON string with PII keys scrubbed in-place. */
export function piiScrubValue(jsonStr: string): string
