// Defensive JSON parsing for untrusted/external strings — chiefly the
// stdout of curl subprocesses we shell out to (Sonarr/Radarr add paths
// re-read the created body from `out`). A bare `JSON.parse(out)` THROWS
// on empty or malformed stdout, surfacing as an unhandled exception
// inside the route handler. These helpers turn every failure mode
// (empty, whitespace, malformed, or a non-object top-level value) into a
// quiet `null` so callers can degrade gracefully instead of 500ing.

/**
 * Parse `raw` as a JSON object. Returns the parsed value ONLY when it is
 * a plain JSON object (`{...}`); returns `null` for empty/whitespace-only
 * input, malformed JSON, the literal `null`, arrays, and bare primitives
 * (numbers, strings, booleans). Never throws.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  return parsed as Record<string, unknown>
}

/**
 * Read `obj[key]` as a string. Returns the value only when it is actually
 * a string; otherwise `undefined`.
 */
export function asString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * Read `obj[key]` as a finite number. Returns the value only when it is a
 * finite number (rejects `NaN`/`Infinity`, string-numbers, etc.);
 * otherwise `undefined`.
 */
export function asNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
