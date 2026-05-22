// HTTP client for the local recommender sidecar.
//
// The recommender lives in the same docker-compose stack (service name
// `recommender`, port 8000) and is reachable only inside the Docker
// network. In dev (`npm run dev`), it defaults to localhost:8000 if a
// developer has started it themselves; otherwise the call fails fast
// and the route handler falls back to TMDB trending.
//
// Schema mirrors recommender/app/schemas.py: keep them in sync.

import { env } from '../env.js'

export type RecommenderKind = 'movie' | 'tv'

export type RecommenderProvenance = 'personalized' | 'discover' | 'trending'

export type RecommenderLibraryItem = {
  tmdb_id: number
  title?: string
  source?: 'sonarr' | 'radarr'
}

export type RecommenderFeedback = {
  tmdb_id: number
  signal: 'like' | 'dislike' | 'reject'
}

export type RecommenderScoreRequest = {
  sub: string
  kind: RecommenderKind
  n: number
  exclude_recently_shown?: boolean
  library?: RecommenderLibraryItem[]
  feedback?: RecommenderFeedback[]
  household_rejections?: number[]
}

export type RecommenderScoredItem = {
  tmdb_id: number
  title: string | null
  year: number | null
  poster_path: string | null
  overview: string | null
  score: number
  provenance: RecommenderProvenance
  reason: string | null
}

export type RecommenderScoreResponse = {
  items: RecommenderScoredItem[]
  model_version: string
  recipe: string
  diag: Record<string, unknown>
}

const REQUEST_TIMEOUT_MS = 5_000

export class RecommenderError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'RecommenderError'
  }
}

export async function scoreOnce(req: RecommenderScoreRequest): Promise<RecommenderScoreResponse> {
  const url = `${env.recommenderUrl}/score`
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new RecommenderError(
        `recommender /score ${r.status}: ${body.slice(0, 200)}`,
        r.status,
      )
    }
    return (await r.json()) as RecommenderScoreResponse
  } catch (e) {
    if (e instanceof RecommenderError) throw e
    throw new RecommenderError(e instanceof Error ? e.message : String(e))
  } finally {
    clearTimeout(t)
  }
}

export async function postFeedback(ev: {
  sub: string
  kind: RecommenderKind
  tmdb_id: number
  signal: 'like' | 'dislike' | 'reject' | 'shown' | 'clicked' | 'added'
}): Promise<void> {
  await fetch(`${env.recommenderUrl}/events/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ev),
  }).catch(() => {/* fire-and-forget */})
}

export async function postRejection(ev: { kind: RecommenderKind; tmdb_id: number }): Promise<void> {
  await fetch(`${env.recommenderUrl}/events/rejection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ev),
  }).catch(() => {/* fire-and-forget */})
}

export async function postLibrarySync(
  kind: RecommenderKind,
  items: RecommenderLibraryItem[],
): Promise<void> {
  await fetch(`${env.recommenderUrl}/events/library/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, items }),
  }).catch(() => {/* fire-and-forget */})
}
