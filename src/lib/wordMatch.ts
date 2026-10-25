/** A run-together query shorter than this matches word starts only, so "us"
 *  finds "US: CNN" but not "Music". */
const RUN_TOGETHER_MIN = 4

/** Lowercase alphanumeric words; apostrophes join ("What's" is "whats") and
 *  "&" is the word "and". */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Every query word starts a word of `text`, or the query run together sits
 *  inside `text` run together, so punctuation never decides a hit: "scooby
 *  doo" finds "Scooby-Doo!", "spiderman" finds "Spider-Man", "law and order"
 *  finds "Law & Order". The gateway's Discover search (arr/search.rs) and the
 *  live catalog search (iptv catalog.rs) match the same way. */
export function matchesWords(text: string, query: string): boolean {
  const q = words(query)
  if (q.length === 0) return true
  const t = words(text)
  const joined = q.join('')
  return (
    q.every((w) => t.some((x) => x.startsWith(w))) ||
    ([...joined].length >= RUN_TOGETHER_MIN && t.join('').includes(joined))
  )
}
