import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { mediaApi, type YoutubeVideo } from '../../lib/api/media'
import { formatUploadDate, metaLine, youtubeShelves } from '../../lib/libraryFormat'
import { formatPlaybackTime } from '../media/playbackSession'
import { MediaPlayer } from '../media/MediaPlayer'
import { QueryStatus } from '../feedback/QueryStatus'

// A shelf's worth per row, newest first (Apple YouTubeScreen.shelfLimit).
const SHELF_LIMIT = 24

/**
 * The server's YouTube library (ytdl-sub channel folders): a "Latest" row plus
 * one row per channel, played in Emerald's own player as kind 'video'.
 */
export function YouTubeTab() {
  const [playing, setPlaying] = useState<YoutubeVideo | null>(null)
  const shelves = useQuery({
    queryKey: ['media', 'youtube', 'shelves'],
    queryFn: async ({ signal }) => {
      const [channels, latest] = await Promise.all([
        mediaApi.youtubeChannels({ signal }),
        mediaApi.youtubeVideos(null, SHELF_LIMIT, { signal }),
      ])
      // ponytail: one request per channel, as Apple does; a batched
      // per-channel endpoint is the upgrade if channel counts grow large.
      const perChannel = await Promise.all(
        channels.map((name) => mediaApi.youtubeVideos(name, SHELF_LIMIT, { signal })),
      )
      return youtubeShelves(latest, channels, perChannel)
    },
    staleTime: 60_000,
  })

  return (
    <section className="library-tab" aria-label="YouTube">
      <QueryStatus query={shelves} what="videos" empty="No YouTube videos in your library yet." />
      {shelves.data?.map((shelf) => (
        <section key={shelf.id} className="library-shelf" aria-label={shelf.title}>
          <h3 className="library-shelf__label">{shelf.title}</h3>
          <div className="library-shelf__row">
            {shelf.videos.map((v) => (
              <button
                key={v.id}
                type="button"
                className="library-shelf__card"
                title={v.title}
                onClick={() => setPlaying(v)}
              >
                {v.thumbUrl ? (
                  <img className="library-shelf__thumb" src={v.thumbUrl} alt="" loading="lazy" decoding="async" />
                ) : (
                  <div className="library-shelf__thumb library-shelf__thumb--fallback" aria-hidden="true">
                    {v.title.charAt(0)}
                  </div>
                )}
                <span className="library-shelf__title">{v.title}</span>
                <span className="library-shelf__meta">
                  {metaLine([
                    formatUploadDate(v.uploadDate),
                    v.durationSecs != null ? formatPlaybackTime(v.durationSecs) : null,
                  ])}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {playing && (
        <MediaPlayer
          key={playing.id}
          kind="video"
          id={playing.id}
          title={playing.title}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  )
}
