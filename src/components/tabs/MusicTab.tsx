import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { mediaApi, type MusicAlbum, type MusicArtist } from '../../lib/api/media'
import { countLabel, metaLine } from '../../lib/libraryFormat'
import { formatPlaybackTime } from '../media/playbackSession'
import { MediaPlayer } from '../media/MediaPlayer'
import { QueryStatus } from '../feedback/QueryStatus'

type RowProps = {
  title: string
  meta: string
  /** Album art: a URL, null for "no art" (placeholder tile), or undefined for
   *  rows that never carry art (artists, tracks). */
  art?: string | null
  onClick: () => void
}

function MusicRow({ title, meta, art, onClick }: RowProps) {
  return (
    <li>
      <button type="button" className="music-row" onClick={onClick}>
        {art !== undefined &&
          (art ? (
            <img className="music-row__art" src={art} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="music-row__art" aria-hidden="true" />
          ))}
        <span className="music-row__title">{title}</span>
        <span className="music-row__meta">{meta}</span>
      </button>
    </li>
  )
}

/**
 * The server's music library as Apple's MusicScreen drills it: Artists ->
 * Albums -> Tracks, tap a track to play it (audio always direct-plays).
 */
export function MusicTab() {
  const [artist, setArtist] = useState<MusicArtist | null>(null)
  const [album, setAlbum] = useState<MusicAlbum | null>(null)
  const [playing, setPlaying] = useState<{ id: number; title: string } | null>(null)
  const artistId = artist?.id ?? null
  const albumId = album?.id ?? null

  const artists = useQuery({
    queryKey: ['media', 'music', 'artists'],
    queryFn: ({ signal }) => mediaApi.musicArtists({ signal }),
    staleTime: 60_000,
  })
  const albums = useQuery({
    queryKey: ['media', 'music', 'albums', artistId ?? -1],
    queryFn: ({ signal }) => mediaApi.musicAlbums(artistId as number, { signal }),
    enabled: artistId != null,
    staleTime: 60_000,
  })
  const tracks = useQuery({
    queryKey: ['media', 'music', 'tracks', albumId ?? -1],
    queryFn: ({ signal }) => mediaApi.musicTracks(albumId as number, { signal }),
    enabled: albumId != null,
    staleTime: 60_000,
  })

  return (
    <section className="library-tab" aria-label="Music">
      <header className="music-header">
        {artist && (
          <nav className="music-crumbs" aria-label="Music library">
            <button
              type="button"
              onClick={() => {
                setArtist(null)
                setAlbum(null)
              }}
            >
              <span aria-hidden="true">‹ </span>Artists
            </button>
            {album && (
              <button type="button" onClick={() => setAlbum(null)}>
                <span aria-hidden="true">‹ </span>
                {artist.name}
              </button>
            )}
          </nav>
        )}
        <h2 className="music-header__title">{album?.title ?? artist?.name ?? 'Artists'}</h2>
      </header>

      {!artist && (
        <>
          <QueryStatus query={artists} what="artists" empty="No music in your library yet." />
          {!!artists.data?.length && (
            <ul className="music-list" aria-label="Artists">
              {artists.data.map((a) => (
                <MusicRow
                  key={a.id}
                  title={a.name}
                  meta={countLabel(a.albumCount, 'album')}
                  onClick={() => setArtist(a)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {artist && !album && (
        <>
          <QueryStatus query={albums} what="albums" empty="No albums." />
          {!!albums.data?.length && (
            <ul className="music-list" aria-label="Albums">
              {albums.data.map((al) => (
                <MusicRow
                  key={al.id}
                  title={al.title}
                  meta={metaLine([al.year != null ? String(al.year) : null, countLabel(al.trackCount, 'track')])}
                  art={al.artUrl}
                  onClick={() => setAlbum(al)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {album && (
        <>
          <QueryStatus query={tracks} what="tracks" empty="No tracks." />
          {!!tracks.data?.length && (
            <ul className="music-list" aria-label="Tracks">
              {tracks.data.map((t) => (
                <MusicRow
                  key={t.id}
                  title={t.title}
                  meta={metaLine([
                    t.trackNo != null ? `Track ${t.trackNo}` : null,
                    t.durationSecs != null ? formatPlaybackTime(t.durationSecs) : null,
                  ])}
                  // Artist — Title, as Apple titles the player (the dash is a
                  // field separator, not prose punctuation).
                  onClick={() => setPlaying({ id: t.id, title: `${album.artistName} — ${t.title}` })}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {playing && (
        <MediaPlayer
          key={playing.id}
          kind="track"
          id={playing.id}
          title={playing.title}
          onClose={() => setPlaying(null)}
        />
      )}
    </section>
  )
}
