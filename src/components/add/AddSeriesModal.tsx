import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sonarr, type SeriesSearchResult } from '../../lib/api/sonarr'
import { useSonarrProfiles, useSonarrRootFolders } from '../../lib/hooks/useSonarrLibrary'
import { useAuth } from '../../lib/auth'
import './AddSeriesModal.css'

// Pick "Choose Me" by name when present; otherwise fall back to whatever
// Sonarr returns first. Mirrors the AddMovieModal default so a household
// running curated profiles doesn't get the alphabetical first one.
function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const preferred = profiles.find((p) => p.name.toLowerCase() === 'choose me')
  return (preferred ?? profiles[0]).id
}

type Props = {
  series: SeriesSearchResult | null
  onClose: () => void
  onAdded?: (title: string) => void
}

export function AddSeriesModal({ series, onClose, onAdded }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const profiles = useSonarrProfiles()
  const folders = useSonarrRootFolders()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()

  // userChoice = the value the user has explicitly selected. If they haven't,
  // we fall through to the first available value from the underlying service.
  // This avoids setState-in-effect (which causes cascading renders) by
  // deriving the effective value at render time.
  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [monitor, setMonitor] = useState<'all' | 'future' | 'firstSeason'>('all')
  const [error, setError] = useState<string | null>(null)

  const profileId = profileChoice ?? pickDefaultProfileId(profiles.data)
  const rootFolder = folderChoice ?? folders.data?.[0]?.path ?? null

  useEffect(() => {
    const d = dialogRef.current
    if (!series || !d) return
    d.showModal()
    setError(null)
    return () => {
      if (d.open) d.close()
    }
  }, [series])

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => sonarr.addSeries(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sonarr', 'series'] })
    },
  })

  if (!series) return null

  const canAdd = profileId !== null && rootFolder !== null && !mutation.isPending

  const handleAdd = () => {
    if (!canAdd) return
    setError(null)
    const body = {
      tvdbId: series.tvdbId,
      title: series.title,
      qualityProfileId: profileId,
      rootFolderPath: rootFolder,
      monitored: true,
      seasonFolder: true,
      addOptions: {
        monitor,
        searchForMissingEpisodes: true,
      },
      seasons: series.seasons,
    }
    mutation.mutate(body, {
      onSuccess: () => {
        onAdded?.(series.title)
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
        <header className="add-series__header">
          <p className="add-series__eyebrow">[ Add to library ]</p>
          <h2 className="add-series__title">
            {series.title}
            {series.year && <span className="add-series__year"> {series.year}</span>}
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
            <span className="add-series__label">Monitor</span>
            <select
              className="add-series__select"
              value={monitor}
              onChange={(e) => setMonitor(e.target.value as 'all' | 'future' | 'firstSeason')}
            >
              <option value="all">All seasons</option>
              <option value="future">Future seasons only</option>
              <option value="firstSeason">First season only</option>
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
