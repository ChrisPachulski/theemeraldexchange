//! CSRF defense as axum layers. Port of middleware/csrf.ts.
//!
//! Session cookies are SameSite=None in prod (the SPA and the API live on
//! different origins), so a browser attaches them to any cross-site request.
//! A state-changing request must therefore carry an Origin from
//! ALLOWED_ORIGINS, or the request's own host. Reads pass: serving a GET to a
//! forged origin leaks nothing. The few GETs with side effects (the
//! suggestions route writes recently_shown) mount [`require_trusted_origin`].
//!
//! Mount with `axum::middleware::from_fn_with_state(config, require_safe_origin)`.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::config::Config;

/// Cookieless, Origin-less token-mint endpoints the native app calls before it
/// holds any token. No ambient credential rides them, so they pass; any Origin
/// marks a browser and gets the normal check. The cookie-authed
/// /device/link/claim stays gated.
const NATIVE_BOOTSTRAP_PATHS: &[&str] = &[
    "/api/auth/apple",
    "/api/auth/google",
    "/api/auth/device/link/start",
    "/api/auth/device/link/poll",
    "/api/auth/workos/native/start",
    "/api/auth/workos/native",
];

/// The routes that authenticate by a `?t=` stream token. Scoped: an unscoped
/// exemption would disarm the gate on the cookie-minting auth POSTs.
const TOKEN_AUTH_PREFIXES: &[&str] = &["/api/transcode/session/"];

/// The global gate: POST/PUT/PATCH/DELETE need a trusted Origin unless they
/// carry no ambient credential (Bearer-only, `?t=`-only on a token route, or a
/// native bootstrap).
pub async fn require_safe_origin(
    State(config): State<Arc<Config>>,
    req: Request,
    next: Next,
) -> Response {
    let state_changing = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if !state_changing
        || bearer_only(req.headers())
        || stream_token_only(req.uri(), req.headers())
        || native_bootstrap(req.uri(), req.headers())
    {
        return next.run(req).await;
    }
    gate(&config, req, next).await
}

/// The same check for every method: for read routes with side effects.
pub async fn require_trusted_origin(
    State(config): State<Arc<Config>>,
    req: Request,
    next: Next,
) -> Response {
    if bearer_only(req.headers()) {
        return next.run(req).await;
    }
    gate(&config, req, next).await
}

async fn gate(config: &Config, req: Request, next: Next) -> Response {
    let origin = header_str(req.headers(), header::ORIGIN);
    if same_host(origin, header_str(req.headers(), header::HOST)) {
        return next.run(req).await;
    }
    match origin_rejection(config, origin) {
        None => next.run(req).await,
        Some(reason) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden", "reason": reason })),
        )
            .into_response(),
    }
}

/// The trimmed value, as Fetch Headers hands it to Hono. Non-ASCII reads as
/// absent.
fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_matches([' ', '\t']))
}

/// A non-empty Cookie header (Hono's truthy `c.req.header('cookie')`).
fn has_cookie_value(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::COOKIE)
        .iter()
        .any(|v| !v.as_bytes().trim_ascii().is_empty())
}

/// `Authorization: Bearer` and no cookie: a browser never auto-attaches an
/// Authorization header, so there is nothing for a forged request to ride. A
/// Bearer beside a cookie stays gated.
fn bearer_only(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .is_some_and(|v| v.as_bytes().trim_ascii().starts_with(b"Bearer "))
        && !has_cookie_value(headers)
}

/// A non-empty first `t` query value, no cookie, on a token-authed route.
fn stream_token_only(uri: &Uri, headers: &HeaderMap) -> bool {
    let token = uri.query().and_then(|q| {
        q.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k == "t").then_some(v)
        })
    });
    token.is_some_and(|t| !t.is_empty())
        && !has_cookie_value(headers)
        && TOKEN_AUTH_PREFIXES
            .iter()
            .any(|p| uri.path().starts_with(p))
}

/// Presence, not value: an empty Cookie or Origin header still disqualifies.
fn native_bootstrap(uri: &Uri, headers: &HeaderMap) -> bool {
    !headers.contains_key(header::COOKIE)
        && !headers.contains_key(header::ORIGIN)
        && NATIVE_BOOTSTRAP_PATHS.contains(&uri.path())
}

/// The Origin's host (`new URL(origin).host`: lowercased, default port
/// dropped) equals the Host header. A hostile page cannot make the browser
/// stamp the target's own origin. The scheme is ignored so a TLS-terminating
/// sidecar in front of plain-http still matches.
fn same_host(origin: Option<&str>, host: Option<&str>) -> bool {
    let (Some(origin), Some(host)) = (origin, host) else {
        return false;
    };
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let (Some(scheme), Some(name)) = (uri.scheme_str(), uri.host()) else {
        return false;
    };
    let default_port = match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        _ => None,
    };
    let origin_host = match uri.port_u16() {
        Some(p) if Some(p) != default_port => format!("{}:{p}", name.to_ascii_lowercase()),
        _ => name.to_ascii_lowercase(),
    };
    origin_host == host
}

/// None when the Origin is trusted. An empty allowlist passes in dev (the Vite
/// proxy is same-origin) and fails closed in production, behind config's own
/// boot check.
fn origin_rejection(config: &Config, origin: Option<&str>) -> Option<&'static str> {
    if config.allowed_origins.is_empty() {
        return config.is_prod.then_some("csrf_misconfigured");
    }
    match origin {
        Some(o) if config.allowed_origins.iter().any(|a| a == o) => None,
        _ => Some("bad_origin"),
    }
}

#[cfg(test)]
mod tests;
