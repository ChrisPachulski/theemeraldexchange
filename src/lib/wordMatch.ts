/** A run-together query shorter than this matches word starts only, so "us"
 *  finds "US: CNN" but not "Music". */
const RUN_TOGETHER_MIN = 4

/** Lowercase alphanumeric words with diacritics folded ("Pokémon" is
 *  "pokemon"); apostrophes join ("What's" is "whats") and "&" is the word
 *  "and". */
export function words(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** How well `text` matches `query`, best first: 0 it is the query, 1 it
 *  starts with the query, 2 it otherwise matches; null no match. The same
 *  scale as the Apple app's WordMatch.rank and the gateway's Discover score. */
export function rankWords(text: string, query: string): number | null {
  const q = words(query)
  if (q.length === 0) return 2
  const t = words(text)
  if (t.length === q.length && t.every((w, i) => w === q[i])) return 0
  if (q.every((w, i) => t[i] === w)) return 1
  const joined = q.join('')
  const hit =
    q.every((w) => t.some((x) => x.startsWith(w))) ||
    ([...joined].length >= RUN_TOGETHER_MIN && t.join('').includes(joined))
  return hit ? 2 : null
}

/** Every query word starts a word of `text`, or the query run together sits
 *  inside `text` run together, so punctuation never decides a hit: "scooby
 *  doo" finds "Scooby-Doo!", "spiderman" finds "Spider-Man", "law and order"
 *  finds "Law & Order". The gateway's Discover search (arr/search.rs) and the
 *  live catalog search (iptv catalog.rs) match the same way. */
export function matchesWords(text: string, query: string): boolean {
  return rankWords(text, query) !== null
}
