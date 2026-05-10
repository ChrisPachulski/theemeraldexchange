import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { radarr, type MovieSearchResult } from '../../lib/api/radarr'
import { useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import { useAuth } from '../../lib/auth'
import { useLimits } from '../../lib/hooks/useLimits'
import './AddSeriesModal.css'

// Pick "Choose Me" by name when present; otherwise fall back to whatever
// Radarr returns first. Lets the household run a curated default profile
// without hardcoding numeric ids that drift between installs.
function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const preferred = profiles.find((p) => p.name.toLowerCase() === 'choose me')
  return (preferred ?? profiles[0]).id
}

type Props = {
  movie: MovieSearchResult | null
  onClose: () => void
  onAdded?: (title: string) => void
}

export function AddMovieModal({ movie, onClose, onAdded }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const profiles = useRadarrProfiles()
  const folders = useRadarrRootFolders()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const maxGb = limits.data?.maxMovieGb ?? 10

  // Derive defaults at render rather than syncing via effect (see TV modal).
  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [searchOnAdd, setSearchOnAdd] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const profileId = profileChoice ?? pickDefaultProfileId(profiles.data)
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['radarr', 'movie'] }),
  })

  if (!movie) return null

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
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
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
          {isAdmin && (
            <>
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
            </>
          )}

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
