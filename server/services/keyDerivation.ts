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
// No new npm dependency: Node's built-in crypto.hkdfSync is used
// throughout (available since Node 15.0.0 / LTS 16+).
//
// Handoff note (D2a):
//   The stream-token HMAC key derivation belongs in iptvStreamToken.ts,
//   which is owned by agents impl-d1, impl-d2a, and impl-d3. D18 exports
//   deriveKey here so D2a's agent can call:
//
//     import { deriveKey } from './keyDerivation.js'
//     const streamKey = deriveKey(env.streamTokenSecret, 'eex/stream-token/v1')
//
//   D18 does NOT edit iptvStreamToken.ts. The handoff boundary is this
//   file. D2a wires it.

import { hkdfSync } from 'node:crypto'

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
  // salt = '' means "HKDF-Extract with a zero-length salt" which is the
  // RFC 5869 §2.2 recommended default when no independent salt is
  // available. The env-var secret provides all the entropy; a random salt
  // would add nothing here and would require persistence.
  return Buffer.from(hkdfSync('sha256', secret, '', info, 32))
}
