// Trailing-slash- and case-insensitive path comparison, matching
// server/services/arrAdd.ts's normalizePath. Exported so every client
// comparison against a rootFolderPath string uses the same rule instead of
// each call site re-deriving its own (a `===` re-implementation silently
// stops matching on the first `/data/x/` vs `/data/x` or case mismatch).
export function normalizeRootFolderPath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

// Pick the operator-curated root folder by exact path (after normalizing
// trailing slashes and case, same rule as server/services/arrAdd.ts's
// normalizePath) when it exists in the live folder list; otherwise fall
// back to the first folder Sonarr/Radarr returns. Duplicated from the
// server's configuredFolderPath preference (arrAdd.ts materializeNonAdminAdd)
// because the client always submits rootFolderPath, which bypasses the
// server's own fallback branch entirely.
export function pickDefaultRootFolder(
  folders: { id: number; path: string }[] | undefined,
  configuredPath: string | null | undefined,
): string | null {
  if (!folders || folders.length === 0) return null
  if (configuredPath) {
    const target = normalizeRootFolderPath(configuredPath)
    const match = folders.find((f) => normalizeRootFolderPath(f.path) === target)
    if (match) return match.path
  }
  return folders[0].path
}
