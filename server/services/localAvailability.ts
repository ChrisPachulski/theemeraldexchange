// server/services/localAvailability.ts
//
// Pure availability tagger that cross-references media-core's read-only
// media.db and stamps available_on:['local'] onto suggestion items the
// household already has on disk. This is the implementation the
// suggestions route runs in production; it lives here so it can be
// unit-tested without loading the full Hono route module.
//
// Mirrors tagIptvAvailability exactly in shape: gate on env.useMediaCore,
// read-only DB via lazy singleton, try/catch that returns items unchanged
// on any failure, and an additive available_on merge (an item can carry
// both 'iptv' and 'local'). Never mutates input.
//
// IMPORT RULE: media.db is plain better-sqlite3; no @emerald/contracts-napi
// is involved. Any future principal/JWE need MUST be obtained via
// server/services/contractsBinding.ts (createRequire), never a bare
// `import * as '@emerald/contracts-napi'`.

import { env } from '../env.js'
import { mediaLibraryDb } from './mediaLibraryDbSingleton.js'
// Same normalization on both sides of the fallback comparison — the
// shared helper is the single source of truth (this module used to
// carry a "kept in sync deliberately" copy).
import { normalizeTitle } from './suggestionsShared.js'

// Minimal structural type — kept local so this module does not depend on
// the route module. Matches the SuggestionItem fields we read/write.
export interface LocalTaggableItem {
  id: number
  title: string
  year?: number
  available_on?: string[]
}

/**
 * Return a NEW array with available_on stamped to include 'local' for any
 * item present in media-core's local library.
 *
 *  PRIMARY  — tmdb_id JOIN against movies|shows (durable seam; lights up
 *             automatically once media-core TMDB enrichment lands).
 *  FALLBACK — normalized title + EXACT year for items unmatched by id.
 *             Strict on purpose: media.db titles are currently dirty
 *             (reversed / quality-token junk), so we require an exact year
 *             match and skip empty/<5-char normalized titles to suppress
 *             false positives. Only movies/shows are queried — never the
 *             ~21k episode rows.
 */
export function tagLocalAvailability<T extends LocalTaggableItem>(
  items: T[],
  kind: 'movie' | 'tv',
): T[] {
  if (!env.useMediaCore) return items
  if (items.length === 0) return items

  const db = mediaLibraryDb()
  if (!db) return items // graceful degrade: media.db missing/unopenable

  const table = kind === 'tv' ? 'shows' : 'movies'

  try {
    // --- PRIMARY: tmdb_id join ---
    const ids = Array.from(
      new Set(items.map((item) => item.id).filter((id) => Number.isInteger(id))),
    )
    const matchedById = new Set<number>()
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      const rows = db.raw
        .prepare(`SELECT DISTINCT tmdb_id FROM ${table} WHERE tmdb_id IN (${placeholders})`)
        .all(...ids) as Array<{ tmdb_id: number | null }>
      for (const row of rows) {
        if (row.tmdb_id != null) matchedById.add(row.tmdb_id)
      }
    }

    // --- FALLBACK: normalized title + exact year ---
    const unmatched = items.filter(
      (item) => !matchedById.has(item.id) && typeof item.year === 'number',
    )
    const matchedByTitle = new Set<string>()
    if (unmatched.length > 0) {
      const localRows = db.raw
        .prepare(`SELECT title, year FROM ${table} WHERE year IS NOT NULL`)
        .all() as Array<{ title: string | null; year: number | null }>
      const localKeys = new Set<string>()
      for (const row of localRows) {
        if (!row.title || row.year == null) continue
        const norm = normalizeTitle(row.title)
        if (norm.length < 5) continue
        localKeys.add(`${norm}|${row.year}`)
      }
      if (localKeys.size > 0) {
        for (const item of unmatched) {
          const norm = normalizeTitle(item.title)
          if (norm.length < 5) continue
          if (localKeys.has(`${norm}|${item.year}`)) {
            matchedByTitle.add(`${item.id}::${item.title}::${item.year}`)
          }
        }
      }
    }

    if (matchedById.size === 0 && matchedByTitle.size === 0) return items

    return items.map((item) => {
      const hit =
        matchedById.has(item.id) ||
        matchedByTitle.has(`${item.id}::${item.title}::${item.year}`)
      if (!hit) return item
      const available = item.available_on ? [...item.available_on] : []
      if (!available.includes('local')) available.push('local')
      // Spread preserves every field of the original item; the cast keeps
      // the generic return type (T[]) since we only ever add available_on.
      return { ...item, available_on: available } as T
    })
  } catch (err) {
    console.warn(
      '[suggestions] local availability lookup failed:',
      err instanceof Error ? err.message : String(err),
    )
    return items
  }
}
