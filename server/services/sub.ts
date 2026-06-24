// Identity namespace helpers. Every `sub` value stored or transmitted
// by this server follows `<provider>:<provider_id>` per §8 of the
// M1.5 contract.
//
// parseSub is the single parse point used everywhere a `sub` is read
// or written. The actual provider grammar (no leading zeros for plex,
// Crockford Base32 for local, dot-separated SIWA format for apple) is
// the canonical Rust implementation in emerald-contracts::sub, consumed
// here via the N-API binding — same hard-required posture as every
// other contracts consumer (contractsBinding.ts throws at import time
// when the addon is missing, so there is no silent JS reimplementation
// that could drift from the contract). This module keeps only the
// TS-specific concerns: the legacy error labels callers match on
// ('sub_missing_namespace' / 'sub_invalid_format'), the
// whitespace-strictness guard, and the D7 grace-window normalisation
// (which depends on a per-deployment timer the crate cannot know).
//
// Grace window (§8.2):
//   M1 cookies and stream tokens carried unprefixed Plex user ids.
//   tryParseLegacySub normalises a bare numeric string → plex:<id>
//   in memory during the 30-day grace period post-D7. After that
//   window closes, callers should drop the legacy path and call
//   parseSub directly.
//
// Reference: §8.1 (provider patterns — regex literals live in
//            crates/emerald-contracts/src/sub.rs), §8.3 (parser
//            pseudocode), §13.1 (test vectors at
//            tests/vectors/sub-namespace.json).

import { contracts } from './contractsBinding.js'

export type SubProvider = 'plex' | 'local' | 'apple' | 'google'

export type Sub = {
  provider: SubProvider
  id: string
  /** The canonical namespaced form: `<provider>:<id>` */
  raw: string
}

// Per §8.1 (regex literals are the contract and live in the canonical
// Rust implementation, crates/emerald-contracts/src/sub.rs):
//   plex:   positive integer, no leading zeros (0 itself is valid)
//   local:  Crockford Base32 ULID, 26 chars, uppercase
//   apple:  SIWA dot-separated subject  NNNNNN.32hexchars.NNNN
//
// SIWA sub can mutate ONLY on Apple developer-account transfer
// (team-rescope). Document at §8.1 contract update time.

/**
 * Parse and validate a namespaced `sub` string. Delegates the provider
 * grammar to the canonical Rust parser (emerald-contracts::sub via the
 * N-API binding) and maps the crate's error variants onto the legacy TS
 * error labels callers already match on:
 *
 * Throws `sub_missing_namespace` if no colon is present
 *                                (crate `Unprefixed`).
 * Throws `sub_invalid_format`    if the provider pattern does not match
 *                                or the provider is unrecognised
 *                                (crate `InvalidFormat` / `UnknownProvider`).
 * Throws `sub_invalid_format`    if trimming was needed (leading/trailing
 *                                whitespace is not silently accepted). The
 *                                guard is TS-side so whitespace keeps its
 *                                historical `sub_invalid_format` label even
 *                                in colon-less inputs, where the crate
 *                                would report `Unprefixed`.
 */
export function parseSub(s: string): Sub {
  const trimmed = s.trim()
  if (trimmed !== s) {
    throw new Error('sub_invalid_format')
  }

  let parsed: { provider: string; id: string; raw: string }
  try {
    parsed = contracts.parseSub(s)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Crate errors arrive as Error::from_reason(format!("{:?}", e)) —
    // the bare variant name. Anything unrecognised is still a parse
    // failure, so default to the invalid-format label.
    if (msg.includes('Unprefixed')) throw new Error('sub_missing_namespace', { cause: e })
    throw new Error('sub_invalid_format', { cause: e })
  }

  return { provider: parsed.provider as SubProvider, id: parsed.id, raw: parsed.raw }
}

/** True when `sub` is a syntactically valid namespaced sub. */
export function isValidSub(sub: string): boolean {
  try {
    parseSub(sub)
    return true
  } catch {
    return false
  }
}

