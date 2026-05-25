function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString()
  } catch {
    return ref
  }
}

export function rewriteManifest(
  manifest: string,
  baseUrl: string,
  signSegment: (upstreamUrl: string) => string,
  proxyPrefix: string,
): string {
  const rewritten = (upstream: string): string =>
    `${proxyPrefix}?u=${encodeURIComponent(signSegment(upstream))}`

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
