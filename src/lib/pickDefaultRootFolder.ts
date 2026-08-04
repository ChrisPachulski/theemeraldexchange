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
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
    const target = norm(configuredPath)
    const match = folders.find((f) => norm(f.path) === target)
    if (match) return match.path
  }
  return folders[0].path
}
