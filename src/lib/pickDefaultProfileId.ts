// Pick the household's curated profile by name (case-insensitive) when
// present; otherwise fall back to whatever the *arr returns first. The name
// comes from /api/limits.defaultProfileName so the admin add-modal default
// agrees with what the server enforces for non-admin direct-POSTs. Shared by
// AddMovieModal (Radarr) and AddSeriesModal (Sonarr) — pre-extraction each
// hard-coded its own copy, which could silently disagree with the server when
// the operator set DEFAULT_PROFILE_NAME to something else.
export function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
  preferredName: string,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const preferred = profiles.find((p) => p.name.toLowerCase() === preferredName)
  return (preferred ?? profiles[0]).id
}
