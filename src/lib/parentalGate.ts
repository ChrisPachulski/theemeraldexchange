// Client half of parental controls: the same certification gate the server
// applies at grant time (server/services/parentalRating.ts) and the Apple app
// applies to browse (EmeraldKit ParentalGate). The client only HIDES titles
// and sections; the server stays the authority.

/** A member's policy as GET /api/policy and the admin routes return it.
 *  Null `allowedSections` means every section is allowed. */
export type Policy = {
  maxContentRating: string | null
  allowedSections: { live: boolean; downloads: boolean; arr: boolean } | null
  kid: boolean
}

export const OPEN_POLICY: Policy = { maxContentRating: null, allowedSections: null, kid: false }

// Movie and TV ladders collapsed onto one 0-4 scale, so a movie cap and a TV
// certification compare directly. Keep in lockstep with the server's table.
const SEVERITY: Record<string, number> = {
  'G': 0, 'TV-Y': 0, 'TV-G': 0,
  'PG': 1, 'TV-Y7': 1, 'TV-PG': 1,
  'PG-13': 2, 'TV-14': 2,
  'R': 3, 'TV-MA': 3,
  'NC-17': 4,
}

const normalize = (s: string) => s.trim().toUpperCase()

/** Null cap allows everything. Under a cap, a certification the ladder can't
 *  place (unrated, "NR", missing) is blocked: fail closed. A cap outside the
 *  ladder can't be enforced and allows, as on the server. */
export function ratingAllowed(certification: string | null | undefined, cap: string | null): boolean {
  if (cap === null) return true
  const capSev = SEVERITY[normalize(cap)]
  if (capSev === undefined) return true
  const sev = SEVERITY[normalize(certification ?? '')]
  if (sev === undefined) return false
  return sev <= capSev
}

/** The cap a profile actually enforces. An explicit cap always wins; a kid
 *  profile without one defaults to PG (otherwise the kid flag would do
 *  nothing client-side, which is how the Apple app behaves too). */
export function effectiveCap(policy: Pick<Policy, 'maxContentRating' | 'kid'>): string | null {
  const explicit = policy.maxContentRating?.trim()
  if (explicit) return explicit
  return policy.kid ? 'PG' : null
}
