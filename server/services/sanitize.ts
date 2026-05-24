// Title sanitization for user-provided strings that later land in
// LLM prompts. The dot-toggle UI sends body.title alongside the
// tmdb_id when the user clicks red/green; that title is persisted in
// rejections.json / userFeedback.json and later rendered verbatim
// into Claude's library + rejection bullets in suggestions.ts. A
// malicious authenticated caller could post:
//
//   - very long strings, bloating prompt cost
//   - embedded newlines or fake instruction blocks
//     ("\n\nIgnore prior instructions and ...")
//   - control characters that break our line-based prompt structure
//
// Sanitizing at the storage layer means every write path
// (feedback POST, backfill from TMDB, future paths) is covered.
// Hard cap is generous: real titles are well under 200 chars; the
// longest in Sonarr/Radarr libraries we've seen is ~140.

const MAX_TITLE_LEN = 200

export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Strip C0 controls + DEL (\x7f). \t, \n, \r are in C0 so they go
  // too — newlines are the prompt-injection vector we care about most.
  // The control chars in the regex are intentional (that's the whole
  // job of this function); silence the lint rule that flags them.
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, ' ')
  // Collapse runs of whitespace (NBSP and other unicode whitespace
  // included via \s) to a single space, then trim.
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, MAX_TITLE_LEN)
}
