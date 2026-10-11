import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiUrl } from '../api/base'
import { throwApiError } from '../api/errors'
import { useAuth } from '../auth'
import { OPEN_POLICY, effectiveCap, ratingAllowed, type Policy } from '../parentalGate'

// The signed-in member's own policy (GET /api/policy, set by an admin under
// Invites & members > Restrictions). Default-open while loading or when the
// read fails, like the Apple app: the server enforces sections and playback
// itself, so this only hides what would otherwise answer 403.
export function usePolicy(): Policy {
  // Server role, not the "view as user" preview: the server never restricts
  // an admin, so an admin's own policy is irrelevant and not fetched.
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const q = useQuery({
    queryKey: ['policy'],
    queryFn: async (): Promise<Policy> => {
      const r = await fetch(apiUrl('/api/policy'), { credentials: 'include' })
      if (!r.ok) await throwApiError(r, 'load policy')
      return (await r.json()) as Policy
    },
    enabled: !isAdmin,
    staleTime: 5 * 60 * 1000,
  })
  return isAdmin ? OPEN_POLICY : (q.data ?? OPEN_POLICY)
}

/** Sections this member may use. A section is denied only when the policy
 *  says so explicitly; whether the server runs it is useLimits' job. */
export function useSectionAccess() {
  const s = usePolicy().allowedSections
  return { live: s?.live !== false, downloads: s?.downloads !== false, arr: s?.arr !== false }
}

/** Browse filter for the member's rating cap. `capped` also means "withhold
 *  unrated catalogs" (suggestions, YouTube): they can't be checked. */
export function useRatingGate() {
  const cap = effectiveCap(usePolicy())
  return useMemo(
    () => ({
      capped: cap !== null,
      allows: (certification: string | null | undefined) => ratingAllowed(certification, cap),
    }),
    [cap],
  )
}
