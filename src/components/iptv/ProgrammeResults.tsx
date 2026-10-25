import { useEffect, useMemo, useState } from 'react'
import type { EpgProgrammeDto, EpgSearchHit } from '../../lib/api/iptv'
import { EPG_SEARCH_MIN_CHARS, useIptvEpgSearch } from '../../lib/hooks/useIptvEpg'
import { groupAirings, type Airing } from './programmeAirings'

const PROGRAMME_SEARCH_HOURS = 24
const PROGRAMME_SEARCH_LIMIT = 60
const SEARCH_BUCKET_MS = 5 * 60_000

function isAiring(programme: EpgProgrammeDto, nowMs: number): boolean {
  return new Date(programme.start_utc).getTime() <= nowMs && new Date(programme.stop_utc).getTime() > nowMs
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

function formatDayClock(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

// Programme hits for the search box — the Apple Live -> Search "Programs" section.
// Searches title + description across every channel's schedule for the next 24h,
// so typing a team or show finds the channels carrying it. Airing hits tune the
// channel; upcoming ones open that channel's guide.
export function ProgrammeResults({
  q,
  onPlayLive,
  onShowInGuide,
  onHits,
}: {
  q: string
  onPlayLive: (hit: EpgSearchHit) => void
  onShowInGuide: (hit: EpgSearchHit) => void
  /** How many airings matched, null while the search runs. */
  onHits?: (count: number | null) => void
}) {
  // Ticks so LIVE badges age out; the 5-min bucket keeps the query key stable while
  // typing, and programmes that ended inside the bucket are dropped below.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const fromMs = Math.floor(nowMs / SEARCH_BUCKET_MS) * SEARCH_BUCKET_MS
  const fromIso = new Date(fromMs).toISOString()
  const toIso = new Date(fromMs + PROGRAMME_SEARCH_HOURS * 3600_000).toISOString()
  const search = useIptvEpgSearch(q, fromIso, toIso, PROGRAMME_SEARCH_LIMIT)
  const hits = useMemo(() => {
    const live: EpgSearchHit[] = []
    const later: EpgSearchHit[] = []
    for (const hit of search.data?.hits ?? []) {
      if (new Date(hit.programme.stop_utc).getTime() <= nowMs) continue
      ;(isAiring(hit.programme, nowMs) ? live : later).push(hit)
    }
    later.sort((a, b) => a.programme.start_utc.localeCompare(b.programme.start_utc))
    return [...live, ...later]
  }, [search.data, nowMs])

  const airings = useMemo(() => groupAirings(hits), [hits])
  const count = search.isFetching ? null : airings.length
  useEffect(() => onHits?.(count), [onHits, count])

  if (q.trim().length < EPG_SEARCH_MIN_CHARS) return null
  if (search.isLoading) return <p className="iptv-tab__status">Searching programs…</p>
  if (search.error) return <p className="iptv-tab__status iptv-tab__status--error">Program search failed.</p>
  if (airings.length === 0) return null

  const more = (search.data?.total ?? hits.length) > hits.length
  return (
    <section className="iptv-prog-results" aria-label="Matching programs">
      <h2 className="iptv-prog-results__head">
        Programs <span className="iptv-prog-results__count">{airings.length}</span>
        {hits.length > airings.length && (
          <span className="iptv-prog-results__feeds">
            <span aria-hidden="true">--</span> on {hits.length}
            {more ? '+' : ''} channels
          </span>
        )}
      </h2>
      <ul className="iptv-prog-results__list">
        {airings.map((airing) => (
          <AiringCard
            key={airing.key}
            airing={airing}
            live={isAiring(airing.hits[0].programme, nowMs)}
            onPlayLive={onPlayLive}
            onShowInGuide={onShowInGuide}
          />
        ))}
      </ul>
    </section>
  )
}

// Feeds shown before "+N more": a game is often on a channel's HD, SD, 4K and
// backup copies, and the first few cover the choice.
const AIRING_FEEDS_SHOWN = 3

function AiringCard({
  airing,
  live,
  onPlayLive,
  onShowInGuide,
}: {
  airing: Airing
  live: boolean
  onPlayLive: (hit: EpgSearchHit) => void
  onShowInGuide: (hit: EpgSearchHit) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? airing.hits : airing.hits.slice(0, AIRING_FEEDS_SHOWN)
  const hidden = airing.hits.length - shown.length
  return (
    <li className={'iptv-prog-card' + (live ? ' iptv-prog-card--live' : '')}>
      <p className="iptv-prog-card__when">
        {live ? (
          <>
            <span className="iptv-prog-card__live">Live</span> until {formatClock(airing.stopUtc)}
          </>
        ) : (
          formatDayClock(airing.startUtc)
        )}
        {airing.eyebrow && (
          <>
            {' '}
            <span className="iptv-prog-card__sep" aria-hidden="true">--</span> {airing.eyebrow}
          </>
        )}
      </p>
      <h3 className="iptv-prog-card__title">{airing.title}</h3>
      <div className="iptv-prog-card__feeds">
        {shown.map((hit) => (
          <button
            key={`${hit.streamId}#${hit.programIndex}`}
            type="button"
            className="iptv-prog-card__feed"
            onClick={() => (live ? onPlayLive(hit) : onShowInGuide(hit))}
            title={live ? `Watch ${hit.channelName} live` : `Show ${hit.channelName} in the guide`}
            aria-label={live ? `Watch ${hit.channelName} live` : `Show ${hit.channelName} in the guide`}
          >
            {hit.channelName}
          </button>
        ))}
        {hidden > 0 && (
          <button type="button" className="iptv-prog-card__more" onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        )}
      </div>
    </li>
  )
}
