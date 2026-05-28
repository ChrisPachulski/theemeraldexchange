// Thin fetch client for the authed media-core proxy mounted at
// /api/media (server/routes/media.ts). Mirrors radarr.ts: credentialed
// fetch + throwApiError on non-ok. media-core serializes serde
// snake_case with no rename, so we normalize to camelCase at this
// boundary and the rest of src stays camelCase-consistent.

import { throwApiError } from './errors'
import { apiUrl } from './base'

const BASE = '/api/media'

async function get<T>(
  path: string,
  params?: Record<string, string | number | boolean>,
): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`, params), {
    credentials: 'include',
  })
  if (!res.ok) await throwApiError(res, `Media ${path}`)
  return res.json() as Promise<T>
}

async function post<T, B>(path: string, body: B): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!res.ok) await throwApiError(res, `Media ${path}`)
  return res.json() as Promise<T>
}

// ── Raw row shapes (snake_case, exactly as media-core emits) ──────────

type RawMovieRow = {
  id: number
  tmdb_id: number | null
  imdb_id: string | null
  title: string
  year: number | null
  added_at: string
  file_id: number
  overview?: string | null
  poster_path?: string | null
}

type RawShowRow = {
  id: number
  tmdb_id: number | null
  tvdb_id: number | null
  title: string
  year: number | null
  added_at: string
  imdb_id?: string | null
  overview?: string | null
  poster_path?: string | null
}

type RawEpisodeRow = {
  id: number
  show_id: number
  season: number
  episode: number
  title: string | null
  air_date: string | null
  file_id: number
}

// Some list routes carry `total`; the show-scoped /shows/{id}/episodes
// and /watch do NOT. Type it optional and default to items.length.
type RawListResponse<T> = { items: T[]; total?: number }

// ── Normalized (camelCase) types the SPA consumes ────────────────────

export type MediaMovie = {
  id: number
  tmdbId: number | null
  imdbId: string | null
  title: string
  year: number | null
  addedAt: string
  fileId: number
  overview: string | null
  posterPath: string | null
}

export type MediaShow = {
  id: number
  tmdbId: number | null
  tvdbId: number | null
  title: string
  year: number | null
  addedAt: string
  imdbId: string | null
  overview: string | null
  posterPath: string | null
}

export type MediaEpisode = {
  id: number
  showId: number
  season: number
  episode: number
  title: string | null
  airDate: string | null
  fileId: number
}

export type MediaListResponse<T> = { items: T[]; total: number }

export type ScanStarted = { status: 'started'; jobId?: string | number }
export type ScanRunning = { status: 'running' }
export type ScanResponse = ScanStarted | ScanRunning

// ── Normalizers ──────────────────────────────────────────────────────

function normMovie(r: RawMovieRow): MediaMovie {
  return {
    id: r.id,
    tmdbId: r.tmdb_id ?? null,
    imdbId: r.imdb_id ?? null,
    title: r.title,
    year: r.year ?? null,
    addedAt: r.added_at,
    fileId: r.file_id,
    overview: r.overview ?? null,
    posterPath: r.poster_path ?? null,
  }
}

function normShow(r: RawShowRow): MediaShow {
  return {
    id: r.id,
    tmdbId: r.tmdb_id ?? null,
    tvdbId: r.tvdb_id ?? null,
    title: r.title,
    year: r.year ?? null,
    addedAt: r.added_at,
    imdbId: r.imdb_id ?? null,
    overview: r.overview ?? null,
    posterPath: r.poster_path ?? null,
  }
}

function normEpisode(r: RawEpisodeRow): MediaEpisode {
  return {
    id: r.id,
    showId: r.show_id,
    season: r.season,
    episode: r.episode,
    title: r.title ?? null,
    airDate: r.air_date ?? null,
    fileId: r.file_id,
  }
}

function normList<R, T>(
  raw: RawListResponse<R>,
  map: (r: R) => T,
): MediaListResponse<T> {
  const items = (raw.items ?? []).map(map)
  // `total` is absent on the show-scoped episodes route — fall back to
  // the page length so callers never see undefined.
  return { items, total: raw.total ?? items.length }
}

// ── Poster resolver seam ─────────────────────────────────────────────
//
// media-core does not yet populate poster_path (NULL on every row until
// a TMDB re-scan lands). Returning undefined here makes MediaCard render
// its first-letter fallback. When enrichment ships we change ONLY this
// function — e.g. build a TMDB image URL from posterPath — not every
// call site.
export function posterFor(item: {
  posterPath?: string | null
}): string | undefined {
  if (!item.posterPath) return undefined
  // poster_path is a TMDB relative path like "/abc.jpg"; resolve to the
  // public TMDB image CDN at a card-appropriate width.
  return `https://image.tmdb.org/t/p/w342${item.posterPath}`
}

// ── Public API ───────────────────────────────────────────────────────

export const mediaApi = {
  movies: (q?: string) =>
    get<RawListResponse<RawMovieRow>>('/movies', q ? { q } : undefined).then(
      (raw) => normList(raw, normMovie),
    ),
  shows: (q?: string) =>
    get<RawListResponse<RawShowRow>>('/shows', q ? { q } : undefined).then(
      (raw) => normList(raw, normShow),
    ),
  episodes: (showId: number) =>
    get<RawListResponse<RawEpisodeRow>>(`/shows/${showId}/episodes`).then(
      (raw) => normList(raw, normEpisode),
    ),
  scan: () => post<ScanResponse, Record<string, never>>('/scan', {}),
}
