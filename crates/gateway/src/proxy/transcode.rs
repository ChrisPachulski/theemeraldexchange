//! /api/transcode (routes/transcode.ts): the transcoder's HLS surface for
//! files that cannot direct-play. A `?t=` `remux` token bound to the session
//! in the path (`media:session:<sid>`) authenticates a cookieless hls.js or
//! AVPlayer; anything else needs the session. Either way the forward carries
//! an internal principal, which the transcoder's owner binding relies on.
//!
//! `/grant` and `/warm` are server-to-server control paths: the transcoder
//! trusts the principal and validates neither (`/grant` streams any file
//! path back, `/warm` demuxes one), and media-core calls them directly, so a
//! browser never reaches them through here (404, compared decoded, before any
//! principal is minted).

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;

use super::media::FORWARD_RESPONSE;
use super::{MEDIA_TTFB, copy, principal, query_without_token, req_id, token_caller};
use crate::AppState;
use crate::arr::shared::{query_first, query_pairs};
use crate::media_token;
use crate::principal::Caller;
use crate::routes::err;

/// Range on segments, revalidation of the manifest, and the client's
/// User-Agent: the transcoder serves AppleCoreMedia a finite VOD playlist
/// so AVKit shows a scrubber instead of a LIVE badge.
const FORWARD_REQUEST: &[&str] = &[
    "range",
    "if-range",
    "if-none-match",
    "if-modified-since",
    "user-agent",
];

const BLOCKED_CONTROL_PATHS: &[&str] = &["/grant", "/warm"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/transcode", any(proxy))
        .route("/api/transcode/{*rest}", any(proxy))
}

async fn proxy(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let subpath = match parts.uri.path().strip_prefix("/api/transcode") {
        Some("") | None => "/",
        Some(rest) => rest,
    };
    let pairs = query_pairs(&parts.uri);
    let token = query_first(&pairs, "t").filter(|t| !t.is_empty());
    let session_id = subpath
        .strip_prefix("/session/")
        .map(|rest| rest.split(['/', '?']).next().unwrap_or_default())
        .filter(|sid| !sid.is_empty());

    // transcodeAuth: the token branch, else the session.
    let (sub, role, device_id) = match (token, session_id) {
        (Some(token), Some(sid)) => {
            let rid = media_token::session_resource_id(sid);
            let sub = match media_token::verify(
                &st.config.auth.stream_token_secret,
                token,
                &[media_token::HLS],
                Some(&rid),
            ) {
                Ok(sub) => sub,
                Err(r) => return err(StatusCode::UNAUTHORIZED, r.as_str()),
            };
            if let Err(res) = super::require_member(&st, &sub).await {
                return res;
            }
            (sub, "user", None)
        }
        _ => match auth::authenticate(&st.auth, &parts.headers).await {
            Ok(p) => (
                p.session.sub,
                p.session.role.as_str(),
                p.device.map(|d| d.device_id),
            ),
            Err(rejection) => return rejection.into_response(),
        },
    };

    match super::decode_uri_component(subpath) {
        Some(decoded) if !BLOCKED_CONTROL_PATHS.contains(&decoded.as_str()) => {}
        _ => return err(StatusCode::NOT_FOUND, "not_found"),
    }

    let url = format!(
        "{}/api/transcode{subpath}{}",
        st.config.transcoder_url,
        query_without_token(&parts.uri)
    );
    let caller = Caller {
        role,
        device_id: device_id.as_deref(),
        ..token_caller(&sub)
    };
    let mut headers = HeaderMap::new();
    match principal(&st, &caller, req_id(&parts.headers)).await {
        Ok(Some(bearer)) => {
            headers.insert(header::AUTHORIZATION, bearer);
        }
        Ok(None) => {}
        Err(res) => return res,
    }
    copy(&parts.headers, &mut headers, FORWARD_REQUEST);
    let forwarded = if matches!(parts.method, Method::GET | Method::HEAD) {
        None
    } else {
        copy(&parts.headers, &mut headers, &["content-type"]);
        Some(
            axum::body::to_bytes(body, usize::MAX)
                .await
                .unwrap_or_default(),
        )
    };

    let res = match st
        .proxy
        .send(
            "transcoder",
            parts.method,
            &url,
            headers,
            forwarded,
            MEDIA_TTFB,
        )
        .await
    {
        Ok(res) => res,
        Err(res) => return res,
    };

    // hls.js resolves segment URIs against the manifest URL and drops its
    // query, so the manifest is buffered and every URI gets the token back.
    if let Some(token) = token
        && res.status().is_success()
        && subpath.ends_with(".m3u8")
    {
        let status = res.status();
        let mut out = HeaderMap::new();
        copy(res.headers(), &mut out, FORWARD_RESPONSE);
        out.entry(header::CONTENT_TYPE)
            .or_insert(HeaderValue::from_static("application/octet-stream"));
        let text = match res.bytes().await {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => {
                tracing::error!(event = "proxy", "transcoder manifest read failed: {e}");
                return err(StatusCode::INTERNAL_SERVER_ERROR, "internal");
            }
        };
        let rewritten = append_token_to_manifest(&text, token);
        // A fixed length, not chunked: a lost terminating chunk left hls.js
        // waiting out its 20 s manifest timeout. A growing EVENT playlist is
        // never edge-cached or tunnel-buffered.
        out.insert(header::CONTENT_LENGTH, HeaderValue::from(rewritten.len()));
        out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        out.insert("x-accel-buffering", HeaderValue::from_static("no"));
        let mut r = Response::new(Body::from(rewritten));
        *r.status_mut() = status;
        *r.headers_mut() = out;
        return r;
    }
    super::respond(res, Some(FORWARD_RESPONSE))
}

/// `?t=<token>` on every fetchable URI of an HLS manifest: bare relative
/// lines (segments, variant playlists) and every quoted `URI="..."` /
/// `URI='...'` attribute on any tag line (the fMP4 init map, the I-frame
/// playlist, renditions). Absolute URLs, other tags and blank lines are left
/// alone; a URI that already has a query gets `&`.
pub fn append_token_to_manifest(manifest: &str, token: &str) -> String {
    static URI_ATTR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let uri_attr = URI_ATTR.get_or_init(|| {
        regex::Regex::new(r#"URI=(?:"([^"']+)"|'([^"']+)')"#).expect("static regex")
    });
    let tokenize = |uri: &str| {
        let absolute = uri
            .get(..7)
            .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
            || uri
                .get(..8)
                .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
        if absolute {
            return uri.to_string();
        }
        let sep = if uri.contains('?') { '&' } else { '?' };
        format!("{uri}{sep}t={token}")
    };
    manifest
        .split('\n')
        .map(|line| {
            let trimmed = auth::js_trim(line);
            if trimmed.starts_with('#') && uri_attr.is_match(trimmed) {
                return uri_attr
                    .replace_all(line, |c: &regex::Captures| match (c.get(1), c.get(2)) {
                        (Some(u), _) => format!("URI=\"{}\"", tokenize(u.as_str())),
                        (_, Some(u)) => format!("URI='{}'", tokenize(u.as_str())),
                        _ => c[0].to_string(),
                    })
                    .into_owned();
            }
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return line.to_string();
            }
            tokenize(trimmed)
        })
        .collect::<Vec<_>>()
        .join("\n")
}
