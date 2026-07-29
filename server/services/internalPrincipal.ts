// Internal-principal JWE minter per contract §4 (Hybrid D + Rust-canonical).
//
// Hono attaches one of these to every outbound call to an internal
// service (recommender today, M3 media-core, M4 transcoder later).
// The receiving service decrypts it, reads sub/role/auth_mode/serverId
// out of the claim set, and trusts those without re-verifying the
// caller's session cookie or device token.
//
// 60-second TTL — short enough that a stolen token can't be replayed
// outside the request's natural lifetime, long enough to survive
// reasonable clock skew between the two containers. No nbf skew.
//
// Wire bytes are produced by the canonical Rust crate via N-API
// (`@emerald/contracts-napi`). Recommender will verify these via the
// PyO3 binding (`crates/emerald-contracts-pyo3`) once M3 cuts over.
//
// Boot-time guard: requires INTERNAL_PRINCIPAL_SECRET to be set in
// production. Tolerated absent in dev so localhost-without-sidecar
// still boots; the mint helper throws on first call instead.

import { contracts } from './contractsBinding.js'

import { env } from '../env.js'
import { generateUlid } from './iptvStreamToken.js'
import { deriveKey, INFO_INTERNAL_PRINCIPAL } from './keyDerivation.js'

/** Active kid for the v1 key. Bump on rotation; verifier keymap stays
 *  populated with both kids during the grace window. The canonical
 *  Rust constant lives in
 *  `crates/emerald-contracts/src/internal_principal.rs::DEFAULT_KID`. */
export const INTERNAL_PRINCIPAL_KID = 'internal-v1'

/** Per contract §4: 60-second TTL on every internal-principal JWE.
 *  Receiving services hard-enforce; no nbf skew. */
export const INTERNAL_PRINCIPAL_TTL_SECS = 60

let cachedInternalKey: Uint8Array | null = null

function getInternalKey(): Uint8Array {
  if (!env.internalPrincipalSecret) {
    throw new Error(
      'mintInternalPrincipal called without INTERNAL_PRINCIPAL_SECRET configured. ' +
        'Set INTERNAL_PRINCIPAL_SECRET in .env.local (and .env.production for prod). ' +
        'Required for any internal service call per contract §4.',
    )
  }
  if (!cachedInternalKey) {
    cachedInternalKey = deriveKey(env.internalPrincipalSecret, INFO_INTERNAL_PRINCIPAL)
  }
  return cachedInternalKey
}

/** Test-only: clear the cached key after rotating the secret in tests. */
export function _resetInternalKeyForTests(): void {
  cachedInternalKey = null
}

export type InternalPrincipalInput = {
  /** The acting subject (e.g. `plex:12345`, `local:<ulid>`). Must
   *  already be in canonical namespaced form per §8. */
  sub: string
  /** `user` or `admin`. */
  role: string
  /** Auth provider that established the session: `plex` | `local` | `apple`. */
  authMode: string
  /** Stable server UUID from server_state (§12.3). */
  serverId: string
  /** Optional paired-device id when the call originated from a Bearer
   *  device token. Cookie-session calls leave this null. */
  deviceId?: string | null
  /** Correlation id from the inbound Hono request. Background work omits it
   * and receives a fresh ULID. */
  reqId?: string
}

/** Mint an internal-principal JWE for one in-flight request.
 *
 *  Returns the compact JWE string. Caller attaches it to outbound
 *  requests as `Authorization: Bearer <token>` (or in a dedicated
 *  header — finalize at call-site).
 */
export function mintInternalPrincipal(input: InternalPrincipalInput): string {
  const key = getInternalKey()
  const now = Math.floor(Date.now() / 1000)
  const exp = now + INTERNAL_PRINCIPAL_TTL_SECS
  const reqId = input.reqId || generateUlid()

  // napi-rs 2.16 maps Rust `Option<String>` to TS `string | undefined` —
  // passing `null` triggers "Failed to convert JavaScript value `Null`".
  // Omit the field entirely when there's no device id.
  const claims: {
    iss: string
    sub: string
    role: string
    authMode: string
    serverId: string
    reqId: string
    iat: number
    exp: number
    deviceId?: string
  } = {
    iss: 'eex',
    sub: input.sub,
    role: input.role,
    authMode: input.authMode,
    serverId: input.serverId,
    reqId,
    iat: now,
    exp,
  }
  if (input.deviceId) claims.deviceId = input.deviceId
  return contracts.internalPrincipalEncrypt(Buffer.from(key), INTERNAL_PRINCIPAL_KID, claims)
}
