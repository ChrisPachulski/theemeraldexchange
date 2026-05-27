import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sonarr, type SeriesSearchResult } from '../../lib/api/sonarr'
import { useSonarrProfiles, useSonarrRootFolders } from '../../lib/hooks/useSonarrLibrary'
import { useAuth } from '../../lib/auth'
import { useLimits } from '../../lib/hooks/useLimits'
import './AddSeriesModal.css'

// Pick the household's curated profile by name (case-insensitive)
// when present; otherwise fall back to whatever Sonarr returns first.
// The name comes from /api/limits.defaultProfileName — see
// AddMovieModal for the full rationale. Hardcoding "choose me" used
// to silently disagree with the server whenever the operator set
// DEFAULT_PROFILE_NAME to something else.
function pickDefaultProfileId(
  profiles: { id: number; name: string }[] | undefined,
  preferredName: string,
): number | null {
  if (!profiles || profiles.length === 0) return null
  const preferred = profiles.find((p) => p.name.toLowerCase() === preferredName)
  return (preferred ?? profiles[0]).id
}

type Props = {
  series: SeriesSearchResult | null
  onClose: () => void
  onAdded?: (title: string) => void
  onError?: (message: string) => void
}

export function AddSeriesModal({ series, onClose, onAdded, onError }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const profiles = useSonarrProfiles()
  const folders = useSonarrRootFolders()
  const qc = useQueryClient()
  const { isAdmin } = useAuth()
  const limits = useLimits()
  const maxTvGb = limits.data?.maxTvGbPerEpisode ?? 5

  // userChoice = the value the user has explicitly selected. If they haven't,
  // we fall through to the first available value from the underlying service.
  // This avoids setState-in-effect (which causes cascading renders) by
  // deriving the effective value at render time.
  const [profileChoice, setProfileChoice] = useState<number | null>(null)
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  // Monitor selector value: "all" or "season:<n>". We use a string union
  // rather than a discriminated union here because <select> values are
  // stringly-typed anyway, and the parse on submit is trivial.
  const [monitorChoice, setMonitorChoice] = useState<{ seriesId: number; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Specials (seasonNumber 0) are intentionally excluded from the
  // user-facing dropdown — most households don't grab them and it keeps
  // the menu tidy. They stay unmonitored on add (since seasons[] tells
  // Sonarr which seasons to monitor explicitly).
  const showSeasons = (series?.seasons ?? [])
    .filter((s) => s.seasonNumber > 0)
    .map((s) => s.seasonNumber)
    .sort((a, b) => a - b)
  // Default = season 1 if it exists, else the lowest-numbered season,
  // else "all" if no season metadata (rare for unannounced shows).
  const defaultMonitor = showSeasons.includes(1)
    ? 'season:1'
    : showSeasons.length > 0
      ? `season:${showSeasons[0]}`
      : 'all'
  const currentMonitorChoice = monitorChoice
  const monitorChoiceValue =
    currentMonitorChoice && currentMonitorChoice.seriesId === series?.tvdbId
      ? currentMonitorChoice.value
      : null
  const chosenSeason = monitorChoiceValue?.startsWith('season:')
    ? Number(monitorChoiceValue.slice('season:'.length))
    : null
  const validMonitorChoice =
    monitorChoiceValue === 'all' || (chosenSeason !== null && showSeasons.includes(chosenSeason))
      ? monitorChoiceValue
      : null
  const monitor = validMonitorChoice ?? defaultMonitor

  const profileId =
    profileChoice ??
    pickDefaultProfileId(profiles.data, (limits.data?.defaultProfileName ?? 'choose me').toLowerCase())
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
      // Library changed — recompute Discover so the just-added show
      // doesn't reappear there and Claude's next prompt reflects the
      // new library state.
      qc.invalidateQueries({ queryKey: ['suggestions', 'tv'] })
    },
  })

  if (!series) return null

  // Admins wait on the profile + folder dropdowns to populate before
  // Add enables. Non-admins don't see those controls — the server
  // fills in policy from upstream defaults — so just gate on the
  // pending mutation instead of leaving the button mysteriously
  // disabled while hidden dropdowns load.
  const canAdd = isAdmin
    ? profileId !== null && rootFolder !== null && !mutation.isPending
    : !mutation.isPending

  const handleAdd = () => {
    if (!canAdd) return
    setError(null)

    // Non-admins can't configure quality / folder / monitor / seasons —
    // the server materializes those from upstream defaults + the
    // curated Choose Me profile (see materializeNonAdminSeriesBody).
    // Send only identifying fields so the modal payload visibly
    // matches the server contract; admin path still passes the full
    // policy body through verbatim.
    if (!isAdmin) {
      mutation.mutate(
        {
          tvdbId: series.tvdbId,
          // tmdbId is the recommender's catalog key — without it the
          // server-side conversion mirror (sonarr.ts → postFeedback
          // signal:'added') drops every TV add on the floor, leaving
          // the optimizer to learn from dot-feedback alone. Sonarr's
          // own add API uses tvdbId as primary; tmdbId is along for
          // the recommender ride. NON_ADMIN_SONARR_ALLOW lets it
          // through the materialize step.
          ...(series.tmdbId !== undefined ? { tmdbId: series.tmdbId } : {}),
          title: series.title,
        },
        {
          onSuccess: () => {
            onAdded?.(series.title)
            onClose()
          },
          onError: (e) => {
            const msg = e instanceof Error ? e.message : String(e)
            setError(msg)
            onError?.(msg)
          },
        },
      )
      return
    }

    // Translate the dropdown value into Sonarr's add-series shape:
    //   "all"        → addOptions.monitor:'all', leave seasons[] alone.
    //   "season:N"   → addOptions.monitor:'none', explicit seasons[]
    //                  with only N monitored. This is what stops Sonarr
    //                  from auto-monitoring everything when the show is
    //                  added with our chosen season selected.
    const isSingle = monitor.startsWith('season:')
    const targetSeason = isSingle ? Number(monitor.slice('season:'.length)) : null
    const seasons = isSingle && series.seasons
      ? series.seasons.map((s) => ({
          seasonNumber: s.seasonNumber,
          monitored: s.seasonNumber === targetSeason,
        }))
      : series.seasons

    const body = {
      tvdbId: series.tvdbId,
      // See non-admin branch above — tmdbId is the recommender's
      // catalog key; without it the conversion mirror is silently
      // dropped. Sonarr's add API ignores it.
      ...(series.tmdbId !== undefined ? { tmdbId: series.tmdbId } : {}),
      title: series.title,
      qualityProfileId: profileId,
      rootFolderPath: rootFolder,
      monitored: true,
      seasonFolder: true,
      addOptions: {
        monitor: isSingle ? 'none' : 'all',
        searchForMissingEpisodes: true,
      },
      seasons,
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
        <span
          className="add-series__info"
          tabIndex={0}
          aria-label={`Episodes are forced below the ${maxTvGb} GB threshold`}
          data-tooltip={`Episodes are forced below the ${maxTvGb} GB threshold`}
        >
          i
        </span>
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

          {isAdmin && (
            <label className="add-series__field">
              <span className="add-series__label">Monitor</span>
              <select
                className="add-series__select"
                value={monitor}
                onChange={(e) => setMonitorChoice({ seriesId: series.tvdbId, value: e.target.value })}
              >
                {/* All Seasons stays pinned at the top so it's always
                    visible in the menu, regardless of how many seasons
                    the show has. The default-selected option is Season 1
                    (or the lowest-numbered season if there is no S1). */}
                <option value="all">All seasons</option>
                {showSeasons.map((n) => (
                  <option key={n} value={`season:${n}`}>
                    Season {n}
                  </option>
                ))}
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
