// Trailing-slash- and case-insensitive path comparison, matching the
// gateway's normalize_path (crates/gateway/src/arr/shared.rs). Exported so every client
// comparison against a rootFolderPath string uses the same rule instead of
// each call site re-deriving its own (a `===` re-implementation silently
// stops matching on the first `/data/x/` vs `/data/x` or case mismatch).
export function normalizeRootFolderPath(p: string): string {
  return p.replace(/[\\/]+$/, '').toLowerCase()
}

// Pick the operator-curated root folder by exact path (after normalizing
// trailing slashes and case, the gateway's normalize_path rule) when it exists
// in the live folder list; otherwise fall back to the first folder
// Sonarr/Radarr returns. The client always submits rootFolderPath, which
// bypasses the server's own default; tests/vectors/arr-add-defaults.json
// holds both sides to the same cases.
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
