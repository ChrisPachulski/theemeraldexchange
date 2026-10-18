//! `?t=` stream tokens for library media (services/mediaStreamToken.ts), over
//! [`emerald_contracts::stream_token`]. A cross-origin player cannot present
//! the session cookie on every range or segment GET, so the URL carries a
//! token bound to one resource. The kinds are the canonical ones: `vod` for a
//! seekable file (a library title, a muxed trailer), `remux` for transcoder
//! HLS. Resource ids live under `media:` so a media token can never satisfy
//! an IPTV resource check, and the reverse. Tokens are multi-use until exp.

use emerald_contracts::stream_token::{self, StreamClaims, StreamKind};

/// Direct play (progressive) token kind.
pub const DIRECT: StreamKind = StreamKind::Vod;
/// Transcoder HLS (manifest plus segments) token kind.
pub const HLS: StreamKind = StreamKind::Remux;

/// `media:<kind>:<id>`, e.g. `media:movie:123` or `media:trailer:<youtube id>`.
pub fn resource_id(kind: &str, id: impl std::fmt::Display) -> String {
    format!("media:{kind}:{id}")
}

/// `media:session:<sid>`, bound to one transcoder session.
pub fn session_resource_id(session_id: &str) -> String {
    format!("media:session:{session_id}")
}

/// A token for `sub` on `rid`, valid from now for `ttl_secs`.
pub fn sign(secret: &str, sub: &str, rid: &str, kind: StreamKind, ttl_secs: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = StreamClaims {
        exp: now + i64::try_from(ttl_secs).unwrap_or(i64::MAX - now),
        iat: now,
        jti: ulid::Ulid::generate().to_string(),
        k: kind,
        nbf: now,
        rid: rid.into(),
        sub: sub.into(),
        v: 1,
    };
    stream_token::sign(secret.as_bytes(), &claims)
}

/// Why a token was refused; the string is the 401 body's `error`.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    InvalidToken,
    TokenKind,
    TokenMismatch,
}

impl Refusal {
    pub fn as_str(&self) -> &'static str {
        match self {
            Refusal::InvalidToken => "invalid_token",
            Refusal::TokenKind => "token_kind",
            Refusal::TokenMismatch => "token_mismatch",
        }
    }
}

/// Signature and time window under STREAM_TOKEN_SECRET alone, then the
/// `media:` namespace, the allowed kinds and (when given) the exact resource,
/// in that order. Returns the claims' sub.
pub fn verify(
    secret: &str,
    token: &str,
    kinds: &[StreamKind],
    rid: Option<&str>,
) -> Result<String, Refusal> {
    let claims = stream_token::verify(secret.as_bytes(), token)
        .and_then(|c| {
            stream_token::enforce_time_window(&c, chrono::Utc::now().timestamp()).map(|()| c)
        })
        .map_err(|_| Refusal::InvalidToken)?;
    if !claims.rid.starts_with("media:") {
        return Err(Refusal::TokenKind);
    }
    if !kinds.is_empty() && !kinds.contains(&claims.k) {
        return Err(Refusal::TokenKind);
    }
    if rid.is_some_and(|r| r != claims.rid) {
        return Err(Refusal::TokenMismatch);
    }
    Ok(claims.sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "media-test-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
    const SESSION_SECRET: &str = "session-fallback-secret-bbbbbbbbbbbbbbbbbbbb";
    const TTL: u64 = 21_600;

    #[test]
    fn round_trips_a_direct_play_token_bound_to_a_title() {
        let rid = resource_id("movie", 123);
        assert_eq!(rid, "media:movie:123");
        let token = sign(SECRET, "apple:42", &rid, DIRECT, TTL);
        assert_eq!(
            verify(SECRET, &token, &[DIRECT], Some(&rid)),
            Ok("apple:42".into())
        );
    }

    #[test]
    fn round_trips_an_hls_session_token() {
        let rid = session_resource_id("sess-xyz");
        let token = sign(SECRET, "apple:7", &rid, HLS, TTL);
        assert!(verify(SECRET, &token, &[HLS], Some(&rid)).is_ok());
    }

    #[test]
    fn rejects_a_token_for_another_resource() {
        let token = sign(SECRET, "apple:42", &resource_id("movie", 1), DIRECT, TTL);
        let other = resource_id("movie", 2);
        assert_eq!(
            verify(SECRET, &token, &[DIRECT], Some(&other)),
            Err(Refusal::TokenMismatch)
        );
    }

    #[test]
    fn rejects_a_token_of_the_wrong_kind() {
        let rid = resource_id("movie", 1);
        let token = sign(SECRET, "apple:42", &rid, DIRECT, TTL);
        assert_eq!(
            verify(SECRET, &token, &[HLS], Some(&rid)),
            Err(Refusal::TokenKind)
        );
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(
            verify(SECRET, "not-a-token", &[], None),
            Err(Refusal::InvalidToken)
        );
    }

    /// Single-key: a valid HMAC under the session secret must not verify,
    /// or SESSION_SECRET would stay a stream-token forgery key.
    #[test]
    fn rejects_a_token_forged_with_the_session_secret() {
        let rid = resource_id("movie", 123);
        let forged = sign(SESSION_SECRET, "apple:42", &rid, DIRECT, 300);
        assert_eq!(
            verify(SECRET, &forged, &[DIRECT], Some(&rid)),
            Err(Refusal::InvalidToken)
        );
    }

    #[test]
    fn rejects_a_non_media_rid_and_an_expired_token() {
        let iptv = sign(SECRET, "apple:42", "live:123", DIRECT, TTL);
        assert_eq!(verify(SECRET, &iptv, &[], None), Err(Refusal::TokenKind));
        let now = chrono::Utc::now().timestamp();
        let expired = stream_token::sign(
            SECRET.as_bytes(),
            &StreamClaims {
                exp: now - 60,
                iat: now - 120,
                jti: ulid::Ulid::generate().to_string(),
                k: DIRECT,
                nbf: now - 120,
                rid: resource_id("movie", 1),
                sub: "apple:42".into(),
                v: 1,
            },
        );
        assert_eq!(
            verify(SECRET, &expired, &[], None),
            Err(Refusal::InvalidToken)
        );
    }
}
