import { PosterShelf, type Card } from '../home/HomeShelves'
import { LoadingPulse } from '../feedback/LoadingPulse'
import { EmeraldMark } from '../atmosphere/EmeraldMark'
import './LibraryFilters.css'
import './LibraryBrowse.css'

export type BrowseRow = { key: string; label: string; cards: Card[] }

type Props = {
  loading: boolean
  rows: BrowseRow[]
  /** Genre chips; a pick opens the library grid filtered to it. */
  genres: string[]
  onGenre: (genre: string) => void
  emptyHint: string
}

// The library's Browse mode (Apple tvOS "Recommended"): poster shelves over
// what is downloaded, then genre chips into the filtered grid.
export function LibraryBrowse({ loading, rows, genres, onGenre, emptyHint }: Props) {
  if (loading) return <LoadingPulse>Loading library</LoadingPulse>
  if (rows.length === 0 && genres.length === 0) {
    return (
      <div className="tv-tab__empty">
        <EmeraldMark width={56} variant="single" />
        <p className="tv-tab__hint">{emptyHint}</p>
      </div>
    )
  }
  return (
    <div className="home__shelves lib-browse">
      {rows.map((r) => (
        <PosterShelf key={r.key} label={r.label} cards={r.cards} />
      ))}
      {genres.length > 0 && (
        <section className="trending" aria-label="Browse by genre">
          <div className="trending__header">
            <h3 className="trending__label">Browse by genre</h3>
          </div>
          <div className="lib-browse__genres">
            {genres.map((g) => (
              <button key={g} type="button" className="lib-filters__chip" onClick={() => onGenre(g)}>
                {g}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
