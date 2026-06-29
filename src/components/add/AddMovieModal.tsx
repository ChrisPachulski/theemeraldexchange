import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { radarr, type MovieSearchResult } from '../../lib/api/radarr'
import { useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import { useLimits } from '../../lib/hooks/useLimits'
import { pickDefaultProfileId } from '../../lib/pickDefaultProfileId'
import {
  getReleaseView,
  setReleaseView,
  languageFromFilter,
  filterForLanguage,
  type AddLanguage,
} from '../../lib/releaseView'
import './AddSeriesModal.css'

type Props = {
  movie: MovieSearchResult | null
  onClose: () => void
  onAdded?: (title: string) => void
  onError?: (message: string) => void
}

export function AddMovieModal({ movie, onClose, onAdded, onError }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const profiles = useRadarrProfiles()
  const folders = useRadarrRootFolders()
  const qc = useQueryClient()
  const limits = useLimits()
  const maxGb = limits.data?.maxMovieGb ?? 10

  // Derive defaults at render rather than syncing via effect (see TV modal).
  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [searchOnAdd, setSearchOnAdd] = useState(true)
  // Language preference (defaults to English). Shared with the Advanced release
  // browser's filter via releaseView, so picking a language here is the same
  // setting the release browser uses. Not sent to Radarr (it has no add-time
  // language field) — it drives release filtering.
  const [language, setLanguage] = useState<AddLanguage>(() => languageFromFilter(getReleaseView('movie').filter))
  const chooseLanguage = (l: AddLanguage) => {
    setLanguage(l)
    setReleaseView('movie', { filter: filterForLanguage(l, getReleaseView('movie').filter) })
  }
  const [error, setError] = useState<string | null>(null)

  const profileId =
    profileChoice ??
    pickDefaultProfileId(profiles.data, (limits.data?.defaultProfileName ?? 'choose me').toLowerCase())
  const rootFolder = folderChoice ?? folders.data?.[0]?.path ?? null

  useEffect(() => {
    const d = dialogRef.current
    if (!movie || !d) return
    d.showModal()
    setError(null)
    return () => {
      if (d.open) d.close()
    }
  }, [movie])

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => radarr.addMovie(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['radarr', 'movie'] })
      // Do NOT invalidate ['suggestions'] here. That force-refetches the
      // whole strip (bypassing staleTime) and reshuffles the lineup the
      // instant the user adds a pick — the repeated "accept one and the
      // line resets, can't grab the next" complaint. The just-added movie
      // already drops out of the strip via the library filter
      // (trendingFiltered excludes libraryByTmdb, which the radarr
      // invalidation above refreshes), so the card vanishes WITHOUT
      // disturbing the rest. Claude's next prompt picks up the new library
      // state on the next explicit refresh.
    },
  })

  if (!movie) return null

  // Everyone now picks quality/folder/search, so wait on the dropdowns to
  // populate before enabling Add. The server validates a non-admin's choices
  // against the live profile/folder lists (and the size caps still apply).
  const canAdd = profileId !== null && rootFolder !== null && !mutation.isPending

  const handleAdd = () => {
    if (!canAdd) return
    setError(null)
    const body = {
      tmdbId: movie.tmdbId,
      title: movie.title,
      year: movie.year,
      qualityProfileId: profileId,
      rootFolderPath: rootFolder,
      monitored: true,
      addOptions: { searchForMovie: searchOnAdd },
    }
    mutation.mutate(body, {
      onSuccess: () => {
        onAdded?.(movie.title)
        onClose()
      },
      onError: (e) => {
        const msg = e instanceof Error ? e.message : String(e)
        setError(msg)
        onError?.(msg)
      },
    })
  }

  return (
    <dialog
      ref={dialogRef}
      className="add-series"
      onCancel={(e) => {
        if (mutation.isPending) e.preventDefault()
        else onClose()
      }}
      onClose={onClose}
    >
      <div className="add-series__panel">
        <span
          className="add-series__info"
          tabIndex={0}
          aria-label={`Movies are forced below the ${maxGb} GB threshold`}
          data-tooltip={`Movies are forced below the ${maxGb} GB threshold`}
        >
          i
        </span>
        <header className="add-series__header">
          <p className="add-series__eyebrow">[ Add to library ]</p>
          <h2 className="add-series__title">
            {movie.title}
            {movie.year && <span className="add-series__year"> {movie.year}</span>}
          </h2>
        </header>

        <div className="add-series__fields">
          <label className="add-series__field">
            <span className="add-series__label">Quality</span>
            <select
              className="add-series__select"
              value={profileId ?? ''}
              onChange={(e) => setProfileChoice(Number(e.target.value))}
              disabled={!profiles.data}
            >
              {profiles.data?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          <label className="add-series__field">
            <span className="add-series__label">Folder</span>
            <select
              className="add-series__select"
              value={rootFolder ?? ''}
              onChange={(e) => setFolderChoice(e.target.value)}
              disabled={!folders.data}
            >
              {folders.data?.map((f) => (
                <option key={f.id} value={f.path}>{f.path}</option>
              ))}
            </select>
          </label>

          <label className="add-series__field">
            <span className="add-series__label">Language</span>
            <select
              className="add-series__select"
              value={language}
              onChange={(e) => chooseLanguage(e.target.value as AddLanguage)}
            >
              <option value="english">English</option>
              <option value="any">Any language</option>
            </select>
          </label>

          <label className="add-series__field">
            <span className="add-series__label">Search</span>
            <select
              className="add-series__select"
              value={searchOnAdd ? 'now' : 'later'}
              onChange={(e) => setSearchOnAdd(e.target.value === 'now')}
            >
              <option value="now">Start search now</option>
              <option value="later">Just monitor</option>
            </select>
          </label>
        </div>

        {error && <p className="add-series__error" role="alert">{error}</p>}

        <div className="add-series__actions">
          <button
            type="button"
            className="add-series__cancel"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="add-series__primary"
            onClick={handleAdd}
            disabled={!canAdd}
            aria-busy={mutation.isPending}
          >
            {mutation.isPending ? 'Adding' : 'Add to library'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
