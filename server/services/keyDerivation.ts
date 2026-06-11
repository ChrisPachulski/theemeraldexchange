// HKDF-Extract+Expand key derivation (RFC 5869, SHA-256).
//
// All symmetric keys in this server are derived from a high-entropy
// secret via HKDF rather than plain SHA-256 or direct use. HKDF
// provides formal domain separation through the `info` parameter: even
// if two secrets happen to be identical, derivations with different
// `info` strings produce unrelated key material.
//
// Derivation labels (info strings) are stable identifiers. Once a
// label is deployed, changing it silently rotates every key derived
// with that label — equivalent to rotating the underlying secret.
// Never rename or reuse a label.
//
// Usage:
//   const key = deriveKey(env.sessionSecret, 'eex/session/v1')
//
// Returns a 32-byte Buffer suitable for A256GCM encryption (JWE) or as
// HMAC key material.
//
// The derivation itself is delegated to the canonical Rust implementation
// (emerald-contracts::hkdf via the N-API binding) — same hard-required
// posture as every other contracts consumer (see contractsBinding.ts):
// the binding throws at import time when the addon is missing, so there
// is no silent JS fallback that could drift from the contract. Byte
// equality with Node's `crypto.hkdfSync('sha256', secret, '', info, 32)`
// is locked by tests/vectors/hkdf-parity.json and by an independent
// node:crypto oracle in keyDerivation.test.ts.
//
// Stream-token derivation note (locked 2026-05-27, ambitions-audit):
//   Stream tokens DO NOT use HKDF. `signStreamToken` / `verifyStreamToken`
//   call `createHmac('sha256', env.streamTokenSecret)` with the raw env-var
//   string as the HMAC key. INFO_STREAM_TOKEN below is reserved for a
//   future migration but is NOT wired today.
//
//   Why: STREAM_TOKEN_SECRET is already domain-separated from
//   SESSION_SECRET / DEVICE_TOKEN_SECRET by the boot-time pairwise
//   distinctness check (`assertSecretsDistinct`). HKDF would buy zero
//   additional separation for stream tokens, and wiring it post-M1.5
//   would either invalidate every 90-day playlist token in production
//   or require a tri-key verifier (raw-old + HKDF-new + legacy-SESSION
//   fallback) which is more complexity than the security gain warrants.
//
//   Test vector: `tests/vectors/stream-token-canonical.json` `_meta.hmac_key_is`
//   is `"raw_utf8_of_test_key"`. Rust port MUST match this — no HKDF.

import { contracts } from './contractsBinding.js'

// ---------------------------------------------------------------------------
// Info-string constants (domain-separation labels, RFC 5869 §3.2)
//
// These are the canonical info parameters for every HKDF derivation in this
// codebase. Defined here — not inline at call sites — so that a typo or
// rename is a compile-time/grep error rather than a silent key rotation.
//
// Cross-platform byte-equality guarantee (M2 Rust / Swift):
//   All strings are pure ASCII (code points 0x2F, 0x65–0x78, 0x31).
//   UTF-8, Latin-1, and US-ASCII produce identical byte sequences.
//   Rust:  b"eex/session/v1"  → identical bytes
//   Swift: "eex/session/v1".data(using: .utf8)!  → identical bytes
//   Never add non-ASCII characters to these labels.
// ---------------------------------------------------------------------------
export const INFO_SESSION = 'eex/session/v1' as const
export const INFO_DEVICE_TOKEN = 'eex/device-token/v1' as const
export const INFO_STREAM_TOKEN = 'eex/stream-token/v1' as const
/** Per contract §4 (Hybrid D + Rust-canonical). 60-second JWE attached
 *  to every internal service call (recommender, M3 media-core, M4
 *  transcoder). Pure ASCII for byte-equality across Rust/Swift. */
export const INFO_INTERNAL_PRINCIPAL = 'eex/internal-principal/v1' as const

/**
 * Derive a 32-byte AES-GCM / HMAC key from an arbitrary-length secret
 * using HKDF-Extract+Expand (RFC 5869, SHA-256).
 *
 * @param secret  The input key material (IKM) — the raw env-var value.
 * @param info    Domain-separation label — use one of the INFO_* constants
 *                exported from this module. Must not change after deployment
 *                without a key rotation.
 * @returns       A 32-byte Buffer of output key material.
 *
 * Note on `kid` and key rotation (v2):
 *   At v1 there is a single active key per purpose; no `kid` header is
 *   needed in JWE because there is no ambiguity about which key to try.
 *   When v2 introduces a second concurrent key (e.g. rolling rotation),
 *   the JWE protected header MUST include `kid` so the verifier can select
 *   the correct key without brute-forcing both. Add kid support before
 *   deploying any multi-key scenario.
 */
export function deriveKey(secret: string, info: string): Buffer {
  // Zero-length salt is baked into the Rust implementation — the RFC 5869
  // §2.2 recommended default when no independent salt is available. The
  // env-var secret provides all the entropy; a random salt would add
  // nothing here and would require persistence.
  return Buffer.from(contracts.hkdfDerive(Buffer.from(secret, 'utf-8'), info).bytes)
}
