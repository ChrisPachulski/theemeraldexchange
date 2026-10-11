/* eslint-disable react-refresh/only-export-components -- creditIntent is
   exported for its unit test; fast-refresh is irrelevant for a pure function. */
import { useRef, useState } from 'react'
import { TMDB_IMAGE_BASE, type CastMember, type PersonCredit } from '../../lib/api/tmdb'
import { sonarr } from '../../lib/api/sonarr'
import { openIntent, type IntentRoute } from '../../lib/router'
import { useLimits } from '../../lib/hooks/useLimits'
import { useRatingGate } from '../../lib/hooks/usePolicy'
import { usePerson } from '../../lib/hooks/useTmdbExtras'
import { useDialogDismiss } from '../../lib/useDialogDismiss'

// A cast member's page over the detail (Apple PersonScreen): headshot, known
// for, biography and a filmography whose credits open in their own tab.

/** Where a credit opens, through the open-a-title intent (it also switches tabs
 *  for the other kind). A show resolves through Sonarr here so a failed `tmdb:`
 *  lookup can fall back to the title, which the intent can't carry, as Apple
 *  does. Null when nothing matched. */
export async function creditIntent(
  credit: Pick<PersonCredit, 'id' | 'media_type' | 'name' | 'title'>,
  lookup: (term: string) => Promise<Array<{ tvdbId: number }>> = sonarr.lookup,
): Promise<[IntentRoute, string] | null> {
  if (credit.media_type === 'movie') return ['movies', `tmdb:${credit.id}`]
  const title = credit.name ?? credit.title
  const hit = (await lookup(`tmdb:${credit.id}`))[0] ?? (title ? (await lookup(title))[0] : undefined)
  return hit ? ['tv', `tvdb:${hit.tvdbId}`] : null
}

function creditTitle(c: PersonCredit): string {
  return c.title ?? c.name ?? ''
}

export function PersonDialog({ member, onClose }: { member: CastMember | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const rendered = useDialogDismiss(member !== null, dialogRef)
  // Keep the last member through the exit transition.
  const [shown, setShown] = useState(member)
  const [opening, setOpening] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (member && member !== shown) {
    setShown(member)
    setError(null)
  }
  const person = usePerson(shown?.id ?? null)
  const limits = useLimits()
  // Credits carry no certification: withheld under a cap, like the strip.
  const ratingGate = useRatingGate()
  if (!rendered || !shown) return null

  const name = person.data?.name ?? shown.name
  const photo = person.data?.profile_path ?? shown.profile_path
  // Only kinds whose tab is on can open.
  const credits = ratingGate.capped
    ? []
    : (person.data?.cast ?? []).filter((c) =>
        c.media_type === 'movie' ? limits.data?.radarrEnabled !== false : limits.data?.sonarrEnabled !== false,
      )

  const open = async (c: PersonCredit) => {
    setOpening(c.id)
    setError(null)
    try {
      const intent = await creditIntent(c)
      if (!intent) {
        setError(`Couldn’t open ${creditTitle(c)}`)
        return
      }
      onClose()
      openIntent(...intent)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="detail"
      aria-labelledby="person-name"
      // React re-dispatches a nested dialog's close/cancel to the detail's own
      // handlers; stop them here or closing this page closes the detail too.
      onClose={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <article className="detail__panel">
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close person">
          {'×'}
        </button>
        <header className="detail__hero">
          {photo ? (
            <img className="detail__poster" src={`${TMDB_IMAGE_BASE}${photo}`} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="detail__poster detail__poster--fallback" aria-hidden="true">
              {name.charAt(0)}
            </div>
          )}
          <div className="detail__head">
            <p className="detail__eyebrow">{person.data?.known_for_department || 'Cast'}</p>
            <h2 id="person-name" className="detail__title">{name}</h2>
          </div>
        </header>
        <div className="detail__body">
          {person.isPending && <p className="detail__cast-empty">Loading…</p>}
          {(person.error || person.data === null) && (
            <p className="detail__cast-empty">Couldn’t load this person.</p>
          )}
          {person.data?.biography && (
            <section className="detail__section">
              <h3 className="detail__section-title">Biography</h3>
              <p className="detail__overview">{person.data.biography}</p>
            </section>
          )}
          {credits.length > 0 && (
            <section className="detail__section">
              <h3 className="detail__section-title">Filmography</h3>
              {error && <p className="detail__cast-empty" role="alert">{error}</p>}
              <ul className="detail__cast">
                {credits.map((c) => {
                  const year = (c.release_date ?? c.first_air_date ?? '').slice(0, 4)
                  return (
                    <li key={`${c.media_type}:${c.id}`} className="detail__cast-card">
                      <button
                        type="button"
                        className="detail__cast-link"
                        onClick={() => void open(c)}
                        disabled={opening !== null}
                        aria-busy={opening === c.id}
                      >
                        {c.poster_path ? (
                          <img
                            className="detail__cast-photo"
                            src={`${TMDB_IMAGE_BASE}${c.poster_path}`}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="detail__cast-photo detail__cast-photo--fallback" aria-hidden="true">
                            {creditTitle(c).charAt(0)}
                          </div>
                        )}
                        <p className="detail__cast-name">{creditTitle(c)}</p>
                        {(year || c.character) && <p className="detail__cast-role">{year || c.character}</p>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>
      </article>
    </dialog>
  )
}
