// Format a cents amount as a "~$X.XX" cost string. Shared by the per-user
// API-key card (ApiKeySettings) and the admin usage roster (UsageDashboard).
// Sub-cent costs show 4 decimals so a fraction of a cent isn't rounded to $0.
export function fmtCost(cents: number): string {
  if (cents <= 0) return '$0.00'
  if (cents < 1) return `~$${(cents / 100).toFixed(4)}`
  return `~$${(cents / 100).toFixed(2)}`
}
