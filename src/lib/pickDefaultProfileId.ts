// Pick the household's curated profile by name (case/whitespace-insensitive)
// when present; otherwise fall back through the SAME preference chain the
// server uses in server/services/arrAdd.ts's pickProfile (prefer 1080p, then
// HD, then anything but 'Any', then the first profile) — duplicated here
// because the client bundle can't import server/services/arrAdd.ts, but MUST
// be kept in lockstep so the pre-filled dropdown matches what actually gets
// submitted (the Add modals always send qualityProfileId, so the server's
// own fallback never runs to correct a client-side mismatch).
export function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
  preferredName: string,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const norm = (n: string) => n.trim().toLowerCase()
  const target = norm(preferredName)
  const named = profiles.find((p) => norm(p.name) === target)
  if (named) return named.id
  const has1080p = profiles.find((p) => norm(p.name).includes('1080p'))
  if (has1080p) return has1080p.id
  const startsHd = profiles.find((p) => norm(p.name).startsWith('hd'))
  if (startsHd) return startsHd.id
  const notAny = profiles.find((p) => norm(p.name) !== 'any')
  if (notAny) return notAny.id
  return profiles[0].id
}
