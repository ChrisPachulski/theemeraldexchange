function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

/**
 * Rewrite an HLS manifest so every segment / sub-playlist reference points at
 * our signed segment-proxy endpoint instead of the upstream URL.
 *
 * SSRF containment (confused-deputy defense): the manifest body is
 * upstream-provider-controlled. An absolute URL on a line (or in a `URI=`
 * attribute) overrides the base in `resolveUrl`, so a malicious or compromised
 * IPTV panel could otherwise smuggle a link-local / internal host
 * (e.g. 169.254.169.254 or a container-internal service) into a segment rid,
 * which the server would then fetch and stream back. To prevent that, every
 * resolved URL is run through `isHostAllowed`; lines that resolve to a
 * disallowed host are passed through UNREWRITTEN (never signed into a segment
 * rid) so they can never become a server-side fetch target. The segment
 * handler enforces the same allowlist as a second layer.
 */
export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  signSegment: (upstreamUrl: string) => string,
  proxyPrefix: string,
  isHostAllowed: (resolvedUrl: string) => boolean,
): string {
  const rewritten = (upstream: string): string =>
    `${proxyPrefix}?u=${encodeURIComponent(signSegment(upstream))}`

  // Resolve + host-check, then rewrite. Off-host targets are returned
  // unchanged so they are never signed into a proxy URL.
  const rewriteResolved = (resolved: string, original: string): string =>
    isHostAllowed(resolved) ? rewritten(resolved) : original

  return manifest
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#') && /URI=(["'])[^"']+\1/.test(line)) {
        return line.replace(/URI=(["'])([^"']+)\1/g, (_match, quote: string, uri: string) => {
          const resolved = resolveUrl(baseUrl, uri)
          return isHostAllowed(resolved)
            ? `URI=${quote}${rewritten(resolved)}${quote}`
            : `URI=${quote}${uri}${quote}`
        })
      }
      if (!line || line.startsWith('#')) return line
      return rewriteResolved(resolveUrl(baseUrl, line), line)
    })
    .join('\n')
}
