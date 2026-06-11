// Typed row mappers for better-sqlite3 results in the IPTV modules.
//
// better-sqlite3 returns `unknown`-shaped objects and the IPTV code
// historically bridged that with bare `as` casts at every query site —
// dozens of unchecked assertions where a schema drift (renamed column,
// changed affinity) silently produced `undefined` fields at runtime
// instead of a type error. These mappers validate the shape AT the
// query boundary: a row that doesn't match its declared spec maps to
// null and the caller treats it like a missing row, which is exactly
// how the route layer already handles absent catalog entries.
//
// The spec language is deliberately tiny (string / number, nullable or
// not) because that is all SQLite hands back for these tables. Add
// kinds only when a real column needs one.

export type FieldKind = 'string' | 'number' | 'string|null' | 'number|null'

type FieldValue<K extends FieldKind> = K extends 'string'
  ? string
  : K extends 'number'
    ? number
    : K extends 'string|null'
      ? string | null
      : number | null

export type MappedRow<S extends Record<string, FieldKind>> = {
  [K in keyof S]: FieldValue<S[K]>
}

function fieldMatches(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof v === 'string'
    case 'number':
      return typeof v === 'number'
    case 'string|null':
      return v == null || typeof v === 'string'
    case 'number|null':
      return v == null || typeof v === 'number'
  }
}

/**
 * Build a mapper that validates an unknown row against `spec`.
 * Returns the typed row, or null when the row is missing or any field
 * fails its spec (absent nullable columns normalise to null).
 */
export function rowMapper<S extends Record<string, FieldKind>>(
  spec: S,
): (row: unknown) => MappedRow<S> | null {
  const entries = Object.entries(spec) as Array<[string, FieldKind]>
  return (row: unknown) => {
    if (typeof row !== 'object' || row === null) return null
    const source = row as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, kind] of entries) {
      const v = source[key]
      if (!fieldMatches(kind, v)) return null
      out[key] = v ?? null
    }
    return out as MappedRow<S>
  }
}

/** Map a .all() result, dropping rows that fail validation. */
export function mapRows<S extends Record<string, FieldKind>>(
  mapper: (row: unknown) => MappedRow<S> | null,
  rows: unknown[],
): Array<MappedRow<S>> {
  const out: Array<MappedRow<S>> = []
  for (const row of rows) {
    const mapped = mapper(row)
    if (mapped !== null) out.push(mapped)
  }
  return out
}

// ── Shared IPTV row shapes ──────────────────────────────────────────────────

/** channels row used by the M3U builder. */
export const channelM3uRow = rowMapper({
  stream_id: 'number',
  num: 'number',
  name: 'string',
  stream_icon: 'string|null',
  epg_channel_id: 'string|null',
  category_id: 'number|null',
})
export type ChannelM3uRow = NonNullable<ReturnType<typeof channelM3uRow>>

/** categories (kind='live') row used by the M3U builder. */
export const categoryNameRow = rowMapper({
  category_id: 'number',
  name: 'string',
})

/** iptv_playlist_tokens row. */
export const playlistTokenRow = rowMapper({
  jti: 'string',
  sub: 'string',
  device_name: 'string|null',
  issued_at: 'string',
  expires_at: 'string',
  revoked_at: 'string|null',
})
export type PlaylistTokenRow = NonNullable<ReturnType<typeof playlistTokenRow>>

/** Simple name lookups for the sessions widget. */
export const nameRow = rowMapper({ name: 'string' })

/** series_episodes title join for the sessions widget. */
export const episodeTitleRow = rowMapper({
  title: 'string|null',
  series_id: 'number',
})

/** channels catch-up capability lookup. */
export const channelArchiveRow = rowMapper({
  tv_archive: 'number',
  tv_archive_duration: 'number|null',
})

/** container_extension lookups for vod/series grants. */
export const containerExtensionRow = rowMapper({
  container_extension: 'string|null',
})
