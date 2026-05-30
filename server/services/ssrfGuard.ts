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
 *
 * NOTE: this is a STRING-only check. A public DNS name that *resolves* to a
 * private address (DNS rebinding) passes here — callers MUST additionally
 * resolve-and-validate the host's IPs (see `assertResolvesPublic`) and route
 * egress through `guardedFetch`, which re-runs both checks on every redirect
 * hop. Keep this function for the cheap up-front reject; never rely on it
 * alone before a `fetch()`.
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

import { lookup as nodeDnsLookup } from 'node:dns/promises'

/** Minimal shape of dns.promises.lookup(host, { all: true }). */
type LookupAll = (host: string) => Promise<Array<{ address: string }>>

// Indirection so tests can supply a deterministic resolver instead of doing
// real DNS (which would make resolve-and-validate flaky and network-bound).
let lookupAll: LookupAll = (host) => nodeDnsLookup(host, { all: true })

/** TEST-ONLY: override the DNS resolver used by assertResolvesPublic. */
export function __setSsrfLookupForTests(fn: LookupAll | null): void {
  lookupAll = fn ?? ((host) => nodeDnsLookup(host, { all: true }))
}

/** True when a resolved literal address (IPv4 or IPv6) is private/reserved. */
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) return isPrivateIPv6(address)
  return isPrivateIPv4(address)
}

/**
 * Resolve `host` to all A/AAAA records and reject if ANY of them is a
 * private / loopback / link-local / reserved address. This closes the
 * DNS-rebinding gap that `isPublicHttpsUpstream` (string-only) leaves open:
 * a public name whose A record points at 169.254.169.254 / 127.0.0.1 /
 * RFC-1918 is refused before we connect.
 *
 * Throws `SsrfBlockedError` on any private address or resolution failure.
 * The resolve happens immediately before egress to minimise the TOCTOU
 * window. (Full IP pinning would require an undici connect hook; undici is
 * not a dependency here, so we accept the residual sub-second rebind window
 * and instead re-validate on every redirect — the dominant exploit path.)
 */
export async function assertResolvesPublic(host: string): Promise<void> {
  // An IP literal needs no DNS round-trip; validate it directly.
  if (isPrivateIPv4(host) || (host.includes(':') && isPrivateIPv6(host))) {
    throw new SsrfBlockedError(`blocked private/reserved address: ${host}`)
  }
  // Bracketless IPv6 / dotted IPv4 literals that are public still don't need
  // resolution; only resolve actual names.
  const isIpLiteral =
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')
  if (isIpLiteral) return

  let records: Array<{ address: string }>
  try {
    records = await lookupAll(host)
  } catch (err) {
    throw new SsrfBlockedError(
      `dns resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (records.length === 0) {
    throw new SsrfBlockedError(`dns resolution returned no records for ${host}`)
  }
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(
        `host ${host} resolves to private/reserved address ${address}`,
      )
    }
  }
}

/** Thrown when an egress target fails the SSRF guard. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

const MAX_REDIRECTS = 5

interface EgressOptions {
  /**
   * When true, the INITIAL url must pass the full public-https guard
   * (https-only + public host + resolves-public). Use for attacker-
   * influenceable URLs (HLS manifest/segment `rid`).
   *
   * When false, the initial url is trusted (operator-configured Xtream
   * creds host, which may legitimately be plain http) and is fetched
   * as-is — but every REDIRECT target is still fully guarded, since an
   * upstream-issued 30x is attacker-influenceable and could point at an
   * internal address.
   */
  guardInitial: boolean
}

async function guardHop(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new SsrfBlockedError(`malformed upstream url: ${rawUrl}`)
  }
  if (!isPublicHttpsUpstream(parsed)) {
    throw new SsrfBlockedError(`blocked non-public upstream: ${parsed.protocol}//${parsed.hostname}`)
  }
  await assertResolvesPublic(parsed.hostname)
}

/**
 * Core SSRF-hardened egress loop. Sets `redirect: 'manual'` so a 30x to an
 * internal host is re-checked here instead of being followed blindly by the
 * platform fetch, and bounds redirect depth at MAX_REDIRECTS. The final
 * (non-redirect) Response is returned for the caller to stream. Throws
 * `SsrfBlockedError` if any guarded hop fails.
 */
async function egress(
  initialUrl: string,
  init: RequestInit | undefined,
  opts: EgressOptions,
): Promise<Response> {
  let currentUrl = initialUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // The initial hop is guarded only when guardInitial is set; every
    // subsequent (redirect) hop is ALWAYS guarded.
    if (hop > 0 || opts.guardInitial) {
      await guardHop(currentUrl)
    }

    const res = await fetch(currentUrl, { ...init, redirect: 'manual' })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return res // malformed redirect; hand back as-is
      // Drain the redirect body so the socket can be reused.
      await res.body?.cancel().catch(() => {})
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return res
  }
  throw new SsrfBlockedError(`too many redirects (>${MAX_REDIRECTS}) for ${initialUrl}`)
}

/**
 * SSRF-hardened replacement for `fetch()` when the target URL itself is
 * attacker-influenceable (HLS manifest sub-playlist / segment `rid`). The
 * initial URL and every redirect hop must be https + public + resolve-public.
 */
export function guardedFetch(initialUrl: string, init?: RequestInit): Promise<Response> {
  return egress(initialUrl, init, { guardInitial: true })
}

/**
 * SSRF-hardened fetch for a TRUSTED initial origin (operator-configured
 * Xtream creds host, which may be plain http) that must still be protected
 * against an upstream-issued redirect into the internal network. The initial
 * URL is fetched as-is; every redirect target is fully guarded.
 */
export function guardedFetchTrustedOrigin(initialUrl: string, init?: RequestInit): Promise<Response> {
  return egress(initialUrl, init, { guardInitial: false })
}
