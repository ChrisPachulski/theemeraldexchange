//! The edge (server/app.ts): the layers every request crosses, the edge
//! routes (/api/health, /api/limits, /api/version) and the fallback.
//!
//! Layers, outermost first: dot-segment normalization, X-Request-Id, the
//! redacting request logger, the anti-framing headers, CORS, CSRF, the 1 MiB
//! control-body limit on the sidecar proxies, the panic catcher; then the
//! routes, the JSON 404 for /api/* and the SPA.

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::FutureExt;
use http_body_util::{BodyExt, Limited};
use regex::Regex;
use serde::Serialize;
use serde_json::json;
use sqlx::ConnectOptions;
use sqlx::sqlite::SqliteConnectOptions;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::AppState;

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// The media/transcode/iptv/dvr proxies buffer control-plane bodies before
/// forwarding them; playback bytes travel in responses and are unaffected.
pub const SIDECAR_CONTROL_BODY_LIMIT: usize = 1024 * 1024;
const LIMITED_PREFIXES: &[&str] = &["/api/media", "/api/transcode", "/api/iptv", "/api/dvr"];

/// The whole public surface.
pub fn router(state: AppState) -> Router {
    let routes = Router::new()
        .route("/api/health", get(health))
        .route("/api/limits", get(limits))
        .route("/api/version", get(version))
        .merge(crate::routes::router())
        .merge(crate::arr::router())
        .merge(crate::tmdb::router())
        .merge(crate::suggestions::router(&state))
        .merge(crate::usage::router())
        .merge(crate::account::router())
        .merge(crate::plex::router())
        .merge(crate::telemetry::router())
        .merge(crate::proxy::iptv::router(&state))
        .merge(media_routes(&state))
        .with_state(state.clone())
        .merge(auth::router(state.auth.clone()));
    edge(routes, &state)
}

/// /api/media and /api/transcode only with USE_MEDIA_CORE: without
/// media-core there is nothing to hand off to, except that TMDB artwork
/// (posters across discovery and the watchlist) still loads, from the CDN.
fn media_routes(state: &AppState) -> Router<AppState> {
    if !state.config.use_media_core {
        return Router::new().route("/api/media/images/tmdb/{name}", get(tmdb_cdn));
    }
    crate::proxy::media::router().merge(crate::proxy::transcode::router())
}

/// `GET /api/media/images/tmdb/{name}?w=` without media-core: a redirect to
/// the TMDB CDN at the smallest size covering `w`, so the browser loads it
/// straight from TMDB as it did before media-core held the artwork. The
/// name is checked as media-core checks it (`^[A-Za-z0-9]{1,64}\.(jpg|png)$`).
async fn tmdb_cdn(
    axum::extract::Path(name): axum::extract::Path<String>,
    uri: axum::http::Uri,
) -> Response {
    let valid = name.split_once('.').is_some_and(|(stem, ext)| {
        (1..=64).contains(&stem.len())
            && stem.bytes().all(|b| b.is_ascii_alphanumeric())
            && matches!(ext, "jpg" | "png")
    });
    if !valid {
        return not_found().await;
    }
    let pairs = crate::arr::shared::query_pairs(&uri);
    let w = crate::arr::shared::query_first(&pairs, "w").and_then(|w| w.parse::<u32>().ok());
    let size = match w.unwrap_or(500) {
        0..=92 => "w92",
        93..=185 => "w185",
        186..=342 => "w342",
        343..=500 => "w500",
        501..=780 => "w780",
        _ => "original",
    };
    axum::response::Redirect::temporary(&format!("https://image.tmdb.org/t/p/{size}/{name}"))
        .into_response()
}

/// Fallbacks and layers around `routes`.
pub(crate) fn edge(routes: Router, state: &AppState) -> Router {
    let spa = state.spa_dir.clone();
    let inner = routes
        .fallback(move |req: Request| fallback(spa.clone(), req))
        // Hono answered a known path's wrong method with its 404 too.
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn(catch_panic))
        .layer(middleware::from_fn(body_limit))
        .layer(middleware::from_fn_with_state(
            state.auth.config.clone(),
            auth::csrf::require_safe_origin,
        ))
        .layer(tower::util::option_layer(cors(
            &state.config.auth.allowed_origins,
        )))
        .layer(middleware::from_fn(preflight_no_content))
        .layer(middleware::from_fn(frame_headers))
        .layer(middleware::from_fn(request_log))
        .layer(middleware::from_fn(request_id));
    // Normalized before routing: a Router layer runs after the route is
    // picked, so `/api/iptv/stream/..\playlist.m3u` would reach the stream
    // handler and skip the playlist's own gates.
    Router::new().fallback_service(
        tower::ServiceBuilder::new()
            .layer(middleware::from_fn(normalize_path))
            .service(inner),
    )
}

/// Dot segments resolved as the WHATWG URL parser does (`.`, `..` and their
/// `%2e` spellings), before anything routes or logs: Hono only ever saw the
/// parsed URL. Without it `/api/transcode/session/x/../../grant` would pass
/// the control-path block, then collapse to `/grant` in the forward URL.
async fn normalize_path(mut req: Request, next: Next) -> Response {
    if let Some(path) = remove_dot_segments(req.uri().path()) {
        let pq = match req.uri().query() {
            Some(q) => format!("{path}?{q}"),
            None => path,
        };
        let mut parts = req.uri().clone().into_parts();
        match pq.parse() {
            Ok(pq) => parts.path_and_query = Some(pq),
            Err(_) => return not_found().await,
        }
        match axum::http::Uri::from_parts(parts) {
            Ok(uri) => *req.uri_mut() = uri,
            Err(_) => return not_found().await,
        }
    }
    next.run(req).await
}

/// The path without dot segments, or None when it has none.
pub(crate) fn remove_dot_segments(path: &str) -> Option<String> {
    // The WHATWG parser reads '\' as '/' in an http path (Hono's view, and
    // reqwest's on the forward URL), so every gate must see it that way too.
    if path.contains('\\') {
        let slashed = path.replace('\\', "/");
        return Some(remove_dot_segments(&slashed).unwrap_or(slashed));
    }
    let single = |s: &str| s == "." || s.eq_ignore_ascii_case("%2e");
    let double = |s: &str| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            ".." | ".%2e" | "%2e." | "%2e%2e"
        )
    };
    let segs: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
    if !segs.iter().any(|s| single(s) || double(s)) {
        return None;
    }
    let mut out: Vec<&str> = vec![];
    for (i, s) in segs.iter().enumerate() {
        let last = i + 1 == segs.len();
        if double(s) {
            out.pop();
        } else if !single(s) {
            out.push(s);
            continue;
        }
        if last {
            out.push("");
        }
    }
    Some(format!("/{}", out.join("/")))
}

/// Honour an inbound X-Request-Id that passes Hono's rule (word characters,
/// `-` and `=`, at most 255), else a fresh UUID. Written back onto the request
/// so the logger, auth_outcome and the handlers all read the same id, and
/// echoed on the response.
async fn request_id(mut req: Request, next: Next) -> Response {
    let valid = |v: &&str| {
        !v.is_empty()
            && v.len() <= 255
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'='))
    };
    let id = req
        .headers()
        .get(&X_REQUEST_ID)
        .and_then(|v| v.to_str().ok())
        .filter(valid)
        .map(String::from)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let value = HeaderValue::from_str(&id).expect("validated or a uuid");
    req.headers_mut().insert(X_REQUEST_ID, value.clone());
    let mut res = next.run(req).await;
    res.headers_mut().insert(X_REQUEST_ID, value);
    res
}

pub(crate) fn request_id_of(headers: &HeaderMap) -> &str {
    headers
        .get(&X_REQUEST_ID)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-")
}

/// Playback grants and stray login requests put credentials in the URL;
/// the logged path never carries them, even for a request that is refused.
fn secret_query() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)([?&](?:t|u|token|pinId|invite|inviteCode|invite_code|code|idToken|id_token)=)[^&\s]+",
        )
        .expect("static regex")
    })
}

pub fn redact_request_secrets(line: &str) -> String {
    secret_query()
        .replace_all(line, "${1}[redacted]")
        .into_owned()
}

/// `<-- METHOD path [id] ua="..."` and `--> METHOD path status Nms [id]`. The
/// user agent is what tells the web SPA from the Apple apps in a playback
/// timeline: quotes and line breaks dropped, 120 UTF-16 units at most.
async fn request_log(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = redact_request_secrets(
        req.uri()
            .path_and_query()
            .map_or_else(|| req.uri().path(), |p| p.as_str()),
    );
    let id = request_id_of(req.headers()).to_string();
    let ua = user_agent(req.headers());
    tracing::info!("<-- {method} {path} [{id}] ua=\"{ua}\"");
    let start = Instant::now();
    let res = next.run(req).await;
    tracing::info!(
        "--> {method} {path} {} {}ms [{id}]",
        res.status().as_u16(),
        start.elapsed().as_millis()
    );
    res
}

fn user_agent(headers: &HeaderMap) -> String {
    let Some(raw) = headers.get(header::USER_AGENT) else {
        return "-".into();
    };
    let mut units = 0;
    String::from_utf8_lossy(raw.as_bytes())
        .chars()
        .filter(|c| !matches!(c, '"' | '\r' | '\n'))
        .take_while(|c| {
            units += c.len_utf16();
            units <= 120
        })
        .collect()
}

/// SameSite=None cookies (split SPA/API) need the CSRF gate for requests and
/// these headers so a hostile parent page cannot frame the signed-in UI.
async fn frame_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    res
}

/// Only with ALLOWED_ORIGINS (the split Netlify/API deployment). Authorization
/// carries the Apple Bearer; X-App-Version the device's build; Retry-After is
/// not CORS-safelisted, and the SPA honours it.
fn cors(origins: &[String]) -> Option<CorsLayer> {
    if origins.is_empty() {
        return None;
    }
    let origins: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o).ok())
        .collect();
    Some(
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_credentials(true)
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                header::CONTENT_TYPE,
                HeaderName::from_static("x-eex-expected-sub"),
                header::AUTHORIZATION,
                HeaderName::from_static("x-app-version"),
            ])
            .expose_headers([header::RETRY_AFTER, X_REQUEST_ID]),
    )
}

/// tower-http answers a preflight 200; Hono said 204 (both are an ok
/// status to a browser). Without CORS an OPTIONS is the 404.
async fn preflight_no_content(req: Request, next: Next) -> Response {
    let preflight = req.method() == Method::OPTIONS;
    let mut res = next.run(req).await;
    if preflight && res.status() == StatusCode::OK {
        *res.status_mut() = StatusCode::NO_CONTENT;
    }
    res
}

/// Buffer a control body on the sidecar prefixes, refusing past 1 MiB (by
/// Content-Length up front, or as a chunked body arrives).
async fn body_limit(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let limited = LIMITED_PREFIXES.iter().any(|p| {
        path.strip_prefix(p)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    });
    if !limited {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    match Limited::new(body, SIDECAR_CONTROL_BODY_LIMIT)
        .collect()
        .await
    {
        Ok(bytes) => {
            next.run(Request::from_parts(parts, Body::from(bytes.to_bytes())))
                .await
        }
        Err(_) => (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "payload_too_large" })),
        )
            .into_response(),
    }
}

/// A handler panic is logged with the request id (sentry-tracing reports it)
/// and answers a generic 500; the detail never reaches the client.
async fn catch_panic(req: Request, next: Next) -> Response {
    let id = request_id_of(req.headers()).to_string();
    match AssertUnwindSafe(next.run(req)).catch_unwind().await {
        Ok(res) => res,
        Err(panic) => {
            let detail = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            tracing::error!(event = "unhandled", request_id = %id, detail, "unhandled error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal" })),
            )
                .into_response()
        }
    }
}

/// The built SPA for GET/HEAD outside /api (unknown paths get index.html, so
/// deep links work); everything else is the JSON 404, never a 200 text/html.
async fn fallback(spa: Option<PathBuf>, req: Request) -> Response {
    if let Some(dir) = spa
        && matches!(*req.method(), Method::GET | Method::HEAD)
        && !req.uri().path().starts_with("/api")
    {
        let serve = ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html")));
        return match serve.oneshot(req).await {
            Ok(res) => res.into_response(),
            Err(never) => match never {},
        };
    }
    not_found().await
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response()
}

/// Liveness for the docker healthcheck and cloudflared: probes server.db
/// (the one critical local dependency), never a remote sidecar.
async fn health(State(st): State<AppState>) -> Response {
    match sqlx::query("SELECT 1").execute(&st.auth.pool).await {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => {
            tracing::error!(event = "health", message = %e, "server.db probe failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false, "reason": "db_unavailable" })),
            )
                .into_response()
        }
    }
}

/// The configured limits and capability flags, for the SPA and the apps.
/// Public except the root-folder paths (host filesystem layout), which need
/// a valid session cookie.
async fn limits(State(st): State<AppState>, headers: HeaderMap) -> Response {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Limits<'a> {
        min_free_gb: serde_json::Number,
        max_movie_gb: serde_json::Number,
        max_tv_gb_per_episode: serde_json::Number,
        use_local_recommender: bool,
        default_profile_name: &'a str,
        default_sonarr_root_folder_path: Option<&'a str>,
        default_radarr_root_folder_path: Option<&'a str>,
        iptv_enabled: bool,
        media_enabled: bool,
        music_enabled: bool,
        youtube_enabled: bool,
        sonarr_enabled: bool,
        radarr_enabled: bool,
        sab_enabled: bool,
        account_deletion_enabled: bool,
        dvr_enabled: bool,
    }
    let c = &st.config;
    let signed_in = auth::session::read_cookie(&headers)
        .and_then(|t| {
            auth::session::verify(&st.auth.session_key, t, chrono::Utc::now().timestamp())
        })
        .is_some();
    Json(Limits {
        min_free_gb: js_number(c.min_free_gb),
        max_movie_gb: js_number(c.max_movie_gb),
        max_tv_gb_per_episode: js_number(c.max_tv_gb_per_episode),
        use_local_recommender: c.use_local_recommender,
        default_profile_name: &c.default_profile_name,
        default_sonarr_root_folder_path: c
            .default_sonarr_root_folder_path
            .as_deref()
            .filter(|_| signed_in),
        default_radarr_root_folder_path: c
            .default_radarr_root_folder_path
            .as_deref()
            .filter(|_| signed_in),
        iptv_enabled: !c.auth.iptv_disabled,
        media_enabled: c.use_media_core,
        music_enabled: c.use_media_core && c.music_roots_configured,
        youtube_enabled: c.use_media_core && c.youtube_roots_configured,
        sonarr_enabled: c.sonarr_enabled(),
        radarr_enabled: c.radarr_enabled(),
        sab_enabled: c.sab_enabled(),
        account_deletion_enabled: true,
        dvr_enabled: c.dvr_mounted(),
    })
    .into_response()
}

/// A JS number on the wire: 100, not 100.0.
pub(crate) fn js_number(n: f64) -> serde_json::Number {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        (n as i64).into()
    } else {
        serde_json::Number::from_f64(n).expect("config numbers are finite")
    }
}

/// Public and minimal (contract §12.3): the server_id for Keychain keying,
/// which sign-ins this install offers, whether it pairs devices, and the
/// recommender/media schema levels for client compatibility checks.
async fn version(State(st): State<AppState>) -> Result<Response, auth::Error> {
    #[derive(Serialize)]
    struct Version<'a> {
        server_id: String,
        release: &'a str,
        auth_modes: Vec<&'static str>,
        accepting_device_pairs: bool,
        schemas: Schemas,
    }
    #[derive(Serialize)]
    struct Schemas {
        exchange: SchemaState,
        media: SchemaState,
    }
    let c = &st.config;
    let auth_modes = [
        ("plex", c.auth.plex_configured()),
        ("apple", c.auth.apple_configured()),
        ("google", c.auth.google_configured()),
        ("workos", c.auth.workos_configured()),
    ]
    .into_iter()
    .filter_map(|(mode, on)| on.then_some(mode))
    .collect();
    Ok(Json(Version {
        server_id: auth::ensure_server_id(&st.auth.pool).await?,
        release: &c.release,
        auth_modes,
        accepting_device_pairs: c.auth.device_token_secret.is_some(),
        schemas: Schemas {
            exchange: schema_state(&c.recommender_db_path).await,
            media: schema_state(&c.media_db_path).await,
        },
    })
    .into_response())
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum SchemaState {
    /// The file is missing or unreadable.
    Absent { present: bool },
    /// MAX(version), null when the ledger table is missing or empty.
    Level { current: Option<i64> },
}

/// Opened read-only and never created: the gateway owns neither DB.
pub(crate) async fn schema_state(path: &str) -> SchemaState {
    let absent = SchemaState::Absent { present: false };
    let Ok(mut conn) = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
    else {
        return absent;
    };
    let level = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM schema_migrations")
        .fetch_one(&mut conn)
        .await;
    let _ = sqlx::Connection::close(conn).await;
    match level {
        Ok(current) => SchemaState::Level { current },
        Err(e) if e.to_string().contains("no such table: schema_migrations") => {
            SchemaState::Level { current: None }
        }
        Err(_) => absent,
    }
}

#[cfg(test)]
mod tests;
