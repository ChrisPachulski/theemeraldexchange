//! The streaming proxies to the internal services: /api/media (media-core),
//! /api/transcode (transcoder HLS), /api/iptv and /api/dvr (the iptv
//! service). The gateway decides who may reach them; [`Proxy::send`] is the
//! one forwarder: request headers from an allowlist plus an internal
//! principal, a time-to-first-byte deadline only (a byte stream then runs as
//! long as the viewer watches), redirects never followed, and the response
//! body passed through unbuffered. A client that hangs up drops the body,
//! which closes the upstream socket: that is how the services learn to free a
//! stream slot. A timeout or connect error is 504 `{error, service}`.

#[cfg(test)]
pub(crate) mod fake;
#[cfg(test)]
mod goldens;
pub mod iptv;
pub mod media;
pub mod transcode;

use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::AppState;
use crate::principal::Caller;
use crate::routes::err;

/// media-core and the transcoder answer headers within the LAN budget.
pub const MEDIA_TTFB: Duration = Duration::from_secs(15);
/// A live grant can sit behind the 15 s panel probe and a raw tune behind
/// the upstream drain wait.
pub const IPTV_TTFB: Duration = Duration::from_secs(60);

pub struct Timings {
    /// How long a playback grant waits for the transcoder's first segment
    /// (wall clock: a slow probe counts against it).
    pub ready_deadline: Duration,
    pub ready_poll: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            ready_deadline: Duration::from_secs(12),
            ready_poll: Duration::from_millis(500),
        }
    }
}

pub struct Proxy {
    client: reqwest::Client,
    pub timings: Timings,
}

impl Default for Proxy {
    fn default() -> Self {
        Proxy::new(Timings::default())
    }
}

impl Proxy {
    pub fn new(timings: Timings) -> Proxy {
        Proxy {
            // The services never redirect; a redirect is never followed to
            // wherever it points.
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("static client config"),
            timings,
        }
    }

    /// Send and wait for the response headers only (`ttfb`).
    pub async fn send(
        &self,
        service: &'static str,
        method: Method,
        url: &str,
        headers: HeaderMap,
        body: Option<Bytes>,
        ttfb: Duration,
    ) -> Result<reqwest::Response, Response> {
        let mut req = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            req = req.body(body);
        }
        match tokio::time::timeout(ttfb, req.send()).await {
            Ok(Ok(res)) => Ok(res),
            // without_url: the URL carries the client's ?t=/?u= stream token.
            Ok(Err(e)) => Err(upstream_down(
                service,
                "upstream_unreachable",
                &e.without_url(),
            )),
            Err(_) => Err(upstream_down(
                service,
                "upstream_timeout",
                &"This operation was aborted",
            )),
        }
    }
}

fn upstream_down(service: &str, reason: &str, e: &dyn std::fmt::Display) -> Response {
    tracing::error!(event = "proxy", "{service} {reason}: {e}");
    (
        StatusCode::GATEWAY_TIMEOUT,
        Json(json!({ "error": reason, "service": service })),
    )
        .into_response()
}

/// The upstream response streamed back: every header but the hop-by-hop
/// ones (`allow` None), or only `allow` with an octet-stream default type.
pub fn respond(res: reqwest::Response, allow: Option<&[&str]>) -> Response {
    let status = res.status();
    let mut out = HeaderMap::new();
    match allow {
        None => {
            for (name, value) in res.headers() {
                if !HOP_BY_HOP.contains(&name.as_str()) {
                    out.append(name.clone(), value.clone());
                }
            }
        }
        Some(names) => {
            copy(res.headers(), &mut out, names);
            out.entry(header::CONTENT_TYPE)
                .or_insert(HeaderValue::from_static("application/octet-stream"));
        }
    }
    let mut r = Response::new(Body::from_stream(res.bytes_stream()));
    *r.status_mut() = status;
    *r.headers_mut() = out;
    r
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

/// Copy each named header that is present and non-empty.
pub fn copy(src: &HeaderMap, dst: &mut HeaderMap, names: &[&str]) {
    for name in names {
        if let Some(v) = src.get(*name).filter(|v| !v.is_empty()) {
            dst.insert(
                HeaderName::from_bytes(name.as_bytes()).expect("static name"),
                v.clone(),
            );
        }
    }
}

/// A verified stream token's holder: playback never needs admin, and the
/// auth mode is the sub's provider.
pub fn token_caller(sub: &str) -> Caller<'_> {
    Caller {
        sub,
        role: "user",
        auth_mode: sub.split(':').next().unwrap_or_default(),
        device_id: None,
    }
}

/// `Bearer <principal>` for an internal-service call as `caller`, or None in
/// the dev posture (no INTERNAL_PRINCIPAL_SECRET, or server_id unresolved).
/// A failed mint is the 502 `principal_mint_failed`: never forward
/// unauthenticated when a principal is expected.
pub async fn principal(
    st: &AppState,
    caller: &Caller<'_>,
    req_id: Option<&str>,
) -> Result<Option<HeaderValue>, Response> {
    let secret = st.config.auth.internal_principal_secret.as_deref();
    if secret.is_none() {
        return Ok(None);
    }
    let Some(server_id) = crate::recommender::server_id(st).await else {
        return Ok(None);
    };
    crate::principal::mint(secret, caller, &server_id, req_id)
        .ok()
        .and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok())
        .map(Some)
        .ok_or_else(|| {
            tracing::error!(
                event = "proxy",
                "failed to mint internal-principal, failing closed"
            );
            err(StatusCode::BAD_GATEWAY, "principal_mint_failed")
        })
}

/// The inbound request id for the principal (absent only outside the edge).
pub fn req_id(headers: &HeaderMap) -> Option<&str> {
    Some(crate::app::request_id_of(headers)).filter(|id| *id != "-")
}

/// `401 access_revoked` unless `sub` is an allowed member (re-checked on every
/// tokened request, so a revocation reaches an already-minted grant).
pub async fn require_member(st: &AppState, sub: &str) -> Result<(), Response> {
    match auth::member_status(&st.auth.pool, &st.config.auth.admin_subs, sub).await {
        Ok(auth::members::MemberStatus::Allowed) => Ok(()),
        Ok(_) => Err(err(StatusCode::UNAUTHORIZED, "access_revoked")),
        Err(e) => Err(e.into_response()),
    }
}

/// The query re-serialized as URLSearchParams does, minus every `t` (the
/// services authenticate by the principal, not the stream token); empty, or
/// `?...`.
pub fn query_without_token(uri: &Uri) -> String {
    let pairs: Vec<(String, String)> = crate::arr::shared::query_pairs(uri)
        .into_iter()
        .filter(|(k, _)| k != "t")
        .collect();
    if pairs.is_empty() {
        return String::new();
    }
    let mut url = reqwest::Url::parse("http://q/").expect("static url");
    url.query_pairs_mut().extend_pairs(pairs);
    format!("?{}", url.query().unwrap_or_default())
}

/// JS `decodeURIComponent`: None on a malformed escape or invalid UTF-8.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// JS `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// An iptv `/internal/*` call (the service answers these only for an admin
/// principal, so one is minted for `sub`). The error text never carries the
/// path: it names the member and lands in logs.
pub async fn iptv_internal(
    st: &AppState,
    method: Method,
    path: &str,
    sub: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let label = method.to_string();
    let mut req = st
        .upstream
        .client()
        .request(method, format!("{}{path}", st.config.auth.iptv_service_url));
    if let Some(body) = body {
        req = req
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    let admin = Caller {
        role: "admin",
        ..token_caller(sub)
    };
    if let Some(bearer) = principal(st, &admin, None)
        .await
        .map_err(|_| "failed to mint internal-principal".to_string())?
    {
        req = req.header(header::AUTHORIZATION, bearer);
    }
    let call = async {
        let res = req.send().await.map_err(|e| e.without_url().to_string())?;
        if !res.status().is_success() {
            return Err(format!(
                "iptv internal {label} answered {}",
                res.status().as_u16()
            ));
        }
        res.json::<Value>()
            .await
            .map_err(|e| e.without_url().to_string())
    };
    tokio::time::timeout(timeout, call)
        .await
        .map_err(|_| "The operation was aborted due to timeout".to_string())?
}

#[cfg(test)]
mod tests;
