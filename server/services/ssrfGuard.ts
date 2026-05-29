// SSRF containment for the IPTV segment/manifest proxy.
//
// The proxy fetches URLs (`rid`) that originate from upstream-provider-
// controlled HLS manifests. An absolute URL inside a manifest overrides our
// base (see iptvHlsRewrite.resolveUrl), so a malicious or compromised panel —
// or any redirect in the chain — can try to make the server fetch an internal
// address (cloud metadata at 169.254.169.254, container-internal services,
// loopback, the docker gateway) and stream the response back to the caller.
//
// We cannot pin to a single host: legitimate IPTV providers serve segments
// from separate public CDNs. So we apply the standard egress defense — require
// https, and refuse any host that is an IP literal in a private / loopback /
// link-local / reserved range, or an obviously-internal bare hostname.

// IPv4 dotted-quad → true when in a private / loopback / link-local / reserved
// / CGNAT range that must never be reachable from a public proxy.
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return true // malformed → treat as unsafe
  const [a, b] = o
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a >= 224) return true // multicast + reserved (224+)
  return false
}

// IPv6 (already unbracketed) → true for loopback, unspecified, unique-local
// (fc00::/7), link-local (fe80::/10), and IPv4-mapped private addresses.
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local fc00::/7
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
    return true // link-local fe80::/10
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (mapped) return isPrivateIPv4(mapped[1])
  return false
}

// A bare hostname with no dots is an internal/service name (e.g. `recommender`,
// `localhost`, the docker service DNS) — never a public CDN.
function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost') return true
  if (!h.includes('.')) return true // single-label → internal service DNS
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  return false
}

/**
 * True only when `url` is safe to proxy: https scheme and a host that is a
 * public address. Rejects http, IP literals in private/loopback/link-local/
 * reserved ranges, and bare internal hostnames.
 */
export function isPublicHttpsUpstream(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  // URL.hostname strips the IPv6 brackets for us.
  const host = url.hostname
  if (!host) return false
  if (isPrivateIPv4(host)) return false
  if (host.includes(':') && isPrivateIPv6(host)) return false
  if (isInternalHostname(host)) return false
  return true
}
