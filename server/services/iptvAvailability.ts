// server/services/iptvAvailability.ts
//
// Stamps available_on:['iptv'] onto suggestion items whose TMDB id is
// linked to a live IPTV catalog title (asked of the iptv service). Pure:
// returns a new array, never mutates the input. Composes with
// tagLocalAvailability — an item can carry both 'iptv' and 'local'. A failed
// or slow lookup degrades gracefully (items come back untagged).

import type { Session } from '../session.js'
import { iptvLinkedTmdbIds } from './iptvService.js'
import type { SuggestionItem } from './suggestionsShared.js'
import { createLogger } from './logger.js'

const log = createLogger('suggestions')

// A suggestions response never waits long on a decoration.
const LOOKUP_TIMEOUT_MS = 2_000

export async function tagIptvAvailability(items: SuggestionItem[], session: Session): Promise<SuggestionItem[]> {
  const ids = Array.from(new Set(items.map((item) => item.id).filter((id) => Number.isInteger(id))))
  if (ids.length === 0) return items

  let linked: Set<number>
  try {
    linked = new Set(await iptvLinkedTmdbIds(session.sub, ids, LOOKUP_TIMEOUT_MS))
  } catch (err) {
    log.warn('iptv availability lookup failed', { err: err instanceof Error ? err.message : String(err) })
    return items
  }
  if (linked.size === 0) return items

  return items.map((item) => {
    if (!linked.has(item.id)) return item
    const available = item.available_on ? [...item.available_on] : []
    if (!available.includes('iptv')) available.push('iptv')
    return { ...item, available_on: available }
  })
}
