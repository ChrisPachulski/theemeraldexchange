//! On-demand HLS and progressive proxying (iptvHlsRewrite.ts, iptvHlsProxy.ts):
//! manifest lines are rewritten to signed `/api/iptv/stream/segment` URLs, a
//! manifest fetch is bounded in time and size, and VOD/series files are
//! proxied with Range passthrough.

use std::sync::LazyLock;
use std::time::Duration;

use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use emerald_contracts::stream_token::StreamKind;
use regex::{Captures, Regex};
use reqwest::Url;
use serde_json::json;

use crate::playlist;
use crate::xtream::{FetchError, fetch_guarded};

pub const SEGMENT_PATH: &str = "/api/iptv/stream/segment";

/// The on-demand grant a rewritten segment URL belongs to, so the segment
/// route can heartbeat its slot. Not a capability: the segment route only
/// touches sessions of the signed token's sub.
#[derive(Clone, Debug, PartialEq)]
pub struct Owner {
    pub kind: &'static str,
    pub id: String,
}

/// `[\w-]+` in JS (ASCII word characters and '-').
pub fn is_word_id(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Query suffix (leading `&`) carrying `owner`. Ids are `[\w-]+`, so they need
/// no escaping.
pub fn owner_query(owner: Option<&Owner>) -> String {
    owner.map_or_else(String::new, |o| format!("&ok={}&oid={}", o.kind, o.id))
}

/// Inverse of [`owner_query`]; None unless both params are well formed.
pub fn parse_owner(kind: Option<&str>, id: Option<&str>) -> Option<Owner> {
    let kind = match kind? {
        "vod" => "vod",
        "series" => "series",
        _ => return None,
    };
    let id = id.filter(|id| is_word_id(id))?;
    Some(Owner {
        kind,
        id: id.to_string(),
    })
}

/// `new URL(reference, base).toString()`, or the reference unchanged.
fn resolve(base: &str, reference: &str) -> String {
    Url::parse(base)
        .and_then(|b| b.join(reference))
        .map_or_else(|_| reference.to_string(), String::from)
}

/// `URI=(["'])([^"']+)\1` without a backreference.
static URI_ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"URI="([^"']+)"|URI='([^"']+)'"#).unwrap());

pub fn rewrite_manifest(
    manifest: &str,
    base_url: &str,
    sign: impl Fn(&str) -> String,
    proxy_prefix: &str,
    owner: Option<&Owner>,
) -> String {
    let oq = owner_query(owner);
    let rewritten = |upstream: &str| format!("{proxy_prefix}?u={}{oq}", sign(upstream));
    manifest
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| {
            if line.starts_with('#') && URI_ATTR.is_match(line) {
                return URI_ATTR
                    .replace_all(line, |c: &Captures| {
                        let (q, uri) = match c.get(1) {
                            Some(m) => ('"', m.as_str()),
                            None => ('\'', &c[2]),
                        };
                        format!("URI={q}{}{q}", rewritten(&resolve(base_url, uri)))
                    })
                    .into_owned();
            }
            if line.is_empty() || line.starts_with('#') {
                return line.to_string();
            }
            rewritten(&resolve(base_url, line))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn json_error(status: StatusCode, error: &str) -> Response {
    (status, axum::Json(json!({ "error": error }))).into_response()
}

pub fn upstream_status(status: reqwest::StatusCode) -> Response {
    json_error(
        StatusCode::BAD_GATEWAY,
        &format!("upstream_{}", status.as_u16()),
    )
}

/// A transport failure the TS let propagate (Hono's 500).
pub fn internal(e: &str) -> Response {
    tracing::warn!("iptv upstream fetch failed: {e}");
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}

pub struct Rewrite<'a> {
    pub http: &'a reqwest::Client,
    pub secret: &'a str,
    pub sub: &'a str,
    pub ttl: i64,
    pub timeout: Duration,
    pub max_bytes: u64,
}

/// Fetch an upstream playlist (every hop SSRF-guarded, headers and body under
/// one deadline, body capped) and rewrite it to signed segment URLs bound to
/// `sub`, tagged with `owner` (threaded through the sub-playlist recursion).
/// Relative URIs resolve against the URL that answered, after redirects.
pub async fn fetch_and_rewrite(r: &Rewrite<'_>, upstream: &str, owner: Option<&Owner>) -> Response {
    let Ok(url) = Url::parse(upstream) else {
        return json_error(StatusCode::BAD_REQUEST, "bad_upstream");
    };
    enum Got {
        Text(String, String),
        Status(reqwest::StatusCode),
        TooLarge,
    }
    let fetch = async {
        let mut res = fetch_guarded(r.http, url, None, true).await?;
        if !res.status().is_success() {
            return Ok::<_, FetchError>(Got::Status(res.status()));
        }
        if res.content_length().is_some_and(|n| n > r.max_bytes) {
            return Ok(Got::TooLarge);
        }
        let mut buf = Vec::new();
        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| FetchError::Failed(e.without_url().to_string()))?
        {
            buf.extend_from_slice(&chunk);
            if buf.len() as u64 > r.max_bytes {
                return Ok(Got::TooLarge);
            }
        }
        Ok(Got::Text(
            res.url().to_string(),
            String::from_utf8_lossy(&buf).into_owned(),
        ))
    };
    let (base, text) = match tokio::time::timeout(r.timeout, fetch).await {
        Err(_) => return json_error(StatusCode::GATEWAY_TIMEOUT, "upstream_timeout"),
        Ok(Err(e)) if e.is_blocked() => {
            return json_error(StatusCode::BAD_REQUEST, "bad_upstream");
        }
        Ok(Err(e)) => return internal(&format!("{e:?}")),
        Ok(Ok(Got::Status(s))) => return upstream_status(s),
        Ok(Ok(Got::TooLarge)) => return json_error(StatusCode::BAD_GATEWAY, "manifest_too_large"),
        Ok(Ok(Got::Text(base, text))) => (base, text),
    };
    let sign = |u: &str| playlist::sign(r.secret, StreamKind::Segment, u, r.sub, r.ttl, None);
    let body = rewrite_manifest(&text, &base, sign, SEGMENT_PATH, owner);
    (
        [
            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(u: &str) -> String {
        format!("signed({})", urlencode(u))
    }
    fn urlencode(s: &str) -> String {
        s.replace(':', "%3A").replace('/', "%2F")
    }

    #[test]
    fn rewrites_relative_and_absolute_media_uris() {
        let input = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.0,\nseg-001.ts\n#EXTINF:6.0,\n\
                     https://cdn.example/foo/seg-002.ts\n#EXT-X-ENDLIST";
        let out = rewrite_manifest(
            input,
            "https://upstream.example/path/movie.m3u8",
            sign,
            SEGMENT_PATH,
            None,
        );
        assert!(out.contains(
            "/api/iptv/stream/segment?u=signed(https%3A%2F%2Fupstream.example%2Fpath%2Fseg-001.ts)"
        ));
        assert!(out.contains(
            "/api/iptv/stream/segment?u=signed(https%3A%2F%2Fcdn.example%2Ffoo%2Fseg-002.ts)"
        ));
        assert!(out.starts_with("#EXTM3U\n#EXT-X-VERSION:3\n"));
    }

    #[test]
    fn rewrites_ext_x_media_uri_attributes() {
        let input = "#EXTM3U\n\
            #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"en\",DEFAULT=YES,FORCED=NO,URI=\"subs/en.m3u8\"\r\n\
            #EXT-X-STREAM-INF:BANDWIDTH=1280000\nlevel1.m3u8";
        let out = rewrite_manifest(
            input,
            "https://up.example/master.m3u8",
            sign,
            SEGMENT_PATH,
            None,
        );
        assert!(out.contains(
            "URI=\"/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Fsubs%2Fen.m3u8)\""
        ));
        assert!(
            out.contains(
                "/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Flevel1.m3u8)"
            )
        );
        assert!(!out.contains('\r'));
    }

    #[test]
    fn preserves_single_quoted_uri_attributes() {
        let out = rewrite_manifest(
            "#EXT-X-MEDIA:TYPE=AUDIO,URI='audio/en.m3u8'",
            "https://up.example/master.m3u8",
            sign,
            SEGMENT_PATH,
            None,
        );
        assert!(out.contains(
            "URI='/api/iptv/stream/segment?u=signed(https%3A%2F%2Fup.example%2Faudio%2Fen.m3u8)'"
        ));
    }

    #[test]
    fn appends_the_owner_tag_to_media_lines_and_uri_attributes() {
        let owner = Owner {
            kind: "series",
            id: "ep-1".into(),
        };
        let out = rewrite_manifest(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/en.m3u8\"\nlevel1.m3u8",
            "https://up.example/master.m3u8",
            sign,
            SEGMENT_PATH,
            Some(&owner),
        );
        let lines: Vec<_> = out.lines().filter(|l| l.contains(SEGMENT_PATH)).collect();
        assert_eq!(lines.len(), 2);
        for l in lines {
            assert!(l.contains("&ok=series&oid=ep-1"), "{l}");
        }
        assert!(out.contains("&ok=series&oid=ep-1\""));
    }

    #[test]
    fn emits_no_owner_tag_without_an_owner() {
        let bare = rewrite_manifest("seg.ts", "https://up.example/a.m3u8", sign, "/p", None);
        assert!(!bare.contains("ok="));
        assert_eq!(bare, "/p?u=signed(https%3A%2F%2Fup.example%2Fseg.ts)");
    }

    #[test]
    fn the_owner_tag_round_trips() {
        let owner = Owner {
            kind: "vod",
            id: "a-b_1".into(),
        };
        let q = owner_query(Some(&owner));
        let pairs: Vec<(&str, &str)> = q[1..]
            .split('&')
            .filter_map(|p| p.split_once('='))
            .collect();
        let get = |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| *v);
        assert_eq!(parse_owner(get("ok"), get("oid")), Some(owner));
        assert_eq!(owner_query(None), "");
    }

    #[test]
    fn rejects_anything_but_a_well_formed_on_demand_grant() {
        for (kind, id) in [
            (None, Some("20")),
            (Some("vod"), None),
            (Some("vod"), Some("")),
            (Some("live"), Some("10")),
            (Some("catchup"), Some("10")),
            (Some("remux"), Some("10")),
            (Some("VOD"), Some("20")),
            (Some("vod"), Some("../../etc/passwd")),
            (Some("vod"), Some("20' OR 1=1")),
            (Some("vod"), Some("20 21")),
            (Some("series"), Some("ep 1")),
            (Some("vod"), Some("é")),
        ] {
            assert_eq!(parse_owner(kind, id), None, "{kind:?}/{id:?}");
        }
    }
}
