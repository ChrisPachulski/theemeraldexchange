//! Playlist tokens and the M3U for external players (iptvPlaylist.ts), plus the
//! public base URL minted links are rooted at (publicBaseUrl in shared.ts).
//!
//! A playlist token is a 90-day HMAC stream token whose jti is stored in
//! iptv_playlist_tokens at mint, so revocation holds. The M3U embeds 300 s
//! per-channel `live` tokens: players re-fetch often enough, and a leaked body
//! goes stale fast.

use chrono::Utc;
use emerald_contracts::stream_token::{self, StreamClaims, StreamKind, TokenError};
use reqwest::Url;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::xtream::iso;

/// Canonical resource id of every playlist token.
pub const PLAYLIST_RID: &str = "iptv-channels-all";
const PLAYLIST_TTL_SECS: i64 = 90 * 24 * 3600;
const CHANNEL_TOKEN_TTL_SECS: i64 = 300;

/// Sign a stream token; a fresh ULID jti when none is given.
pub fn sign(
    secret: &str,
    kind: StreamKind,
    rid: &str,
    sub: &str,
    ttl: i64,
    jti: Option<&str>,
) -> String {
    let now = Utc::now().timestamp();
    stream_token::sign(
        secret.as_bytes(),
        &StreamClaims {
            exp: now + ttl,
            iat: now,
            jti: jti.map_or_else(|| ulid::Ulid::generate().to_string(), String::from),
            k: kind,
            nbf: now,
            rid: rid.into(),
            sub: sub.into(),
            v: 1,
        },
    )
}

/// Verify HMAC and time window. Errors carry the TS `detail` strings clients
/// and logs already match on (rethrowAsLegacy in iptvStreamToken.ts).
pub fn verify(secret: &str, token: &str) -> Result<StreamClaims, &'static str> {
    let legacy = |e: TokenError| match e {
        TokenError::Expired => "expired_token",
        TokenError::NotYetValid => "token_not_yet_valid",
        TokenError::UnsupportedVersion | TokenError::BadPayload => "token_version_unsupported",
        _ => "invalid_signature",
    };
    let claims = stream_token::verify(secret.as_bytes(), token).map_err(legacy)?;
    stream_token::enforce_time_window(&claims, Utc::now().timestamp()).map_err(legacy)?;
    Ok(claims)
}

/// Collapse CR/LF/tab (a provider name could otherwise inject a playlist line)
/// and neutralize the attribute quote.
pub fn escape_m3u_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_ws = false;
    for c in value.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
            continue;
        }
        in_ws = false;
        out.push(if c == '"' { '\'' } else { c });
    }
    out.trim().to_string()
}

#[derive(sqlx::FromRow)]
pub struct TokenRow {
    pub jti: String,
    pub sub: String,
    pub device_name: Option<String>,
    pub issued_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenView {
    pub jti: String,
    pub sub: String,
    pub device_name: Option<String>,
    pub issued_at: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub revoked: bool,
}

impl From<TokenRow> for TokenView {
    fn from(r: TokenRow) -> Self {
        TokenView {
            revoked: r.revoked_at.is_some(),
            jti: r.jti,
            sub: r.sub,
            device_name: r.device_name,
            issued_at: r.issued_at,
            expires_at: r.expires_at,
            revoked_at: r.revoked_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Minted {
    pub jti: String,
    pub device_name: Option<String>,
    pub url: String,
    pub expires_at: String,
}

/// Mint a playlist token for `sub`, persist its jti, and return the
/// ready-to-paste URL rooted at `base_url`.
pub async fn mint(
    pool: &SqlitePool,
    secret: &str,
    sub: &str,
    device_name: Option<String>,
    base_url: &str,
) -> Result<Minted, sqlx::Error> {
    let jti = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let expires_at = iso(now + chrono::TimeDelta::seconds(PLAYLIST_TTL_SECS));
    let token = sign(
        secret,
        StreamKind::Playlist,
        PLAYLIST_RID,
        sub,
        PLAYLIST_TTL_SECS,
        Some(&jti),
    );
    sqlx::query(
        "INSERT INTO iptv_playlist_tokens (jti, sub, device_name, issued_at, expires_at, revoked_at) \
         VALUES (?, ?, ?, ?, ?, NULL)",
    )
    .bind(&jti)
    .bind(sub)
    .bind(&device_name)
    .bind(iso(now))
    .bind(&expires_at)
    .execute(pool)
    .await?;
    Ok(Minted {
        jti,
        device_name,
        url: format!("{base_url}/api/iptv/playlist.m3u?t={token}"),
        expires_at,
    })
}

pub async fn list(pool: &SqlitePool, sub: &str) -> Result<Vec<TokenView>, sqlx::Error> {
    let rows: Vec<TokenRow> = sqlx::query_as(
        "SELECT jti, sub, device_name, issued_at, expires_at, revoked_at \
         FROM iptv_playlist_tokens WHERE sub = ? ORDER BY issued_at DESC",
    )
    .bind(sub)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(TokenView::from).collect())
}

async fn row(pool: &SqlitePool, jti: &str) -> Result<Option<TokenRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT jti, sub, device_name, issued_at, expires_at, revoked_at FROM iptv_playlist_tokens WHERE jti = ?",
    )
    .bind(jti)
    .fetch_optional(pool)
    .await
}

#[derive(Debug, PartialEq)]
pub enum Revoke {
    Revoked,
    NotFound,
    Forbidden,
    AlreadyRevoked,
}

pub async fn revoke(
    pool: &SqlitePool,
    jti: &str,
    sub: &str,
    is_admin: bool,
) -> Result<Revoke, sqlx::Error> {
    let Some(r) = row(pool, jti).await? else {
        return Ok(Revoke::NotFound);
    };
    if r.sub != sub && !is_admin {
        return Ok(Revoke::Forbidden);
    }
    let changed = sqlx::query(
        "UPDATE iptv_playlist_tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL",
    )
    .bind(iso(Utc::now()))
    .bind(jti)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(if changed == 0 && r.revoked_at.is_some() {
        Revoke::AlreadyRevoked
    } else {
        Revoke::Revoked
    })
}

/// Revoke every live playlist token of `sub` (member revoked or erased).
pub async fn revoke_all(
    conn: impl sqlx::SqliteExecutor<'_>,
    sub: &str,
) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(
        "UPDATE iptv_playlist_tokens SET revoked_at = ? WHERE sub = ? AND revoked_at IS NULL",
    )
    .bind(iso(Utc::now()))
    .bind(sub)
    .execute(conn)
    .await?
    .rows_affected())
}

/// Why a `?t=` playlist token was refused: the 401 body's `error` and `detail`.
#[derive(Debug, PartialEq)]
pub struct Refused {
    pub error: &'static str,
    pub detail: Option<&'static str>,
}

/// HMAC + time window, kind and canonical rid, then the persisted jti row
/// (no row or a revoked one is a hard reject). Membership and the live/rating
/// policy are checked by Hono before it forwards. Returns the token's sub.
pub async fn authorize(
    pool: &SqlitePool,
    secret: &str,
    token: &str,
) -> Result<Result<String, Refused>, sqlx::Error> {
    let invalid = |detail| {
        Ok(Err(Refused {
            error: "invalid_token",
            detail: Some(detail),
        }))
    };
    let claims = match verify(secret, token) {
        Ok(c) => c,
        Err(detail) => return invalid(detail),
    };
    if claims.k != StreamKind::Playlist {
        return invalid("kind_mismatch");
    }
    if claims.rid != PLAYLIST_RID {
        return invalid("resource_mismatch");
    }
    let refused = |error| {
        Ok(Err(Refused {
            error,
            detail: None,
        }))
    };
    match row(pool, &claims.jti).await? {
        None => refused("token_not_found"),
        Some(r) if r.revoked_at.is_some() => refused("token_revoked"),
        Some(_) => Ok(Ok(claims.sub)),
    }
}

/// Every channel (num, name order), each with a short-lived live token.
pub async fn build_m3u(
    pool: &SqlitePool,
    secret: &str,
    sub: &str,
    base_url: &str,
) -> Result<String, sqlx::Error> {
    // num IS NOT NULL: the TS row mapper dropped rows without a number.
    // (stream_id, name, stream_icon, epg_channel_id, category name)
    type M3uRow = (i64, String, Option<String>, Option<String>, Option<String>);
    let channels: Vec<M3uRow> = sqlx::query_as(
        "SELECT c.stream_id, c.name, c.stream_icon, c.epg_channel_id, cat.name \
         FROM channels c LEFT JOIN categories cat ON cat.kind = 'live' AND cat.category_id = c.category_id \
         WHERE c.num IS NOT NULL ORDER BY c.num, c.name",
    )
    .fetch_all(pool)
    .await?;
    let mut out = String::from("#EXTM3U\n");
    for (id, name, icon, epg, group) in channels {
        let token = sign(
            secret,
            StreamKind::Live,
            &id.to_string(),
            sub,
            CHANNEL_TOKEN_TTL_SECS,
            None,
        );
        let name = escape_m3u_attr(&name);
        out.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-name=\"{name}\" tvg-logo=\"{}\" group-title=\"{}\",{name}\n\
             {base_url}/api/iptv/stream/live/{id}.ts?t={token}\n",
            escape_m3u_attr(epg.as_deref().unwrap_or("")),
            escape_m3u_attr(icon.as_deref().unwrap_or("")),
            escape_m3u_attr(group.as_deref().unwrap_or("Other")),
        ));
    }
    Ok(out)
}

fn first_value(v: Option<&str>) -> &str {
    v.and_then(|v| v.split(',').next()).unwrap_or("").trim()
}

/// A host is echoed into minted URLs only when it is one of ALLOWED_ORIGINS'
/// hosts or a subdomain of one (the API lives at api.<spa-domain>).
pub fn is_allowed_public_host(host: &str, allowed_origins: &[String]) -> bool {
    let lower = host.to_lowercase();
    let hostname = match lower.rfind(':') {
        Some(i)
            if !lower[i + 1..].is_empty() && lower[i + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            &lower[..i]
        }
        _ => &lower,
    };
    allowed_origins.iter().any(|origin| {
        Url::parse(origin)
            .ok()
            .and_then(|u| u.host_str().map(str::to_lowercase))
            .is_some_and(|o| hostname == o || hostname.ends_with(&format!(".{o}")))
    })
}

/// The scheme://host minted playlist and stream URLs start with. Forwarded
/// headers are trusted only for a host the operator allows; otherwise the first
/// parseable allowed origin, else the request's own Host.
pub fn public_base_url(headers: &axum::http::HeaderMap, allowed_origins: &[String]) -> String {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let request_host = header("host").unwrap_or("localhost").to_string();
    let forwarded_proto = first_value(header("x-forwarded-proto")).to_lowercase();
    let proto = if forwarded_proto == "http" || forwarded_proto == "https" {
        forwarded_proto
    } else {
        "http".into()
    };
    let mut host = first_value(header("x-forwarded-host"));
    if host.is_empty() {
        host = first_value(header("host"));
    }
    if host.is_empty() || host.contains(|c: char| c.is_whitespace() || c == '/' || c == '\\') {
        host = &request_host;
    }
    if allowed_origins.is_empty() || is_allowed_public_host(host, allowed_origins) {
        return format!("{proto}://{host}");
    }
    allowed_origins
        .iter()
        .find_map(|o| Url::parse(o).ok().map(|u| u.origin().ascii_serialization()))
        .unwrap_or_else(|| format!("{proto}://{request_host}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::tests::{exec, pool};

    const SECRET: &str = "ssssssssssssssssssssssssssssssssssssssss";

    #[test]
    fn escape_collapses_crlf_tab_and_neutralises_quotes() {
        assert_eq!(escape_m3u_attr("a\r\nb\tc"), "a b c");
        assert_eq!(escape_m3u_attr("say \"hi\""), "say 'hi'");
        assert_eq!(escape_m3u_attr("  trim me  "), "trim me");
    }

    #[test]
    fn token_view_maps_active_and_revoked_rows() {
        let r = |revoked_at: Option<&str>| TokenRow {
            jti: "j".into(),
            sub: "s".into(),
            device_name: Some("TV".into()),
            issued_at: "i".into(),
            expires_at: "e".into(),
            revoked_at: revoked_at.map(String::from),
        };
        let v = serde_json::to_value(TokenView::from(r(None))).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"jti": "j", "sub": "s", "deviceName": "TV", "issuedAt": "i",
                "expiresAt": "e", "revokedAt": null, "revoked": false})
        );
        assert!(TokenView::from(r(Some("r"))).revoked);
    }

    #[test]
    fn verify_maps_errors_to_the_ts_details() {
        let t = sign(SECRET, StreamKind::Live, "10", "plex:1", 300, None);
        assert_eq!(verify(SECRET, &t).unwrap().rid, "10");
        assert_eq!(verify("other", &t).unwrap_err(), "invalid_signature");
        assert_eq!(verify(SECRET, "garbage").unwrap_err(), "invalid_signature");
        let expired = sign(SECRET, StreamKind::Live, "10", "plex:1", -60, None);
        assert_eq!(verify(SECRET, &expired).unwrap_err(), "expired_token");
    }

    #[tokio::test]
    async fn mint_persists_the_jti_and_lists_and_revokes() {
        let (pool, _d) = pool().await;
        let m = mint(&pool, SECRET, "s", Some("Living Room".into()), "https://h")
            .await
            .unwrap();
        let token = m
            .url
            .strip_prefix("https://h/api/iptv/playlist.m3u?t=")
            .unwrap();
        let claims = verify(SECRET, token).unwrap();
        assert_eq!(
            (claims.k, claims.rid.as_str(), claims.jti.as_str()),
            (StreamKind::Playlist, PLAYLIST_RID, m.jti.as_str())
        );
        assert_eq!(
            iso(chrono::DateTime::from_timestamp(claims.exp, 0).unwrap())[..16],
            m.expires_at[..16]
        );
        assert_eq!(m.device_name.as_deref(), Some("Living Room"));
        assert!(
            mint(&pool, SECRET, "s", None, "https://h")
                .await
                .unwrap()
                .device_name
                .is_none()
        );
        let listed = list(&pool, "s").await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(list(&pool, "other").await.unwrap().is_empty());

        assert_eq!(
            revoke(&pool, "nope", "s", false).await.unwrap(),
            Revoke::NotFound
        );
        assert_eq!(
            revoke(&pool, &m.jti, "other", false).await.unwrap(),
            Revoke::Forbidden
        );
        assert_eq!(
            revoke(&pool, &m.jti, "s", false).await.unwrap(),
            Revoke::Revoked
        );
        assert_eq!(
            revoke(&pool, &m.jti, "admin", true).await.unwrap(),
            Revoke::AlreadyRevoked
        );
        assert_eq!(
            authorize(&pool, SECRET, token)
                .await
                .unwrap()
                .unwrap_err()
                .error,
            "token_revoked"
        );
        assert_eq!(
            revoke_all(&pool, "s").await.unwrap(),
            1,
            "only the live one"
        );
    }

    #[tokio::test]
    async fn authorize_checks_kind_rid_and_the_jti_row() {
        let (pool, _d) = pool().await;
        let refused = |t: String| {
            let pool = pool.clone();
            async move { authorize(&pool, SECRET, &t).await.unwrap().unwrap_err() }
        };
        let live = sign(SECRET, StreamKind::Live, PLAYLIST_RID, "s", 60, None);
        assert_eq!(
            refused(live).await,
            Refused {
                error: "invalid_token",
                detail: Some("kind_mismatch")
            }
        );
        let legacy = sign(SECRET, StreamKind::Playlist, "all", "s", 60, None);
        assert_eq!(
            refused(legacy).await,
            Refused {
                error: "invalid_token",
                detail: Some("resource_mismatch")
            }
        );
        let no_row = sign(
            SECRET,
            StreamKind::Playlist,
            PLAYLIST_RID,
            "s",
            60,
            Some("j"),
        );
        assert_eq!(
            refused(no_row.clone()).await,
            Refused {
                error: "token_not_found",
                detail: None
            }
        );
        exec(
            &pool,
            "INSERT INTO iptv_playlist_tokens (jti, sub, issued_at, expires_at) VALUES ('j', 's', 'i', 'e')",
        )
        .await;
        assert_eq!(
            authorize(&pool, SECRET, &no_row).await.unwrap(),
            Ok("s".to_string())
        );
    }

    #[tokio::test]
    async fn m3u_has_a_tokenised_url_and_group_title_per_channel() {
        let (pool, _d) = pool().await;
        exec(
            &pool,
            "INSERT INTO categories (category_id, kind, name) VALUES (1, 'live', 'News'), (1, 'vod', 'Films');
             INSERT INTO channels (stream_id, num, name, stream_icon, epg_channel_id, category_id, fetched_at) VALUES
               (5, 1, 'News A', NULL, NULL, 1, 'x'),
               (6, 2, 'Sports \"HD\"', 'l.png', 'e', NULL, 'x'),
               (7, 3, 'Evil\r\n#EXTINF:-1,x', NULL, NULL, 9, 'x'),
               (8, NULL, 'No number', NULL, NULL, 1, 'x');",
        )
        .await;
        let m3u = build_m3u(&pool, SECRET, "s", "https://h").await.unwrap();
        let lines: Vec<&str> = m3u.lines().collect();
        assert!(m3u.starts_with("#EXTM3U\n") && m3u.ends_with('\n'));
        assert_eq!(
            lines.len(),
            7,
            "header + 3 channels x 2; the NULL-num row drops"
        );
        assert_eq!(
            lines[1],
            "#EXTINF:-1 tvg-id=\"\" tvg-name=\"News A\" tvg-logo=\"\" group-title=\"News\",News A"
        );
        assert!(lines[2].starts_with("https://h/api/iptv/stream/live/5.ts?t="));
        assert_eq!(
            lines[3],
            "#EXTINF:-1 tvg-id=\"e\" tvg-name=\"Sports 'HD'\" tvg-logo=\"l.png\" group-title=\"Other\",Sports 'HD'"
        );
        assert!(
            lines[5].ends_with("group-title=\"Other\",Evil #EXTINF:-1,x"),
            "no injected line"
        );
        let t = lines[2].split("?t=").nth(1).unwrap();
        let c = verify(SECRET, t).unwrap();
        assert_eq!(
            (c.k, c.rid.as_str(), c.sub.as_str(), c.exp - c.iat),
            (StreamKind::Live, "5", "s", 300)
        );
    }

    fn headers(pairs: &[(&'static str, &str)]) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn public_base_url_allowlists_forwarded_hosts() {
        let fwd = |host: &str| {
            headers(&[
                ("host", "internal.local:3001"),
                ("x-forwarded-proto", "https"),
                ("x-forwarded-host", host),
            ])
        };
        let allowed = vec!["https://theemeraldexchange.example".to_string()];
        assert_eq!(
            public_base_url(&fwd("theemeraldexchange.example"), &allowed),
            "https://theemeraldexchange.example"
        );
        assert_eq!(
            public_base_url(&fwd("api.theemeraldexchange.example"), &allowed),
            "https://api.theemeraldexchange.example"
        );
        for evil in [
            "evil.example.com",
            "eviltheemeraldexchange.example",
            "theemeraldexchange.example.evil.com",
        ] {
            assert_eq!(
                public_base_url(&fwd(evil), &allowed),
                "https://theemeraldexchange.example",
                "{evil}"
            );
        }
        assert_eq!(
            public_base_url(&fwd("api.example.com"), &[]),
            "https://api.example.com"
        );
        assert_eq!(
            public_base_url(&fwd("API.Theemeraldexchange.example:8443"), &allowed),
            "https://API.Theemeraldexchange.example:8443"
        );
        assert_eq!(
            public_base_url(&fwd("a b"), &[]),
            "https://internal.local:3001",
            "unsafe host falls back"
        );
        assert_eq!(
            public_base_url(
                &headers(&[("host", "box:3001"), ("x-forwarded-proto", "ftp")]),
                &[]
            ),
            "http://box:3001"
        );
        assert_eq!(
            public_base_url(&fwd("evil.com"), &["not a url".into()]),
            "https://internal.local:3001",
            "every allowlist entry malformed: the request host"
        );
    }
}
