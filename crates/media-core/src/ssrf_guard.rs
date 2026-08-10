//! SSRF containment for outbound fetches of household-supplied URLs.
//!
//! Rust port of `server/services/ssrfGuard.ts` (same range table, same
//! every-redirect-hop-is-untrusted stance). The podcast feed URL is typed in by
//! any household member, so without this the media-core container will fetch
//! whatever internal address it is handed — loopback, the compose network, the
//! docker gateway, cloud metadata — and hand the body back to the caller.
//!
//! Two layers, both required:
//!   1. [`guard_url`] — scheme + host/IP-literal + bare-internal-name reject,
//!      then DNS-resolve a name and reject if ANY answer is private.
//!   2. the caller drives redirects manually (see `podcasts::fetch_feed`) and
//!      re-runs [`guard_url`] on every `Location`, because an upstream-issued
//!      30x is as attacker-influenceable as the original URL.
//!
//! ACCEPTED RESIDUAL RISK — DNS-rebind TOCTOU: we resolve the name, then
//! reqwest resolves it again to connect, so an attacker controlling the
//! authoritative nameserver can answer public here and private on the connect
//! lookup. Same residual the Node guard documents; closing it needs a
//! connect-time IP pin (a custom `reqwest::dns::Resolve`), which is not worth
//! the wiring for a self-hosted NAS with no cloud metadata endpoint.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Redirect hops we will follow before giving up (mirrors the Node guard).
pub const MAX_REDIRECTS: usize = 5;

/// IPv4 in a private / loopback / link-local / reserved / CGNAT range that must
/// never be reachable from a household-supplied URL. Mirrors `isPrivateIPv4`.
/// Written out rather than leaning on `Ipv4Addr::is_*` because `is_shared`
/// (CGNAT), `is_benchmarking` and `is_reserved` are still unstable.
fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    match (a, b, c) {
        (10, ..) => true,           // 10.0.0.0/8
        (127, ..) => true,          // loopback
        (0, ..) => true,            // 0.0.0.0/8 "this host"
        (169, 254, _) => true,      // link-local incl. cloud metadata
        (172, 16..=31, _) => true,  // 172.16.0.0/12
        (192, 168, _) => true,      // 192.168.0.0/16
        (192, 0, 0) => true,        // IETF protocol assignments 192.0.0.0/24
        (192, 88, 99) => true,      // 6to4 relay anycast 192.88.99.0/24
        (198, 18 | 19, _) => true,  // benchmarking 198.18.0.0/15
        (100, 64..=127, _) => true, // CGNAT 100.64.0.0/10
        (224..=255, ..) => true,    // multicast + reserved + broadcast
        _ => false,
    }
}

/// IPv6 loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10),
/// deprecated site-local (fec0::/10), NAT64 (64:ff9b::/96 — embeds an IPv4
/// target a NAT64 gateway would reach), and v4-mapped/compatible private
/// addresses. Mirrors `isPrivateIPv6`.
fn is_private_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    // ::ffff:a.b.c.d and the deprecated ::a.b.c.d both decay to their v4 range.
    if let Some(v4) = ip.to_ipv4() {
        return is_private_v4(v4);
    }
    let s = ip.segments();
    (s[0] & 0xfe00) == 0xfc00                 // unique-local fc00::/7
        || (s[0] & 0xffc0) == 0xfe80          // link-local fe80::/10
        || (s[0] & 0xffc0) == 0xfec0          // site-local fec0::/10 (deprecated)
        || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64 64:ff9b::/96
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

/// A single-label name (`recommender`, `localhost`) is compose/service DNS, and
/// `.local` / `.internal` are LAN suffixes — never a public podcast host.
/// Mirrors `isInternalHostname`, plus a trailing-dot strip so the FQDN form
/// `localhost.` cannot slip past the dot test.
fn is_internal_hostname(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h.is_empty()
        || h == "localhost"
        || !h.contains('.')
        || h.ends_with(".local")
        || h.ends_with(".internal")
}

/// Reject anything that is not an http(s) fetch of a public address.
///
/// An IP-literal host is decided from the literal alone — no DNS, no socket —
/// so `http://127.0.0.1:1/x` fails instantly rather than after a connect
/// attempt. A DNS name is resolved and refused if ANY answer is private
/// (the rebinding case a string-only check misses).
pub async fn guard_url(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("feed_url must be http(s)".to_string());
    }
    let Some(host) = url.host_str() else {
        return Err("blocked url with no host".to_string());
    };
    // host_str keeps IPv6 bracketed; the literal parse needs it bare.
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if is_private_ip(ip) {
            Err(format!("blocked private/reserved address: {bare}"))
        } else {
            Ok(())
        };
    }

    if is_internal_hostname(bare) {
        return Err(format!("blocked internal hostname: {bare}"));
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|e| format!("dns resolution failed for {bare}: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("dns resolution returned no records for {bare}"));
    }
    for addr in addrs {
        if is_private_ip(addr.ip()) {
            return Err(format!(
                "host {bare} resolves to private/reserved address {}",
                addr.ip()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }
    fn v6(s: &str) -> Ipv6Addr {
        s.parse().unwrap()
    }

    #[test]
    fn v4_range_table_matches_the_node_guard() {
        for blocked in [
            "10.0.0.1",
            "127.0.0.1",
            "0.0.0.0",
            "169.254.169.254", // cloud metadata
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "192.0.0.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.19.255.1",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_private_v4(v4(blocked)), "{blocked} should be blocked");
        }
        for allowed in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.169.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "198.20.0.1",
            "223.255.255.255",
        ] {
            assert!(!is_private_v4(v4(allowed)), "{allowed} should be allowed");
        }
    }

    #[test]
    fn v6_range_table_matches_the_node_guard() {
        for blocked in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "feff::1",
            "64:ff9b::7f00:1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            assert!(is_private_v6(v6(blocked)), "{blocked} should be blocked");
        }
        for allowed in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_private_v6(v6(allowed)), "{allowed} should be allowed");
        }
    }

    #[test]
    fn bare_and_lan_hostnames_are_internal() {
        for h in [
            "localhost",
            "LOCALHOST",
            "localhost.", // trailing-dot FQDN form
            "recommender",
            "media-core",
            "theemeraldexchange.local",
            "metadata.internal",
        ] {
            assert!(is_internal_hostname(h), "{h} should be internal");
        }
        for h in ["feeds.megaphone.fm", "example.com", "a.b.example.co.uk"] {
            assert!(!is_internal_hostname(h), "{h} should be public");
        }
    }

    /// Every case here is decided from the URL alone — no DNS, no socket — so
    /// the whole test is instant even though `guard_url` can resolve.
    #[tokio::test]
    async fn guard_url_rejects_without_touching_the_network() {
        for bad in [
            "file:///etc/passwd",
            "gopher://example.com/x",
            "http://127.0.0.1:1/x",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:8080/x",
            "http://[::ffff:10.0.0.5]/x",
            "http://localhost/feed.xml",
            "http://recommender:8080/feed.xml",
            "http://theemeraldexchange.local/feed.xml",
            "http://10.0.0.7/feed.xml",
        ] {
            let url = reqwest::Url::parse(bad).unwrap();
            assert!(
                guard_url(&url).await.is_err(),
                "{bad} should have been blocked"
            );
        }
    }
}
