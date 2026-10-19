/** Lowercase alphanumeric words; apostrophes join ("What's" is "whats"). */
export function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Every query word starts a word of `text`, or the query run together sits
 *  inside `text` run together, so punctuation never decides a hit: "scooby
 *  doo" finds "Scooby-Doo!", "spiderman" finds "Spider-Man". The gateway's
 *  Discover search (arr/search.rs) matches the same way. */
export function matchesWords(text: string, query: string): boolean {
  const q = words(query)
  if (q.length === 0) return true
  const t = words(text)
  return q.every((w) => t.some((x) => x.startsWith(w))) || t.join('').includes(q.join(''))
}
