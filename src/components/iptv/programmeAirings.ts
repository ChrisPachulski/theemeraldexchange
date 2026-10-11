import type { EpgSearchHit } from '../../lib/api/iptv'

/** One airing a programme search matched, on every feed that carries it: a
 *  provider lists the same game on its HD, SD, 4K and backup copies of a
 *  channel, and each copy is its own search hit. */
export type Airing = {
  key: string
  /** The series or league label of a "NHL Hockey : Leafs at Avalanche" title. */
  eyebrow: string | null
  title: string
  startUtc: string
  stopUtc: string
  hits: EpgSearchHit[]
}

// EPG feeds prefix sports with " : " ("NHL Hockey : Leafs at Avalanche"); a
// colon without the leading space ("Star Trek: Discovery") is part of the title.
const LABELLED = /^(.{2,40}?)\s+:\s+(.+)$/

function splitTitle(raw: string | null | undefined): { eyebrow: string | null; title: string } {
  const title = raw?.trim() || '—'
  const m = title.match(LABELLED)
  return m ? { eyebrow: m[1], title: m[2] } : { eyebrow: null, title }
}

const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Hits grouped into airings (same start, stop and title, its label aside),
 *  in the order their first hit arrived. */
export function groupAirings(hits: ReadonlyArray<EpgSearchHit>): Airing[] {
  const airings = new Map<string, Airing>()
  for (const hit of hits) {
    const { eyebrow, title } = splitTitle(hit.programme.title)
    const start = Date.parse(hit.programme.start_utc)
    const stop = Date.parse(hit.programme.stop_utc)
    const key = `${start}|${stop}|${fold(title)}`
    const airing = airings.get(key)
    if (airing) {
      airing.hits.push(hit)
      airing.eyebrow ??= eyebrow
    } else {
      airings.set(key, {
        key,
        eyebrow,
        title,
        startUtc: hit.programme.start_utc,
        stopUtc: hit.programme.stop_utc,
        hits: [hit],
      })
    }
  }
  return [...airings.values()]
}
