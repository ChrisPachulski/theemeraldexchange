//! The caller's address at the configured proxy trust boundary. Port of
//! services/clientAddress.ts (its socket fallback had no caller).

use axum::http::HeaderMap;

/// `(source, address)` from CF-Connecting-IP, then True-Client-IP, only when
/// TRUST_CLIENT_IP_HEADERS says the proxy in front sets them. X-Forwarded-For
/// is never read: picking a safe hop needs a validated proxy chain.
pub(crate) fn trusted(
    headers: &HeaderMap,
    trust_proxy_headers: bool,
) -> Option<(&'static str, &str)> {
    if !trust_proxy_headers {
        return None;
    }
    let forwarded = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|a| !a.is_empty())
    };
    forwarded("cf-connecting-ip")
        .map(|a| ("cf", a))
        .or_else(|| forwarded("true-client-ip").map(|a| ("true-client", a)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_headers_are_read_only_when_trusted() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.9".parse().unwrap());
        h.insert("true-client-ip", " 198.51.100.7 ".parse().unwrap());
        assert_eq!(trusted(&h, false), None);
        assert_eq!(trusted(&h, true), Some(("true-client", "198.51.100.7")));
        h.insert("cf-connecting-ip", "198.51.100.20".parse().unwrap());
        assert_eq!(trusted(&h, true), Some(("cf", "198.51.100.20")));
        h.insert("cf-connecting-ip", "  ".parse().unwrap());
        assert_eq!(trusted(&h, true), Some(("true-client", "198.51.100.7")));
        h.remove("true-client-ip");
        assert_eq!(trusted(&h, true), None);
    }
}
