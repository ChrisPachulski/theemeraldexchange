function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

/**
 * The on-demand grant that a rewritten segment URL belongs to.
 *
 * BACKLOG b5fa8293: once an HLS VOD/series manifest is served, EVERY later
 * request (variant playlists AND every .ts) goes to `/api/iptv/stream/segment`,
 * which knows nothing about the grant — so the grant's concurrency slot went
 * idle and was swept mid-playback, silently defeating the cap. Tagging each
 * rewritten URL with its owner lets the segment route heartbeat that slot, the
 * same way the progressive byte routes and the remux seg route already do.
 *
 * The tag is NOT a capability: the segment route only ever heartbeats a session
 * belonging to the `sub` of the (signed) segment token, so a forged tag can at
 * most keep the caller's own session alive — which the caller can already do by
 * playing. It is still parsed through `parseSegmentOwner` before use.
 */
export interface SegmentOwner {
  kind: 'vod' | 'series'
  id: string
}

/** Query suffix (leading `&`) that carries `owner` on a segment proxy URL. */
export function segmentOwnerQuery(owner?: SegmentOwner | null): string {
  if (!owner) return ''
  return `&ok=${encodeURIComponent(owner.kind)}&oid=${encodeURIComponent(owner.id)}`
}

/** Inverse of `segmentOwnerQuery`; null unless both params are well-formed. */
export function parseSegmentOwner(
  kind: string | undefined,
  id: string | undefined,
): SegmentOwner | null {
  if (kind !== 'vod' && kind !== 'series') return null
  // Same shape the vod/series byte routes enforce on their own path params, so a
  // tag can never widen what reaches the concurrency tracker.
  if (!id || !/^[\w-]+$/.test(id)) return null
  return { kind, id }
}

export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  signSegment: (upstreamUrl: string) => string,
  proxyPrefix: string,
  owner?: SegmentOwner | null,
): string {
  const ownerQuery = segmentOwnerQuery(owner)
  const rewritten = (upstream: string): string =>
    `${proxyPrefix}?u=${encodeURIComponent(signSegment(upstream))}${ownerQuery}`

  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#') && /URI=(["'])[^"']+\1/.test(line)) {
        return line.replace(/URI=(["'])([^"']+)\1/g, (_match, quote: string, uri: string) =>
          `URI=${quote}${rewritten(resolveUrl(baseUrl, uri))}${quote}`)
      }
      if (!line || line.startsWith('#')) return line
      return rewritten(resolveUrl(baseUrl, line))
    })
    .join('\n')
}
