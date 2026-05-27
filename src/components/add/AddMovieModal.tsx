import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { radarr, type MovieSearchResult } from '../../lib/api/radarr'
import { useRadarrProfiles, useRadarrRootFolders } from '../../lib/hooks/useRadarrLibrary'
import { useAuth } from '../../lib/auth'
import { useLimits } from '../../lib/hooks/useLimits'
import './AddSeriesModal.css'

// Pick the household's curated profile by name (case-insensitive)
// when present; otherwise fall back to whatever Radarr returns first.
// The name comes from /api/limits.defaultProfileName so the admin
// modal default agrees with what the server enforces for non-admin
// direct-POSTs (materializeNonAdminMovieBody). Pre-fix this was
// hard-coded to "choose me" client-side, which silently disagreed
// with the server whenever the operator set DEFAULT_PROFILE_NAME to
// something else.
function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
  preferredName: string,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const preferred = profiles.find((p) => p.name.toLowerCase() === preferredName)
  return (preferred ?? profiles[0]).id
}

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
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const maxGb = limits.data?.maxMovieGb ?? 10

  // Derive defaults at render rather than syncing via effect (see TV modal).
  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [searchOnAdd, setSearchOnAdd] = useState(true)
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
      // Library changed — recompute Discover so the just-added movie
      // doesn't reappear there and Claude's next prompt reflects the
      // new library state.
      qc.invalidateQueries({ queryKey: ['suggestions', 'movie'] })
    },
  })

  if (!movie) return null

  // Admins wait on the profile + folder dropdowns to populate before
  // Add enables (those are the inputs they're choosing from). Non-
  // admins don't see those controls, so gating on them would leave
  // the button mysteriously disabled — the server fills in policy
  // either way, so just gate on the pending mutation.
  const canAdd = isAdmin
    ? profileId !== null && rootFolder !== null && !mutation.isPending
    : !mutation.isPending

  const handleAdd = () => {
    if (!canAdd) return
    setError(null)
    // Non-admins can't configure quality / folder / monitor / search
    // mode — the server materializes those from upstream defaults +
    // the curated Choose Me profile (see materializeNonAdminMovieBody).
    // Send only identifying fields so the modal payload visibly
    // matches the server contract; admin path still passes the full
    // policy body through verbatim.
    const body = isAdmin
      ? {
          tmdbId: movie.tmdbId,
          title: movie.title,
          year: movie.year,
          qualityProfileId: profileId,
          rootFolderPath: rootFolder,
          monitored: true,
          addOptions: { searchForMovie: searchOnAdd },
        }
      : {
          tmdbId: movie.tmdbId,
          title: movie.title,
          year: movie.year,
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

          {isAdmin && (
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
          )}
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
