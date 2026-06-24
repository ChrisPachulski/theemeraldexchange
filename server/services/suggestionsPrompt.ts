// server/services/suggestionsPrompt.ts
//
// Claude side of the suggestions route: the cached system prompt, the
// per-request prompt block builders, the tool-use output contract, and
// the orchestration wrappers (hard deadline, transient-error retry,
// usage accounting). Prompt-shape decisions and their rationale live
// here; the route only assembles blocks and calls callClaudeInitial /
// callClaudeRetry.

import Anthropic from '@anthropic-ai/sdk'
import { sanitizeTitle } from './sanitize.js'
import type { ClaudePick, SuggestionItem } from './suggestionsShared.js'

export const MODEL = 'claude-haiku-4-5'

// Headroom for post-validation drops. With TARGET_COUNT=20 we need
// enough surplus that the routine library/lookup/dedupe shedding still
// leaves a full strip. 30 fits comfortably under max_tokens=4096.
// Previously 2048 which could truncate a 30-pick response with reasons
// (30 picks × ~80 tokens/pick = ~2400 output tokens, plus tool_use
// wrapper ~100 tokens = ~2500 total — right at the old 2048 ceiling).
// Raised to 4096 (iter 39) so reasons never cause truncation.
export const CLAUDE_OVERFETCH = 30

// Compact library line: "Title (Year) — genre1, genre2". Genres give
// Claude enough signal to taste-match without ballooning tokens.
function formatLibraryItem(it: { title: string; year?: number; genres?: string[] }): string {
  const yr = it.year ? ` (${it.year})` : ''
  const title = sanitizeTitle(it.title)
  const genres = it.genres?.map((g) => sanitizeTitle(g)).filter(Boolean).slice(0, 3) ?? []
  const g = genres.length > 0 ? ` — ${genres.join(', ')}` : ''
  return `${title}${yr}${g}`
}

// Stable system prompt — never changes per request, ideal cache prefix.
const SYSTEM_PROMPT = `You are a media taste-matching agent for a household media server. Given the household's library and an explicit "never suggest" list, return ranked recommendations that match their existing taste — same era, tone, genre clusters, directorial sensibilities, and adjacent recommendations from beloved titles.

Rules:
- HARD RULE: Never recommend a title in the household's library. Library titles are listed in full below — every one of them. A server-side validator filters library matches by id and by normalized title (including subtitle base form) before the user sees the response, so recommending a library title costs the household one slot of the count contract AND one paid output token for nothing. Reach further into your knowledge instead.
- HARD RULE: Never recommend a title in the NEVER SUGGEST list. The complete list is shipped below — not a sample. Same cost as library overlap: the validator drops it, the user sees a shorter strip, and the household paid for tokens that produced no value. Avoid stylistically-near matches too (close remakes, alternate-name re-releases, the "season 2 of an existing rejected show").
- Mirror the genre distribution of the library. If 60% of the library is live-action drama, ~60% of your recommendations should be live-action drama. Do NOT over-index on any single genre cluster (e.g. don't return all-Animation or all-Anime just because those tags are present; they're a slice, not the whole picture).
- Each recommendation should have a clear analog in the library — name the closest matches in your reasoning, even if you don't return the reason field.
- Prefer well-regarded, mainstream-adjacent titles. Critical reception and audience love are signals; obscurity for its own sake is not.
- Modest variety across calls is fine, but recommendations should land in the "obvious yes" zone for someone who already loves what's in the library.
- Real, released titles only. No imaginary or future-dated releases.
- Be exact with titles and years so they can be looked up in TMDB.
- COUNT CONTRACT: always fill the requested number of picks. A short list or empty array is a system failure; if you can't find perfect matches, return your best attempts. A downstream validator filters overlaps with the library/never-list, so borderline picks are welcome — never return fewer than asked.

Output is consumed by code — return JSON only, no commentary.`

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

// Ship the full rejection set in the cached prefix. The old 75-cap
// existed so the model wouldn't anchor on a long NEVER list — but in
// practice, hiding rejections from the model means it keeps proposing
// them, the post-filter drops them, the retry fires with the same
// blind spot, and the user pays Claude $ for picks that were always
// going to be filtered. Cached at 0.1x base rate this is essentially
// free; counter-anchoring is handled in the prompt language instead.

// Compute the top-N genre distribution from a library. Returned as
// `["Drama 38%", "Action 22%", …]` strings so it can be dropped
// straight into the prompt. Genres are denominator-weighted by total
// genre tags (not titles), so a title tagged Drama+Crime contributes
// to both buckets — that matches how taste actually works (you don't
// have to pick one).
// Tally how many times each genre tag appears across a library. A title
// tagged Drama+Crime contributes to both buckets.
function countGenres(library: Array<{ genres?: string[] }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of library) {
    for (const g of item.genres ?? []) {
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
  }
  return counts
}

export function computeGenreDistribution(
  library: Array<{ genres?: string[] }>,
  topN: number,
): string[] {
  const counts = countGenres(library)
  let total = 0
  for (const n of counts.values()) total += n
  if (total === 0) return []
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([g, n]) => `${g} ${Math.round((n / total) * 100)}%`)
}

export function buildLibraryBlock(
  kind: 'movie' | 'tv',
  library: Array<{ title: string; year?: number; genres?: string[] }>,
  rejections: Array<{ id: number; title: string }>,
): string {
  const header = kind === 'movie' ? 'MOVIES' : 'TV SHOWS'
  const libLines = library.map(formatLibraryItem).join('\n')
  // Concrete distribution beats abstract "mirror the genres". Sent
  // alongside the library so Claude has both the raw signal and the
  // pre-computed shape to match against.
  const distribution = computeGenreDistribution(library, 6)
  const distLine =
    distribution.length > 0
      ? `\n\nTARGET GENRE MIX (match these proportions across your picks): ${distribution.join(', ')}`
      : ''
  const libraryAndGenres =
    `Household ${header} library (${library.length} titles, do NOT suggest any of these):\n${libLines}${distLine}`
  if (rejections.length === 0) {
    return libraryAndGenres
  }
  // Ship every rejection. Titled rows first so the most useful
  // taste-signal bullets dominate the start of the block, untitled
  // rows after as `[TMDB id N]` fallbacks.
  const titled = rejections.filter((r) => r.title)
  const untitled = rejections.filter((r) => !r.title)
  const promptRejections = [...titled, ...untitled]
  // Rejections FIRST in the block — the most attended-to position
  // after the system prompt. Library follows as taste signal. Putting
  // rejections in their own labeled section (NEVER SUGGEST) ahead of
  // the library list makes the constraint structurally unmissable.
  return (
    `NEVER SUGGEST — the household has explicitly rejected every title below (${promptRejections.length} total). ` +
    `This is a hard contract: any recommendation matching this list will be silently dropped, the user will see a shorter strip, and the household's API budget will have paid for nothing. Every pick you submit MUST NOT appear here. Audit each pick against this list before calling the tool.\n` +
    `${renderEntryBullets(promptRejections)}\n\n` +
    libraryAndGenres
  )
}


// Per-user "liked" block. Sent after the cached prefix so it can vary
// per caller without invalidating the household library cache. Same
// fallback rule as rejections — every liked id appears, untitled ones
// render as `[TMDB id N]`.
//
// Recency weighting (Agent C #3): liked entries are stored oldest-first
// (push semantics). Reversing the array puts the most-recently-liked
// title at the top of the block — the highest-attention position after
// the label. Claude should up-weight the first bullets because they
// represent the user's freshest taste signal.
// The per-user liked store is unbounded (see services/userFeedback.ts —
// user signal is never silently dropped). This dormant BYO-key Claude
// path is the only consumer that pays per token for it, so bound the
// PROMPT here — most-recent N — rather than capping the store. Prod uses
// the local Python recommender and never reaches this code.
const CLAUDE_PROMPT_LIKES_CAP = 500

export function buildUserLikesBlock(liked: Array<{ id: number; title: string }>): string {
  if (liked.length === 0) return ''
  // Reverse so newest likes appear first (highest prompt attention), then
  // keep only the freshest CLAUDE_PROMPT_LIKES_CAP to bound prompt tokens.
  const recencyOrdered = [...liked].reverse().slice(0, CLAUDE_PROMPT_LIKES_CAP)
  return (
    `This user has explicitly LIKED the following — recommend more in this vein ` +
    `(strongest positive taste signal; items listed first are the MOST RECENTLY liked):\n${renderEntryBullets(recencyOrdered)}`
  )
}

// Volatile "priority taste signal" block — the top-N library titles
// most representative of the household's taste cluster, hoisted to a
// high-attention position right before the user message.
//
// Why this exists: the cached library block can be hundreds of titles
// long. LLM positional underweighting (well-documented in long-context
// settings) means titles deep in that list contribute little signal.
// By extracting the most-genre-typical titles into a short volatile
// block AFTER the cache, we give Claude a high-salience taste anchor
// that doesn't invalidate the cache (volatile block stays outside the
// cache_control region).
//
// Relevance score = sum of (1 / rank of each genre in the top distribution)
// per matched genre tag. Titles with multiple top-genre matches surface
// first. A title with one top-1 genre beats a title with three top-7
// genres. Limited to PRIORITY_TASTE_CAP titles; only fires when the
// library is larger than the cap (otherwise the cached block already
// fits in the attended zone).
const PRIORITY_TASTE_CAP = 30
const PRIORITY_TASTE_TRIGGER = 60 // below this size, full library fits — skip block

export function buildPriorityTasteBlock(
  library: Array<{ title: string; year?: number; genres?: string[] }>,
): string {
  if (library.length < PRIORITY_TASTE_TRIGGER) return ''
  // Compute genre rank (most-common = rank 1).
  const counts = countGenres(library)
  const rankedGenres = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([g], i) => [g, 1 / (i + 1)] as [string, number])
  const genreRank = new Map(rankedGenres)
  // Score each title by sum of genre weights.
  const scored = library.map((it) => {
    let score = 0
    for (const g of it.genres ?? []) {
      score += genreRank.get(g) ?? 0
    }
    return { item: it, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, PRIORITY_TASTE_CAP).map(({ item }) => item)
  if (top.length === 0) return ''
  const lines = top.map((it) => `- ${formatLibraryItem(it)}`).join('\n')
  return (
    `PRIORITY TASTE SIGNAL — the ${top.length} library titles that most strongly anchor the household's taste cluster ` +
    `(of ${library.length} total). Weight your recommendations toward titles a viewer of these would obviously want next:\n${lines}`
  )
}

// Format the candidate pool for the prompt. Numbered list so Claude
// can reference items by number if it wants; title + year so it can
// match back exactly. Description deliberately says "from this list"
// to make the constraint explicit.
export function buildCandidatePoolBlock(candidates: SuggestionItem[]): string {
  if (candidates.length === 0) return ''
  const lines = candidates
    .map((c, i) => {
      const yr = c.year ? ` (${c.year})` : ''
      return `${i + 1}. ${c.title}${yr}`
    })
    .join('\n')
  return (
    `CANDIDATE POOL — ${candidates.length} pre-vetted titles from your household's top genres (already screened: none are in your library or NEVER SUGGEST list). ` +
    `RANK these by how well they match the household's taste. Pick your recommendations PRIMARILY from this list — only reach outside it when the pool lacks good adjacents for a specific sub-genre the household clearly loves.\n\n` +
    lines
  )
}

// Tool-use enforced output. Claude is forced to call this tool, which
// owns the exact shape of valid output. The tool definition is also
// where the model is reminded what NOT to submit — duplicate guidance
// to the system prompt because the tool's `description` is rendered
// in close proximity to the call site at inference time.
const SUBMIT_TOOL = {
  name: 'submit_recommendations',
  description:
    'Submit the ranked list of recommended titles. Prefer titles from the CANDIDATE POOL when provided — they are already verified against the household library and NEVER SUGGEST list. Each entry MUST be a real, released title that is NOT in the household library and NOT on the NEVER SUGGEST list. For each pick, ALWAYS include a `reason`: a single short clause (≤90 chars) naming a specific library title or genre cluster — e.g. "neighbor of Severance", "for fans of Heat", "same prestige-crime tone as The Wire". The reason MUST reference something concrete in the household library or likes, NOT marketing copy. A reason is required for every pick that has a clear library analog (which is almost all of them — if you cannot ground a pick in the library, reconsider the pick).',
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
            reason: {
              type: 'string' as const,
              description:
                'Required one-clause grounding (≤90 chars) naming a specific library title or cluster — e.g. "neighbor of Breaking Bad" or "same director as their Heat". This is what makes the recommendation trustworthy and personalised rather than generic. Only omit if the pick has zero connection to the library (rare).',
            },
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

export type UsageBlock = {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: { picks?: ClaudePick[] }
}

// Track whether the last Claude call was truncated by max_tokens.
// Threaded through ClaudeResponse so the route handler can surface it
// in _diag without coupling readToolUse to the diag builder.
export type ClaudeResponse = {
  toolUse: ToolUseBlock | null
  picks: ClaudePick[]
  usage: UsageBlock
  truncated?: boolean
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
      'stop_reason:',
      response.stop_reason,
    )
    return { toolUse: null, picks: [], usage }
  }
  // When max_tokens cuts off mid-tool-use, the SDK still returns the
  // block but the JSON `input` is truncated — picks parses to an empty
  // array and the route silently returns nothing. Log loudly and surface
  // the truncated flag so _diag exposes it to the UI.
  const truncated = response.stop_reason === 'max_tokens'
  if (truncated) {
    console.error(
      '[suggestions] tool_use truncated by max_tokens — picks list will be incomplete or empty; raise max_tokens or shrink CLAUDE_OVERFETCH',
    )
  }
  const input = tu.input as { picks?: unknown }
  // Guard against malformed tool_use input: picks must be a non-null array
  // of objects with at least a string title field. Any other shape is treated
  // as an empty list so the retry/fill chain handles the shortage gracefully
  // rather than crashing on undefined pick.title access downstream.
  const rawPicks = Array.isArray(input.picks) ? input.picks : []
  const picks: ClaudePick[] = rawPicks
    .filter(
      (p): p is ClaudePick =>
        p !== null &&
        typeof p === 'object' &&
        typeof (p as { title?: unknown }).title === 'string' &&
        (p as ClaudePick).title.trim().length > 0,
    )
  if (rawPicks.length > 0 && picks.length < rawPicks.length) {
    console.warn(
      '[suggestions] readToolUse: filtered',
      rawPicks.length - picks.length,
      'malformed picks (missing/non-string title)',
    )
  }
  return {
    toolUse: { type: 'tool_use', id: tu.id, name: tu.name, input: input as { picks?: ClaudePick[] } },
    picks,
    usage,
    truncated,
  }
}

// System message stack shared between initial call and retry. Library
// + rejections live in the cached prefix; user-likes, recently-shown,
// and the candidate pool vary per caller and stay outside the cache.
// The candidate pool is placed last (highest attention) because it is
// the most immediately actionable context — Claude should read it right
// before being asked to pick.
function systemStack(
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  recentlyShownBlock: string,
  candidatePoolBlock: string,
): Array<{
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}> {
  return [
    { type: 'text', text: SYSTEM_PROMPT },
    { type: 'text', text: libraryBlock, cache_control: { type: 'ephemeral' } },
    // Volatile blocks AFTER the cache — high-attention position.
    // Priority taste signal first (the strongest positive signal),
    // then explicit likes, then recently-shown rotation, then the
    // candidate pool so Claude's final context before generating is
    // a numbered ranked-pool invitation.
    ...(priorityTasteBlock ? [{ type: 'text' as const, text: priorityTasteBlock }] : []),
    ...(userLikesBlock ? [{ type: 'text' as const, text: userLikesBlock }] : []),
    ...(recentlyShownBlock ? [{ type: 'text' as const, text: recentlyShownBlock }] : []),
    ...(candidatePoolBlock ? [{ type: 'text' as const, text: candidatePoolBlock }] : []),
  ]
}

// Per-request entropy seed. The system prefix is cached (cache_control:
// ephemeral on the library block) so temperature alone barely shifts
// the pick distribution across refreshes — the cached prefix dominates.
// Injecting an unguessable, per-call salt in the USER message (outside
// the cache) gives Claude something to pivot on, so refresh variety
// stops being a function of temperature alone. The salt has no semantic
// meaning, just entropy. Refresh variety (rubric dim 4).
export function refreshSalt(): string {
  // crypto.randomUUID is available on Node 20+ and modern browsers.
  // 16 hex chars (64 bits) — enough entropy to ensure each request
  // looks unique to the model's attention. Math.random fallback for
  // test environments without crypto.
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    // Two UUIDs sliced and concatenated give 16 unique hex chars.
    return g.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }
  const hi = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  const lo = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return hi + lo
}

function userAsk(
  kind: 'movie' | 'tv',
  n: number,
  salt: string,
  genreHint?: string,
): string {
  // Salt is placed at the BEGINNING of the user message so it's in the
  // highest-attention position — the model attends more to the start of
  // user content. This maximises the per-call entropy signal that breaks
  // cache-prefix determinism. (Iter 43: moved from end to start; length
  // raised from 8 to 16 hex chars for stronger entropy.)
  //
  // genreHint (iter 55): the top-2 genres from the library with percentages,
  // repeated in the volatile user message for high-attention positioning.
  // The same distribution already lives in the cached library block
  // (TARGET GENRE MIX line), but the volatile repetition here ensures
  // it's in the most recently attended context — the same intentional
  // redundancy used by the PRIORITY TASTE block. Only emitted when the
  // library has genre data (not cold-start).
  const genreClause = genreHint
    ? `\n\nGENRE FOCUS this call: ${genreHint}. The CANDIDATE POOL already reflects these genres; lean into them.`
    : ''
  return (
    `[Request salt: ${salt}]\n\n` +
    `Recommend exactly ${n} ${kind === 'movie' ? 'movies' : 'TV shows'} for this household by calling submit_recommendations. ` +
    `Use the household's library and likes as taste signal; aim for a proportional mix across the library's genres, weighted toward explicitly liked titles. ` +
    `\n\n` +
    `Before you submit, audit every pick: any title in the household library or the NEVER SUGGEST list must be replaced. A pick that matches either list is a wasted recommendation — the user pays for the token and sees a shorter strip. ` +
    `Return ${n} picks, never fewer; if obvious matches are exhausted, reach into deeper-cut adjacent recommendations rather than repeating from those lists.\n\n` +
    `ROTATION QUOTA: at least 30% of your picks this round should be titles that did NOT appear in the RECENTLY SHOWN block (when one is present). The cached prefix tends to make refreshes look identical — rotation is the only way the household sees new faces.` +
    genreClause
  )
}

// Higher temperature drives meaningfully different picks across
// refreshes (the cached prompt prefix would otherwise produce near-
// identical lists at low temp). 0.7 still keeps Claude in the
// "obvious yes" zone the system prompt asks for.
const CLAUDE_TEMPERATURE = 0.7

// Anthropic overload / service-error retry wrapper.
// HTTP 529 (Overloaded) and 503 (Service Unavailable) are documented
// Anthropic transient states — a single retry after a short fixed
// delay clears most of them without burning a second token budget.
// The Anthropic SDK throws `APIStatusError` with .status for these;
// other errors propagate immediately (401 bad key, 400 bad prompt, etc.).
// Max 2 attempts (1 retry), 3 s wait — bounded cost: worst case adds
// 3 s to a refresh that was already failing.
const ANTHROPIC_RETRY_STATUSES = new Set([529, 503])
const ANTHROPIC_RETRY_DELAY_MS = 3_000
const ANTHROPIC_RETRY_MAX = 2 // total attempts including the first
const CLAUDE_TIMEOUT_MS = 20_000

class ClaudeTimeoutError extends Error {
  constructor() {
    super(`Claude request exceeded ${CLAUDE_TIMEOUT_MS}ms`)
    this.name = 'ClaudeTimeoutError'
  }
}

async function withClaudeDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ClaudeTimeoutError())
    }, CLAUDE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([fn(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withAnthropicRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < ANTHROPIC_RETRY_MAX; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const status =
        typeof (e as { status?: unknown }).status === 'number'
          ? (e as { status: number }).status
          : undefined
      if (status !== undefined && ANTHROPIC_RETRY_STATUSES.has(status) && attempt < ANTHROPIC_RETRY_MAX - 1) {
        console.warn('[suggestions] Anthropic transient error', status, '— retrying after', ANTHROPIC_RETRY_DELAY_MS, 'ms')
        await new Promise((res) => setTimeout(res, ANTHROPIC_RETRY_DELAY_MS))
        continue
      }
      throw e
    }
  }
  throw lastErr
}

export async function callClaudeInitial(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  recentlyShownBlock: string,
  candidatePoolBlock: string,
  salt: string,
  genreHint?: string,
): Promise<ClaudeResponse> {
  const response = await withAnthropicRetry(() =>
    withClaudeDeadline((signal) =>
      client.messages.create({
        model: MODEL,
        // 4096 gives full headroom for 30 picks with per-pick reasons.
        // 30 picks × ~80 tokens each = ~2400 output tokens + envelope;
        // the prior 2048 ceiling could truncate mid-JSON when reasons
        // were present. Haiku 4.5 max_output is 8192; 4096 is safe.
        max_tokens: 4096,
        temperature: CLAUDE_TEMPERATURE,
        system: systemStack(libraryBlock, priorityTasteBlock, userLikesBlock, recentlyShownBlock, candidatePoolBlock),
        tools: [SUBMIT_TOOL],
        tool_choice: { type: 'tool', name: SUBMIT_TOOL.name, disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH, salt, genreHint) }],
      }, { timeout: CLAUDE_TIMEOUT_MS, signal }),
    ),
  )
  return readToolUse(response)
}

export async function callClaudeRetry(
  client: Anthropic,
  kind: 'movie' | 'tv',
  libraryBlock: string,
  priorityTasteBlock: string,
  userLikesBlock: string,
  candidatePoolBlock: string,
  prior: ToolUseBlock,
  rejectedPicks: Array<{ title: string; reason: string }>,
  nNeeded: number,
  salt: string,
  genreHint?: string,
): Promise<ClaudeResponse> {
  const rejectedSummary = rejectedPicks
    .slice(0, 15)
    .map((r) => `  - "${r.title}" — ${r.reason}`)
    .join('\n')
  const toolResultText =
    `${rejectedPicks.length} of your picks were rejected by the household-safety validator:\n${rejectedSummary}\n\n` +
    `Call submit_recommendations again with ${nNeeded} REPLACEMENT picks that don't conflict.`
  // Retry intentionally drops the recently-shown block from the system
  // stack: the retry is exactly when Claude needs more candidate
  // freedom, not the same rotation blocklist that just constrained the
  // initial call.
  const response = await withAnthropicRetry(() =>
    withClaudeDeadline((signal) =>
      client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        temperature: CLAUDE_TEMPERATURE,
        system: systemStack(libraryBlock, priorityTasteBlock, userLikesBlock, '', candidatePoolBlock),
        tools: [SUBMIT_TOOL],
        tool_choice: { type: 'tool', name: SUBMIT_TOOL.name, disable_parallel_tool_use: true },
        messages: [
          { role: 'user', content: userAsk(kind, CLAUDE_OVERFETCH, salt, genreHint) },
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
      }, { timeout: CLAUDE_TIMEOUT_MS, signal }),
    ),
  )
  return readToolUse(response)
}

export function mergeUsage(a: UsageBlock, b: UsageBlock): UsageBlock {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheCreationInputTokens:
      (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) || undefined,
    cacheReadInputTokens:
      (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) || undefined,
  }
}
