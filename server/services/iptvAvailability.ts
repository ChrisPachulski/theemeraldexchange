// server/services/iptvAvailability.ts
//
// Stamps available_on:['iptv'] onto suggestion items whose TMDB id is
// linked to a live IPTV catalog title. Pure: returns a new array,
// never mutates the input. Composes with tagLocalAvailability — an
// item can carry both 'iptv' and 'local'. Read failures degrade
// gracefully (items come back untagged).

import { iptvDb } from './iptvDbSingleton.js'
import type { SuggestionItem } from './suggestionsShared.js'

export function tagIptvAvailability(items: SuggestionItem[]): SuggestionItem[] {
  const ids = Array.from(new Set(items.map((item) => item.id).filter((id) => Number.isInteger(id))))
  if (ids.length === 0) return items

  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = iptvDb().raw.prepare(`
      SELECT DISTINCT tmdb_id
      FROM iptv_title_link
      WHERE tmdb_id IN (${placeholders})
        AND removed_at IS NULL
    `).all(...ids) as Array<{ tmdb_id: number }>
    const linked = new Set(rows.map((row) => row.tmdb_id))
    if (linked.size === 0) return items

    return items.map((item) => {
      if (!linked.has(item.id)) return item
      const available = item.available_on ? [...item.available_on] : []
      if (!available.includes('iptv')) available.push('iptv')
      return { ...item, available_on: available }
    })
  } catch (err) {
    console.warn('[suggestions] iptv availability lookup failed:', err instanceof Error ? err.message : String(err))
    return items
  }
}
