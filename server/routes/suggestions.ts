// Personalized library-aware suggestions for the Movies and TV
// Discover surfaces. On every refresh, this route:
//
//   1. Pulls the current library from Sonarr/Radarr.
//   2. Reads the persistent reject list.
//   3. Asks Claude (Haiku 4.5) for ranked recommendations grounded in
//      the household's actual taste, with rejections passed in-prompt
//      as "never suggest these."
//   4. Looks each title up in TMDB to enrich with id/poster/year.
//   5. Filters anything already in the library or on the reject list
//      (defense in depth — Claude is told but may slip).
//   6. Returns up to 20 items in TrendingItem shape so the existing
//      TrendingRow component is a drop-in consumer.
//
// Cold start: if the library has fewer than 3 items, falls back to
// TMDB's trending-this-week feed. Personalization is meaningless
// without a taste signal.
//
// Prompt caching: the system prompt + library + rejections are sent
// as one cached block (cache_control: ephemeral, 5-minute TTL). The
// per-request user message is short and varies — variety knob is
// temperature 0.8 plus prompt instruction to avoid identical lists.

import { Hono } from 'hono'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, type Env } from '../middleware/auth.js'
import { sonarrFetch } from '../services/sonarr.js'
import { radarrFetch } from '../services/radarr.js'
import { getRejections, addRejection } from '../services/rejections.js'
import { getUserFeedback, setLike } from '../services/userFeedback.js'
import { appendUsageEvent, computeCostCents } from '../services/usageLog.js'
import { env } from '../env.js'

const MODEL = 'claude-haiku-4-5'

// TMDB key snapshot read at module load. Mutable so tests can flip
// it without rebuilding the whole env. Production code reads through
// this indirection so tmdbLookup/tmdbTrending/tmdbTitleById all
// observe the same value.
let _tmdbKey: string | null = env.tmdbApiKey
export function _setTmdbApiKeyForTests(k: string | null): void {
  _tmdbKey = k
}

export const suggestions = new Hono<Env>()

suggestions.use('*', requireAuth)

const TMDB_BASE = 'https://api.themoviedb.org/3'
const COLD_START_THRESHOLD = 3
const TARGET_COUNT = 20
const CLAUDE_OVERFETCH = 30 // ask for 30 so we can drop a few during filtering

type SuggestionItem = {
  id: number
  title: string
  posterPath: string | null
  overview?: string
  year?: number
}

type ClaudePick = {
  title: string
  year?: number
  reason?: string
}

type SonarrSeries = { title: string; year?: number; tmdbId?: number; genres?: string[] }
type RadarrMovie = { title: string; year?: number; tmdbId?: number; genres?: string[] }

async function fetchSonarrLibrary(): Promise<SonarrSeries[]> {
  try {
    const r = await sonarrFetch('/api/v3/series', { method: 'GET' })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error('[suggestions] Sonarr /api/v3/series returned non-ok:', r.status, body.slice(0, 200))
      return []
    }
    const data = (await r.json()) as SonarrSeries[]
    if (!Array.isArray(data)) {
      console.error('[suggestions] Sonarr /api/v3/series returned non-array')
      return []
    }
    return data
  } catch (e) {
    console.error('[suggestions] Sonarr fetch threw:', e instanceof Error ? e.message : String(e))
    return []
  }
}

async function fetchRadarrLibrary(): Promise<RadarrMovie[]> {
  try {
    const r = await radarrFetch('/api/v3/movie', { method: 'GET' })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      console.error('[suggestions] Radarr /api/v3/movie returned non-ok:', r.status, body.slice(0, 200))
      return []
    }
    const data = (await r.json()) as RadarrMovie[]
    if (!Array.isArray(data)) {
      console.error('[suggestions] Radarr /api/v3/movie returned non-array')
      return []
    }
    return data
  } catch (e) {
    console.error('[suggestions] Radarr fetch threw:', e instanceof Error ? e.message : String(e))
    return []
  }
}

// Compact library line: "Title (Year) — genre1, genre2". Genres give
// Claude enough signal to taste-match without ballooning tokens.
function formatLibraryItem(it: { title: string; year?: number; genres?: string[] }): string {
  const yr = it.year ? ` (${it.year})` : ''
  const g = it.genres && it.genres.length > 0 ? ` — ${it.genres.slice(0, 3).join(', ')}` : ''
  return `${it.title}${yr}${g}`
}

// Stable system prompt — never changes per request, ideal cache prefix.
const SYSTEM_PROMPT = `You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- HARD RULE: Never recommend a title that appears in the household's library — not the same title, not a spinoff under the same name, not the same show with a different year. If you find yourself about to return a library title, stop and choose a different one. Duplicates render as broken UI for the user.
- HARD RULE: Never recommend a title that appears in the NEVER SUGGEST list, including stylistically near-identical entries.
- Mirror the genre distribution of the library. If 60% of the library is live-action drama, ~60% of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those tags are present; they're a slice, not the whole picture).
- Each recommendation should have a clear analog in the library — name the closest matches in your reasoning, even if you don't return the reason field.
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.

Output is consumed by code — return JSON only, no commentary.`

// Normalize a title for cross-source matching. Sonarr/Radarr's title
// and TMDB's title sometimes disagree on punctuation, articles, or
// suffixes. Lowercase, strip leading articles, drop non-alphanumeric.
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

// Base title — everything before the first subtitle separator
// (`:`, em-dash, en-dash, ` - `). Catches the very common case where
// Sonarr stores "A Knight of the Seven Kingdoms: The Hedge Knight"
// but TMDB / Claude refer to it as "A Knight of the Seven Kingdoms"
// (or vice versa). Empty when the title has no subtitle.
function normalizeTitleBase(t: string): string {
  const cut = t.split(/[:—–]|\s-\s/)[0]
  if (!cut || cut === t) return ''
  return normalizeTitle(cut)
}

// Build the matchable-title set from a library list. Includes both
// the full normalized title and the base (pre-subtitle) form when
// the title has a subtitle. Empty strings filtered out.
function titleSetFrom(entries: Array<{ title: string }>): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (!e.title) continue
    out.add(normalizeTitle(e.title))
    const base = normalizeTitleBase(e.title)
    if (base) out.add(base)
  }
  return out
}

// Does a pick title match anything in the set? Checks the pick's
// full and base forms against the set.
function titleMatches(pick: string, set: Set<string>): boolean {
  if (set.size === 0) return false
  if (set.has(normalizeTitle(pick))) return true
  const base = normalizeTitleBase(pick)
  if (base && set.has(base)) return true
  return false
}

// Render a list of {id, title} entries as prompt bullets. Untitled
// entries (legacy bare-id rows the backfill couldn't resolve — e.g.
// TMDB key missing or the id was retired) still appear so Claude
// knows the household has rejected/liked something with that id;
// they just can't taste-match without the name. Better honest signal
// than silent omission.
function renderEntryBullets(entries: Array<{ id: number; title: string }>): string {
  return entries
    .map((e) => (e.title ? `- ${e.title}` : `- [TMDB id ${e.id}]`))
    .join('\n')
}

// Hard cap on how many rejection bullets we send to Claude. Beyond
// this, the model starts treating the "NEVER SUGGEST" list as the
// dominant signal (and recommends weird obscure titles to dodge it,
// or worse, recommends library titles thinking they're safe). The
// id-set post-filter still defends against older rejections that
// don't make the cut. Prefer titled rows (most useful to the model);
// fall back to recent untitled rows.
const REJECTION_PROMPT_CAP = 75

function buildLibraryBlock(
  kind: 'movie' | 'tv',
  library: Array<{ title: string; year?: number; genres?: string[] }>,
  rejections: Array<{ id: number; title: string }>,
): string {
  const header = kind === 'movie' ? 'MOVIES' : 'TV SHOWS'
  const libLines = library.map(formatLibraryItem).join('\n')
  if (rejections.length === 0) {
    return `Household ${header} library (${library.length} titles):\n${libLines}`
  }
  // Show titled rows first (most useful taste signal), then fill the
  // remaining cap with untitled rows. The post-filter id-set covers
  // anything we don't bullet here.
  const titled = rejections.filter((r) => r.title)
  const untitled = rejections.filter((r) => !r.title)
  const promptRejections =
    titled.length >= REJECTION_PROMPT_CAP
      ? titled.slice(-REJECTION_PROMPT_CAP)
      : [...titled, ...untitled.slice(0, REJECTION_PROMPT_CAP - titled.length)]
  return (
    `Household ${header} library (${library.length} titles):\n${libLines}\n\n` +
    `NEVER SUGGEST — the household has explicitly rejected these (${promptRejections.length} of ${rejections.length} shown), ` +
    `and you should also avoid stylistically near matches:\n${renderEntryBullets(promptRejections)}`
  )
}

// Per-user "liked" block. Sent after the cached prefix so it can vary
// per caller without invalidating the household library cache. Same
// fallback rule as rejections — every liked id appears, untitled ones
// render as `[TMDB id N]`.
function buildUserLikesBlock(liked: Array<{ id: number; title: string }>): string {
  if (liked.length === 0) return ''
  return (
    `This user has explicitly LIKED — recommend more in this vein ` +
    `(positive taste signal):\n${renderEntryBullets(liked)}`
  )
}

// Resolve a TMDB id → canonical title via the direct /{kind}/{id}
// endpoint (no search, single round-trip). Used to backfill legacy
// rejection / liked rows that were saved before PR #65 introduced
// titled entries. Returns null when the key is missing, the id is
// dead, or TMDB rate-limited us — caller falls back to `[TMDB id N]`
// bullets in the prompt.
// Backfill knobs. With hundreds of legacy bare-id rows on the NAS,
// a one-shot Promise.all firing 500+ simultaneous TMDB requests blows
// past TMDB's rate limit AND can hang for minutes if any single call
// times out. Cap how many we resolve per call so the route stays
// responsive — the rest get fallback bullets this turn and upgrade
// across subsequent refreshes.
const BACKFILL_MAX_PER_CALL = 30
const TMDB_TIMEOUT_MS = 2500

async function tmdbTitleById(kind: 'movie' | 'tv', id: number): Promise<string | null> {
  if (!_tmdbKey) return null
  const url = new URL(`${TMDB_BASE}/${kind}/${id}`)
  url.searchParams.set('api_key', _tmdbKey)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
    if (!r.ok) return null
    const data = (await r.json()) as { title?: string; name?: string }
    return data.title || data.name || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Resolve at most BACKFILL_MAX_PER_CALL untitled ids per request.
// In-flight requests are bounded by the slice size; each has a hard
// 2.5s timeout. Total worst-case backfill cost ≈ 2.5s regardless of
// how many legacy rows are sitting on disk.
async function resolveTitles(
  kind: 'movie' | 'tv',
  needed: Array<{ id: number; title: string }>,
): Promise<Map<number, string>> {
  const slice = needed.slice(0, BACKFILL_MAX_PER_CALL)
  const titles = await Promise.all(slice.map((e) => tmdbTitleById(kind, e.id)))
  const out = new Map<number, string>()
  for (let i = 0; i < slice.length; i++) {
    const t = titles[i]
    if (t) out.set(slice[i].id, t)
  }
  return out
}

async function backfillRejectionTitles(
  kind: 'movie' | 'tv',
  entries: Array<{ id: number; title: string }>,
): Promise<Array<{ id: number; title: string }>> {
  const needed = entries.filter((e) => !e.title)
  if (needed.length === 0) return entries
  const updates = await resolveTitles(kind, needed)
  if (updates.size === 0) return entries
  // Persist in parallel — addRejection is queue-serialized internally.
  await Promise.all(
    Array.from(updates, ([id, title]) => addRejection(kind, id, title)),
  )
  return entries.map((e) => (updates.has(e.id) ? { ...e, title: updates.get(e.id)! } : e))
}

async function backfillLikedTitles(
  sub: string,
  kind: 'movie' | 'tv',
  entries: Array<{ id: number; title: string }>,
): Promise<Array<{ id: number; title: string }>> {
  const needed = entries.filter((e) => !e.title)
  if (needed.length === 0) return entries
  const updates = await resolveTitles(kind, needed)
  if (updates.size === 0) return entries
  await Promise.all(
    Array.from(updates, ([id, title]) => setLike(sub, kind, id, title)),
  )
  return entries.map((e) => (updates.has(e.id) ? { ...e, title: updates.get(e.id)! } : e))
}

async function tmdbLookup(
  kind: 'movie' | 'tv',
  title: string,
  year: number | undefined,
): Promise<SuggestionItem | null> {
  if (!_tmdbKey) return null
  const url = new URL(`${TMDB_BASE}/search/${kind}`)
  url.searchParams.set('api_key', _tmdbKey)
  url.searchParams.set('query', title)
  if (year) {
    url.searchParams.set(kind === 'movie' ? 'primary_release_year' : 'first_air_date_year', String(year))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS)
  let r: Response
  try {
    r = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
  if (!r.ok) return null
  const data = (await r.json()) as {
    results?: Array<{
      id: number
      title?: string
      name?: string
      poster_path: string | null
      overview?: string
      release_date?: string
      first_air_date?: string
    }>
  }
  const top = data.results?.[0]
  if (!top) return null
  const date = top.release_date || top.first_air_date || ''
  const parsedYear = date ? Number(date.slice(0, 4)) : undefined
  return {
    id: top.id,
    title: top.title || top.name || title,
    posterPath: top.poster_path,
    overview: top.overview,
    year: Number.isFinite(parsedYear) ? parsedYear : undefined,
  }
}

// TMDB returns 20 items per page on /trending/{type}/week. We paginate
// up to TRENDING_MAX_PAGES so that once a household has rejected the
// obvious choices, deeper-tail trending titles still surface instead
// of the strip going empty. The route still filters + slices to
// TARGET_COUNT at the end; this just gives the filter more raw fuel
// to work with. ~100 items is enough headroom in practice — TMDB's
// trending tail thins out quickly past page 5 anyway.
const TRENDING_MAX_PAGES = 5

async function tmdbTrending(kind: 'movie' | 'tv'): Promise<SuggestionItem[]> {
  if (!_tmdbKey) return []
  type TmdbRow = {
    id: number
    title?: string
    name?: string
    poster_path: string | null
    overview?: string
    release_date?: string
    first_air_date?: string
  }
  const all: TmdbRow[] = []
  for (let page = 1; page <= TRENDING_MAX_PAGES; page++) {
    const url = new URL(`${TMDB_BASE}/trending/${kind}/week`)
    url.searchParams.set('api_key', _tmdbKey)
    url.searchParams.set('page', String(page))
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) break
    const data = (await r.json()) as { results?: TmdbRow[] }
    const rows = data.results ?? []
    all.push(...rows)
    if (rows.length < 20) break // TMDB returned a short page, no more to fetch
  }
  return all.map((r) => {
    const date = r.release_date || r.first_air_date || ''
    const y = date ? Number(date.slice(0, 4)) : undefined
    return {
      id: r.id,
      title: r.title || r.name || '',
      posterPath: r.poster_path,
      overview: r.overview,
      year: Number.isFinite(y) ? y : undefined,
    }
  })
}

// Tool-use enforced output. Claude is forced to call this tool, which
// owns the exact shape of valid output. The tool definition is also
// where the model is reminded what NOT to submit — duplicate guidance
// to the system prompt because the tool's `description` is rendered
// in close proximity to the call site at inference time.
const SUBMIT_TOOL = {
  name: 'submit_recommendations',
  description:
    'Submit the ranked list of recommended titles. Each entry MUST be a real, released title that is NOT in the household library and NOT on the NEVER SUGGEST list. Do not include reasoning. Title + year only.',
  input_schema: {
    type: 'object' as const,
    properties: {
      picks: {
        type: 'array' as const,
        description: 'Ordered list, most-likely-loved first.',
        items: {
          type: 'object' as const,
          properties: {
            title: { type: 'string' as const },
            year: { type: 'integer' as const },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
    required: ['picks'],
    additionalProperties: false,
  },
}

type UsageBlock = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: { picks?: ClaudePick[] }
}

type ClaudeResponse = {
  toolUse: ToolUseBlock | null
  picks: ClaudePick[]
  usage: UsageBlock
}

function extractUsage(usage: Anthropic.Messages.Usage | undefined): UsageBlock {
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? undefined,
  }
}

function readToolUse(response: Anthropic.Messages.Message): ClaudeResponse {
  const usage = extractUsage(response.usage)
  const tu = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  )
  if (!tu) {
    console.error(
      '[suggestions] Claude returned no tool_use block; content types:',
      response.content.map((b) => b.type).join(','),
    )
    return { toolUse: null, picks: [], usage }
  }
  const input = tu.input as { picks?: ClaudePick[] }
  const picks = Array.isArray(input.picks) ? input.picks : []
  return {
    toolUse: { type: 'tool_use', id: tu.id, name: tu.name, input },
    picks,
    usage,
  }
}

// System message stack shared between initial call and retry. Library
// + rejections live in the cached prefix; user-likes vary per caller.
function systemStack(libraryBlock: string, userLikesBlock: string): Array<{
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}> {
  return [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: libraryBlock, cache_control: { type: 'ephemeral' } },
    ...(userLikesBlock ? [{ type: 'text' as const, text: userLikesBlock }] : []),
  ]
}

function userAsk(kind: 'movie' | 'tv', n: number): string {
  return `Recommend ${n} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household by calling submit_recommendations. Mirror the library's genre distribution — return a proportional mix across drama, comedy, action, animation, documentary, etc. Weight toward the user's explicitly LIKED titles when present. Strictly avoid the household's NEVER SUGGEST list and stylistically near matches.`
}

async function callClaudeInitial(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  userLikesBlock: string,
): Promise<ClaudeResponse> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0.4,
    system: systemStack(libraryBlock, userLikesBlock),
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: SUBMIT_TOOL.name },
    messages: [{ role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH) }],
  })
  return readToolUse(response)
}

async function callClaudeRetry(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  userLikesBlock: string,
  prior: ToolUseBlock,
  rejectedPicks: Array<{ title: string; reason: string }>,
  nNeeded: number,
): Promise<ClaudeResponse> {
  const rejectedSummary = rejectedPicks
    .slice(0, 15)
    .map((r) => `  - "${r.title}" — ${r.reason}`)
    .join('\n')
  const toolResultText =
    `${rejectedPicks.length} of your picks were rejected by the household-safety validator:\n${rejectedSummary}\n\n` +
    `Call submit_recommendations again with ${nNeeded} REPLACEMENT picks that don't conflict.`
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    temperature: 0.4,
    system: systemStack(libraryBlock, userLikesBlock),
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: SUBMIT_TOOL.name },
    messages: [
      { role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH) },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: prior.id, name: prior.name, input: prior.input },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: prior.id, content: toolResultText },
        ],
      },
    ],
  })
  return readToolUse(response)
}

function mergeUsage(a: UsageBlock, b: UsageBlock): UsageBlock {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheCreationInputTokens:
      (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) || undefined,
    cacheReadInputTokens:
      (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) || undefined,
  }
}

suggestions.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (type !== 'movie' && type !== 'tv') {
    return c.json({ error: 'invalid_type' }, 400)
  }

  // ?force=trending — client opts out of the Claude call to avoid
  // burning tokens (e.g., the household-level AI toggle is off).
  // Same downstream shape as the cold-start path so the SPA renders
  // identically.
  const force = c.req.query('force')

  // Library + rejections in parallel.
  const [library, rejections] = await Promise.all([
    type === 'movie' ? fetchRadarrLibrary() : fetchSonarrLibrary(),
    getRejections(),
  ])

  const kindRejections = type === 'movie' ? rejections.movie : rejections.tv
  const rejected = new Set(kindRejections.map((r) => r.id))
  const libraryTmdbIds = new Set(
    library.map((l) => l.tmdbId).filter((id): id is number => typeof id === 'number'),
  )
  // Secondary library guard: Sonarr/Radarr entries without a tmdbId
  // wouldn't match the id set, and titles often disagree across
  // sources on subtitles ("X: The Y" vs "X"). titleSetFrom() includes
  // both the full normalized title and the pre-subtitle base form.
  const libraryTitles = titleSetFrom(library)
  const rejectedTitles = titleSetFrom(kindRejections)

  // Single household-aware filter used by EVERY return path —
  // personalized picks, cold-start trending, force=trending, claude-
  // error fallback, and the auto-fallback when picks all dropped.
  // Without this, trending-source paths used id-only filtering and
  // any library entry lacking a tmdbId slipped through as a
  // duplicate (e.g. A Knight of the Seven Kingdoms).
  function filterHouseholdSafe(items: SuggestionItem[]): SuggestionItem[] {
    return items.filter(
      (i) =>
        !rejected.has(i.id) &&
        !libraryTmdbIds.has(i.id) &&
        !titleMatches(i.title, rejectedTitles) &&
        !titleMatches(i.title, libraryTitles),
    )
  }

  const diag = (extra: Record<string, unknown> = {}) => ({
    libraryCount: library.length,
    rejectionCount: kindRejections.length,
    ...extra,
  })

  if (force === 'trending') {
    const trending = filterHouseholdSafe(await tmdbTrending(type))
    return c.json({ source: 'trending', items: trending.slice(0, TARGET_COUNT), _diag: diag() })
  }

  // Cold start: library too small for meaningful taste signal.
  if (library.length < COLD_START_THRESHOLD) {
    console.warn('[suggestions] Cold-start path: library too small to filter', diag())
    const trending = filterHouseholdSafe(await tmdbTrending(type))
    return c.json({
      source: 'trending',
      items: trending.slice(0, TARGET_COUNT),
      _diag: diag({ reason: 'library_below_threshold' }),
    })
  }

  // BYO key model — caller must supply their Anthropic key in the
  // request header. 402 is the semantically correct response: "you
  // need to provide credentials/funds yourself before this resource
  // is available." Distinguishes from auth failure (401) and upstream
  // breakage (5xx).
  const userKey = (c.req.header('x-anthropic-api-key') ?? '').trim()
  if (!userKey || !userKey.startsWith('sk-ant-')) {
    return c.json({ error: 'api_key_required', hint: 'set your key in the user menu' }, 402)
  }

  const session = c.get('session')
  const userFeedback = await getUserFeedback(session.sub)
  const likedRaw = type === 'movie' ? userFeedback.movie.liked : userFeedback.tv.liked

  // Backfill missing titles on legacy entries so the Claude prompt
  // carries the *entire* rejection + likes context, not a silently
  // trimmed subset. Resolved titles are persisted so this cost is
  // one-time per entry. Backfill failures fall through to
  // `[TMDB id N]` bullets — Claude still sees the id is gated.
  const [kindRejectionsTitled, liked] = await Promise.all([
    backfillRejectionTitles(type, kindRejections),
    backfillLikedTitles(session.sub, type, likedRaw),
  ])

  const client = new Anthropic({ apiKey: userKey })
  const libraryBlock = buildLibraryBlock(type, library, kindRejectionsTitled)
  const userLikesBlock = buildUserLikesBlock(liked)

  // Tool-use enforced pipeline:
  //   1. Claude is forced to call submit_recommendations with N picks
  //   2. We TMDB-resolve + validate each pick (id + title against
  //      library and rejections)
  //   3. If we don't have TARGET_COUNT survivors, re-prompt Claude
  //      with a tool_result describing exactly which picks were
  //      rejected and why — single retry, bounded cost
  //   4. If still short, fill from TMDB trending (also filtered)
  //
  // The id-set post-filter remains as defense-in-depth but is no
  // longer load-bearing; Claude is told exactly what failed and
  // self-corrects on the retry pass.

  const validate = async (
    picks: ClaudePick[],
  ): Promise<{
    accepted: SuggestionItem[]
    rejectedForRetry: Array<{ title: string; reason: string }>
    counters: { lookupNulls: number; droppedAsDedupe: number; droppedAsRejected: number; droppedAsLibrary: number }
  }> => {
    const lookups = await Promise.all(
      picks.map((p) => tmdbLookup(type, p.title, p.year).catch(() => null)),
    )
    const accepted: SuggestionItem[] = []
    const rejectedForRetry: Array<{ title: string; reason: string }> = []
    const counters = { lookupNulls: 0, droppedAsDedupe: 0, droppedAsRejected: 0, droppedAsLibrary: 0 }
    const seen = new Set<number>()
    for (let i = 0; i < lookups.length; i++) {
      const r = lookups[i]
      const original = picks[i].title
      if (!r) {
        counters.lookupNulls++
        rejectedForRetry.push({ title: original, reason: 'TMDB lookup failed — title may be misspelled' })
        continue
      }
      if (seen.has(r.id)) {
        counters.droppedAsDedupe++
        rejectedForRetry.push({ title: original, reason: 'duplicate of an earlier pick in this batch' })
        continue
      }
      if (rejected.has(r.id) || titleMatches(r.title, rejectedTitles)) {
        counters.droppedAsRejected++
        rejectedForRetry.push({ title: original, reason: 'on the household NEVER SUGGEST list' })
        continue
      }
      if (libraryTmdbIds.has(r.id) || titleMatches(r.title, libraryTitles)) {
        counters.droppedAsLibrary++
        rejectedForRetry.push({ title: original, reason: 'already in the household library' })
        console.warn('[suggestions] library duplicate dropped:', {
          kind: type,
          pickId: r.id,
          pickTitle: r.title,
          normalized: { full: normalizeTitle(r.title), base: normalizeTitleBase(r.title) },
          matchedById: libraryTmdbIds.has(r.id),
          matchedByTitle: titleMatches(r.title, libraryTitles),
        })
        continue
      }
      seen.add(r.id)
      accepted.push(r)
      if (accepted.length >= TARGET_COUNT) break
    }
    return { accepted, rejectedForRetry, counters }
  }

  let totalUsage: UsageBlock = {}
  let r1: ClaudeResponse
  try {
    r1 = await callClaudeInitial(client, type, libraryBlock, userLikesBlock)
    totalUsage = mergeUsage(totalUsage, r1.usage)
  } catch (e) {
    console.error('[suggestions] Claude call failed:', e)
    await appendUsageEvent({
      sub: session.sub,
      username: session.username,
      type: 'claude_error',
      model: MODEL,
      kind: type,
      error: e instanceof Error ? e.message : String(e),
    })
    const trending = filterHouseholdSafe(await tmdbTrending(type))
    return c.json({
      source: 'trending_fallback',
      items: trending.slice(0, TARGET_COUNT),
      _diag: diag({ reason: 'claude_threw' }),
    })
  }

  const v1 = await validate(r1.picks)
  let accepted = v1.accepted
  let lastCounters = v1.counters
  let triedRetry = false

  // Retry once if Claude returned a tool_use but the survivors fell
  // short of the target. Skip the retry when accepted is healthy — no
  // point burning another call.
  if (r1.toolUse && accepted.length < TARGET_COUNT && v1.rejectedForRetry.length > 0) {
    triedRetry = true
    const nNeeded = Math.min(CLAUDE_OVERFETCH, TARGET_COUNT - accepted.length + 4)
    try {
      const r2 = await callClaudeRetry(
        client,
        type,
        libraryBlock,
        userLikesBlock,
        r1.toolUse,
        v1.rejectedForRetry,
        nNeeded,
      )
      totalUsage = mergeUsage(totalUsage, r2.usage)
      const v2 = await validate(r2.picks)
      lastCounters = v2.counters
      const acceptedIds = new Set(accepted.map((a) => a.id))
      for (const item of v2.accepted) {
        if (!acceptedIds.has(item.id)) {
          accepted.push(item)
          acceptedIds.add(item.id)
          if (accepted.length >= TARGET_COUNT) break
        }
      }
    } catch (e) {
      console.error('[suggestions] Claude retry failed:', e)
      // Fall through with whatever we accepted from r1.
    }
  }

  await appendUsageEvent({
    sub: session.sub,
    username: session.username,
    type: 'claude_call',
    model: MODEL,
    kind: type,
    ...totalUsage,
    costCents: computeCostCents(totalUsage),
  })

  // Still short of target after the retry — fill from trending so the
  // user always sees a full strip. Don't dedupe-overlap with accepted
  // (different ids by construction); only overlap-check via the
  // household-safe filter.
  if (accepted.length < TARGET_COUNT) {
    console.warn('[suggestions] Personalized picks short of target — filling from trending', {
      kind: type,
      sub: session.sub,
      libraryCount: library.length,
      rejectionCount: kindRejectionsTitled.length,
      titledRejections: kindRejectionsTitled.filter((r) => r.title).length,
      accepted: accepted.length,
      retryAttempted: triedRetry,
      lastCounters,
    })
    const fillIds = new Set(accepted.map((a) => a.id))
    const trending = filterHouseholdSafe(await tmdbTrending(type)).filter(
      (t) => !fillIds.has(t.id),
    )
    const filled = [...accepted, ...trending].slice(0, TARGET_COUNT)
    if (accepted.length === 0) {
      return c.json({
        source: 'personalized_empty_trending_fallback',
        items: filled,
        _diag: diag({ accepted: 0, retryAttempted: triedRetry, lastCounters }),
      })
    }
    return c.json({
      source: 'personalized_filled',
      items: filled,
      _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry, lastCounters }),
    })
  }

  return c.json({
    source: 'personalized',
    items: accepted.slice(0, TARGET_COUNT),
    _diag: diag({ accepted: accepted.length, retryAttempted: triedRetry }),
  })
})
