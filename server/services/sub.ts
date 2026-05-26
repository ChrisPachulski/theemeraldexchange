// Identity namespace helpers. Every `sub` value stored or transmitted
// by this server follows `<provider>:<provider_id>` per §8 of the
// M1.5 contract.
//
// parseSub is the single parse point used everywhere a `sub` is read
// or written. It is a provider-dispatching parser (not a single regex)
// so that provider-specific rules (e.g. no leading zeros for plex,
// Crockford Base32 for local, dot-separated SIWA format for apple) can
// be enforced independently and precisely.
//
// Grace window (§8.2):
//   M1 cookies and stream tokens carried unprefixed Plex user ids.
//   tryParseLegacySub normalises a bare numeric string → plex:<id>
//   in memory during the 30-day grace period post-D7. After that
//   window closes, callers should drop the legacy path and call
//   parseSub directly.
//
// Reference: §8.1 (provider patterns), §8.3 (parser pseudocode),
//            §13.1 (test vectors at tests/vectors/sub-namespace.json).

// D7 rollout timestamp (unix seconds). The grace window expires 30 days
// after this value. In production this should be set to the actual
// deploy time; for the D7 cut it is baked at build time. Tests can
// override by calling _setD7DeployedAt.
let D7_DEPLOYED_AT_SECS: number = Math.floor(Date.now() / 1000)

/** Override the D7 deploy timestamp. For tests only. */
export function _setD7DeployedAt(secs: number): void {
  D7_DEPLOYED_AT_SECS = secs
}

const GRACE_WINDOW_SECS = 30 * 24 * 60 * 60 // 30 days

/** Returns true during the M1 → M1.5 grace window. */
export function isGraceWindowOpen(): boolean {
  return Math.floor(Date.now() / 1000) < D7_DEPLOYED_AT_SECS + GRACE_WINDOW_SECS
}

export type SubProvider = 'plex' | 'local' | 'apple'

export type Sub = {
  provider: SubProvider
  id: string
  /** The canonical namespaced form: `<provider>:<id>` */
  raw: string
}

// Per §8.1:
//   plex:   positive integer, no leading zeros (0 itself is valid)
//   local:  Crockford Base32 ULID, 26 chars, uppercase
//   apple:  SIWA dot-separated subject  NNN.32hexchars.NNNN
//
// SIWA sub can mutate ONLY on Apple developer-account transfer
// (team-rescope). Document at §8.1 contract update time.
const PATTERNS: Record<SubProvider, RegExp> = {
  plex:  /^(0|[1-9][0-9]*)$/,
  local: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  // {6} prefix, 32 lowercase hex chars, {4} suffix — enforces exact lengths.
  // SIWA sub can mutate ONLY on Apple developer-account transfer (team-rescope).
  // Document at §8.1 contract update time.
  apple: /^[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}$/,
}

/**
 * Parse and validate a namespaced `sub` string.
 *
 * Throws `sub_missing_namespace` if no colon is present.
 * Throws `sub_invalid_format`    if the provider pattern does not match
 *                                or the provider is unrecognised.
 * Throws `sub_invalid_format`    if trimming was needed (leading/trailing
 *                                whitespace is not silently accepted).
 */
export function parseSub(s: string): Sub {
  const trimmed = s.trim()
  if (trimmed !== s) {
    throw new Error('sub_invalid_format')
  }

  const colon = s.indexOf(':')
  if (colon < 0) throw new Error('sub_missing_namespace')

  const provider = s.slice(0, colon) as SubProvider
  const id = s.slice(colon + 1)

  const pattern = PATTERNS[provider]
  if (!pattern) throw new Error('sub_invalid_format')
  if (!pattern.test(id)) throw new Error('sub_invalid_format')

  return { provider, id, raw: s }
}

/**
 * Attempt to normalise a legacy (M1) bare `sub` value to the prefixed
 * form during the 30-day grace window.
 *
 * Behaviour:
 *   - If `s` already contains a colon, delegate to parseSub (no
 *     double-prefixing).
 *   - If `s` looks like a bare Plex numeric id AND the grace window is
 *     open, prefix with `plex:` and parse.
 *   - Otherwise (grace window closed, or non-numeric bare value), return
 *     null so the caller can reject or clear the stale credential.
 *
 * This function is intentionally lenient during the grace window and
 * strict afterwards so that the rollback path is to simply stop calling
 * it.
 */
export function tryNormaliseLegacySub(s: string): Sub | null {
  if (s.includes(':')) {
    try {
      return parseSub(s)
    } catch {
      return null
    }
  }

  // Bare value — only handle during the grace window.
  if (!isGraceWindowOpen()) return null

  // Only numeric bare values are assumed to be legacy Plex ids.
  if (!/^(0|[1-9][0-9]*)$/.test(s)) return null

  try {
    return parseSub(`plex:${s}`)
  } catch {
    return null
  }
}
