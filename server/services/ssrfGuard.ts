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
// from separate public CDNs. So we apply the standard egress defense — refuse
// any host that is an IP literal in a private / loopback / link-local /
// reserved range, an obviously-internal bare hostname, or a name that RESOLVES
// to such an address. Scheme is http OR https: the SSRF risk is the
// destination address, not the scheme, and several providers redirect an https
// panel URL to a plain-http public CDN.

// IPv4 dotted-quad → true when in a private / loopback / link-local / reserved
// / CGNAT range that must never be reachable from a public proxy.
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return true // malformed → treat as unsafe
  const [a, b, c] = o
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments 192.0.0.0/24
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast 192.88.99.0/24
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18.0.0/15
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a >= 224) return true // multicast + reserved (224+)
  return false
}

// IPv6 (already unbracketed) → true for loopback, unspecified, unique-local
// (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10),
// NAT64 (64:ff9b::/96 — embeds an IPv4 target a NAT64 gateway would reach),
// and IPv4-mapped private addresses.
function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // unique-local fc00::/7
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb'))
    return true // link-local fe80::/10
  if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef'))
    return true // site-local (deprecated) fec0::/10
  if (h.startsWith('64:ff9b:')) return true // NAT64 64:ff9b::/96 (+ local-use 64:ff9b:1::/48)
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
 * True only when `url` is safe to proxy: an http(s) scheme and a host that is a
 * public address. Rejects non-http(s) schemes (file:, gopher:, …), IP literals
 * in private/loopback/link-local/reserved ranges, and bare internal hostnames.
 *
 * Scheme note: BOTH http and https are allowed. The SSRF threat is the
 * *destination address* (cloud metadata 169.254.169.254, RFC-1918, loopback,
 * container DNS), which the host/IP checks below — plus `assertResolvesPublic`
 * on the resolved IPs — fully cover regardless of scheme. Requiring https here
 * added no SSRF protection but broke every legitimate IPTV provider that
 * 30x-redirects an https panel URL to a plain-http public CDN (e.g.
 * mybunny.tv → http://turbobunny.net), which 400'd all live playback. http to
 * a *public* host cannot reach an internal target, so it is permitted; only the
 * address is what matters.
 *
 * NOTE: this is a STRING-only check. A public DNS name that *resolves* to a
 * private address (DNS rebinding) passes here — callers MUST additionally
 * resolve-and-validate the host's IPs (see `assertResolvesPublic`) and route
 * egress through `guardedFetch`, which re-runs both checks on every redirect
 * hop. Keep this function for the cheap up-front reject; never rely on it
 * alone before a `fetch()`.
 */
export function isPublicUpstream(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  // URL.hostname strips the IPv6 brackets for us.
  const host = url.hostname
  if (!host) return false
  if (isPrivateIPv4(host)) return false
  if (host.includes(':') && isPrivateIPv6(host)) return false
  if (isInternalHostname(host)) return false
  return true
}

/**
 * Back-compat alias. The original name implied https-only; the guard now
 * accepts http to public hosts too (see `isPublicUpstream`). Kept so existing
 * import sites (routes/iptv.ts) need no change.
 */
export const isPublicHttpsUpstream = isPublicUpstream

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
 *
 * ACCEPTED RESIDUAL RISK — DNS-rebind TOCTOU: this check resolves the name,
 * then `fetch()` resolves it AGAIN to connect, so an attacker who controls
 * the authoritative nameserver can answer public here and private (e.g.
 * 169.254.169.254) on the connect-time lookup. Closing it fully requires
 * pinning the connection to the validated IP via an undici Agent connect
 * hook; undici is not a direct dependency and the platform-fetch dispatcher
 * is not exposed here, so we deliberately do NOT attempt that rewrite.
 * Mitigations that bound the residual risk:
 *   - the resolve happens immediately before egress, so the attacker must
 *     win a sub-second race against the OS resolver cache with a TTL-0
 *     record (most resolvers clamp TTL 0 upward);
 *   - every redirect hop — the dominant, race-free exploit path — is
 *     re-validated by `egress()` before it is followed;
 *   - internal services (recommender, media-core, transcoder) additionally
 *     require internal-principal auth, so a rebound request that does land
 *     inside the compose network hits an authenticated surface, not an
 *     open one. The highest-value unauth'd target is cloud metadata, which
 *     does not exist on this self-hosted NAS deployment.
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
  /**
   * Per-hop deadline in ms. Each hop's fetch gets a FRESH
   * AbortSignal.timeout composed (AbortSignal.any) with the caller's
   * `init.signal`, so a hung upstream cannot pin the egress loop open
   * forever. The timeout signal also governs the final response's body
   * read, so ONLY small-bodied fetches (HLS manifests) may opt in —
   * long-lived byte streams (live .ts, VOD ranges) must stay un-timed or
   * the timer would abort them mid-stream.
   */
  hopTimeoutMs?: number
}

export interface GuardedFetchOptions {
  /** See EgressOptions.hopTimeoutMs. Small-bodied fetches only. */
  hopTimeoutMs?: number
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

    // Compose the caller's signal (client disconnect / whole-transfer
    // deadline) with a fresh per-hop timeout so neither can be starved by
    // the other. Redirect hops each get a full hopTimeoutMs budget; the
    // total is still bounded by MAX_REDIRECTS × hopTimeoutMs plus whatever
    // whole-transfer deadline the caller composed into init.signal.
    const signals: AbortSignal[] = []
    if (init?.signal) signals.push(init.signal)
    if (opts.hopTimeoutMs != null) signals.push(AbortSignal.timeout(opts.hopTimeoutMs))
    const signal =
      signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

    const res = await fetch(currentUrl, { ...init, ...(signal ? { signal } : {}), redirect: 'manual' })

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
export function guardedFetch(
  initialUrl: string,
  init?: RequestInit,
  opts?: GuardedFetchOptions,
): Promise<Response> {
  return egress(initialUrl, init, { guardInitial: true, hopTimeoutMs: opts?.hopTimeoutMs })
}

/**
 * SSRF-hardened fetch for a TRUSTED initial origin (operator-configured
 * Xtream creds host, which may be plain http) that must still be protected
 * against an upstream-issued redirect into the internal network. The initial
 * URL is fetched as-is; every redirect target is fully guarded.
 */
export function guardedFetchTrustedOrigin(
  initialUrl: string,
  init?: RequestInit,
  opts?: GuardedFetchOptions,
): Promise<Response> {
  return egress(initialUrl, init, { guardInitial: false, hopTimeoutMs: opts?.hopTimeoutMs })
}
