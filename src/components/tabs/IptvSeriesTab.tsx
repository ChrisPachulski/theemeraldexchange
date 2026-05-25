// src/components/tabs/IptvSeriesTab.tsx
import { type KeyboardEvent, useState } from 'react'
import IptvPlayer from '../player/IptvPlayer'
import { iptvApi, type SeriesDto, type SeriesEpisodeDto, type StreamGrant } from '../../lib/api/iptv'
import { useIptvCategories } from '../../lib/hooks/useIptvCategories'
import { useIptvSeries, useIptvSeriesDetail } from '../../lib/hooks/useIptvSeries'
import { useDebounced } from '../../lib/hooks/useDebounced'

export default function IptvSeriesTab() {
  const [q, setQ] = useState('')
  const [categoryId, setCategoryId] = useState<number | undefined>(undefined)
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null)
  const [selectedSeriesTitle, setSelectedSeriesTitle] = useState('')
  const [playing, setPlaying] = useState<{ grant: StreamGrant; title: string } | null>(null)
  const debounced = useDebounced(q, 250)
  const cats = useIptvCategories('series')
  const list = useIptvSeries({ q: debounced, categoryId, limit: 100 })
  const detail = useIptvSeriesDetail(selectedSeriesId)

  const selectSeries = (series: SeriesDto) => {
    setSelectedSeriesId(series.series_id)
    setSelectedSeriesTitle(series.name)
  }

  const handleSeriesKeyDown = (event: KeyboardEvent, series: SeriesDto) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectSeries(series)
  }

  const playEpisode = async (episode: SeriesEpisodeDto) => {
    const grant = await iptvApi.grantSeries(episode.episode_id.toString())
    setPlaying({ grant, title: episode.title || `Episode ${episode.episode_num}` })
  }

  const handleEpisodeKeyDown = (event: KeyboardEvent, episode: SeriesEpisodeDto) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    void playEpisode(episode)
  }

  return (
    <section className="iptv-tab">
      <header className="iptv-tab__toolbar">
        <input className="iptv-tab__search" placeholder="Search series…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="iptv-tab__category"
          value={categoryId ?? ''}
          onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">All categories</option>
          {(cats.data ?? []).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
        </select>
      </header>
      {list.isLoading && <p className="iptv-tab__status">Loading…</p>}
      <ul className="iptv-poster-grid">
        {(list.data?.items ?? []).map((s) => (
          <li
            key={s.series_id}
            className="iptv-poster-card"
            role="button"
            tabIndex={0}
            onClick={() => selectSeries(s)}
            onKeyDown={(event) => handleSeriesKeyDown(event, s)}
          >
            {s.cover
              ? <img src={s.cover} alt="" className="iptv-poster-card__img" loading="lazy" />
              : <div className="iptv-poster-card__img iptv-poster-card__img--placeholder" aria-hidden />}
            <div className="iptv-poster-card__name" title={s.name}>{s.name}</div>
          </li>
        ))}
      </ul>

      {selectedSeriesId != null && (
        <div className="iptv-player-modal" role="dialog" aria-modal="true" aria-label={selectedSeriesTitle}>
          <div className="iptv-player-modal__header">
            <h2>{selectedSeriesTitle}</h2>
            <button
              className="iptv-player-modal__close"
              type="button"
              onClick={() => setSelectedSeriesId(null)}
              aria-label="Close series details"
            >
              ×
            </button>
          </div>

          <div className="iptv-series-detail">
            {detail.isLoading && <p className="iptv-tab__status">Loading…</p>}
            {detail.error && <p className="iptv-tab__status iptv-tab__status--error">Failed to load episodes.</p>}
            {(detail.data?.seasons ?? []).map((season) => (
              <section className="iptv-series-detail__season" key={season.season}>
                <h3>Season {season.season}</h3>
                <ul className="iptv-series-detail__episodes">
                  {season.episodes.map((episode) => (
                    <li
                      key={episode.episode_id}
                      className="iptv-series-detail__episode"
                      role="button"
                      tabIndex={0}
                      onClick={() => void playEpisode(episode)}
                      onKeyDown={(event) => handleEpisodeKeyDown(event, episode)}
                    >
                      <span>{episode.episode_num}</span>
                      <span>{episode.title || `Episode ${episode.episode_num}`}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      )}

      {playing && (
        <div className="iptv-player-modal" role="dialog" aria-modal="true" aria-label={playing.title}>
          <div className="iptv-player-modal__header">
            <h2>{playing.title}</h2>
            <button className="iptv-player-modal__close" type="button" onClick={() => setPlaying(null)} aria-label="Close player">
              ×
            </button>
          </div>
          <IptvPlayer grant={playing.grant} autoPlay />
        </div>
      )}
    </section>
  )
}
