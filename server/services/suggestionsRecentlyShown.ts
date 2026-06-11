// server/services/suggestionsRecentlyShown.ts
//
// Per-user rolling buffer of recently-served titles plus the volatile
// prompt block that asks Claude to rotate. In-memory only — soft
// signal, not load-bearing; resets on restart. A single instance per
// process is intentional (entries are keyed by (sub, kind)); tests
// clear it via _resetRecentlyShownForTests.

// Per-user rolling buffer of recently-served titles. The Claude prompt
// prefix (system + library + rejections) is cached, and at temperature
// 0.4–0.7 a deterministic prefix produces near-identical pick lists
// across refreshes — refreshes look like nothing changed, dot-clicks
// look unreactive, the strip "feels stuck." This buffer is injected
// as a volatile RECENTLY SHOWN block so the model rotates picks
// between calls without the household-cache prefix being invalidated.
//
// In-memory only — soft signal, not load-bearing. Resets on restart.
// Capped at RECENTLY_SHOWN_CAP per (sub, kind); newest items pushed
// to the front, older items LRU'd off the tail. Untitled items are
// dropped (a bare-id row is no signal to the model).
// Ship the full recently-shown buffer so Claude actually rotates
// instead of cycling through the same picks the user just saw. The
// language in buildRecentlyShownBlock keeps this a soft preference,
// not a hard NEVER — the previous 20-cap meant a 30-pick refresh
// could re-include the last batch the user just dismissed.
export const RECENTLY_SHOWN_CAP = 150
const RECENTLY_SHOWN_MAX_KEYS = 200
const recentlyShown = new Map<string, Array<{ id: number; title: string }>>()

function recentKey(sub: string, kind: 'movie' | 'tv'): string {
  return `${sub}:${kind}`
}

export function _resetRecentlyShownForTests(): void {
  recentlyShown.clear()
}

export function getRecentlyShown(sub: string, kind: 'movie' | 'tv'): Array<{ id: number; title: string }> {
  const key = recentKey(sub, kind)
  const items = recentlyShown.get(key)
  if (!items) return []
  recentlyShown.delete(key)
  recentlyShown.set(key, items)
  return items
}

export function recordShown(
  sub: string,
  kind: 'movie' | 'tv',
  items: Array<{ id: number; title: string }>,
): void {
  const key = recentKey(sub, kind)
  const prev = recentlyShown.get(key) ?? []
  const merged: Array<{ id: number; title: string }> = []
  const seen = new Set<number>()
  for (const item of items) {
    if (item.title && !seen.has(item.id)) {
      seen.add(item.id)
      merged.push({ id: item.id, title: item.title })
    }
  }
  for (const item of prev) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      merged.push(item)
      if (merged.length >= RECENTLY_SHOWN_CAP) break
    }
  }
  recentlyShown.set(key, merged.slice(0, RECENTLY_SHOWN_CAP))
  while (recentlyShown.size > RECENTLY_SHOWN_MAX_KEYS) {
    const oldest = recentlyShown.keys().next().value
    if (!oldest) break
    recentlyShown.delete(oldest)
  }
}

// The "rotate, don't repeat" instruction goes in the volatile portion
// of the system stack so it doesn't break the cache prefix. Empty
// when the user has no history yet (first call after restart).
export function buildRecentlyShownBlock(items: Array<{ id: number; title: string }>): string {
  if (items.length === 0) return ''
  const bullets = items.map((i) => `- ${i.title}`).join('\n')
  // Soft preference, not a NEVER. The earlier wording ("only repeat
  // if absolutely no comparable alternative exists") read to the
  // model as a hard exclusion and collapsed candidate pools after a
  // few refreshes.
  // Strengthened from "mild preference" to "strong preference" now
  // that the CANDIDATE POOL gives Claude 60 fresh candidates to choose
  // from — no risk of collapsing the candidate space. The pool ensures
  // there's always an alternative, so the repeated-if-best-fit escape
  // hatch is no longer needed as a guard.
  return (
    `RECENTLY SHOWN to this user (strong preference for fresh picks — avoid these titles; ` +
    `with the CANDIDATE POOL available there is always an alternative):\n${bullets}`
  )
}
