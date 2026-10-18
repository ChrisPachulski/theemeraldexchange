//! The local recommender sidecar (services/recommender.ts): fire-and-forget
//! event mirrors (3 s), `/score` (15 s), the admin funnel metrics, and the
//! `/api/recommender/{event,metrics}` routes.
//!
//! Every call carries `x-recommender-secret` when configured and, when the
//! caller is known and INTERNAL_PRINCIPAL_SECRET is set, an internal-principal
//! Bearer naming who is acting. A mirror never fails its caller: a non-2xx
//! (or the synthesized 504 of an unreachable sidecar) is logged and reported
//! to telemetry, since it is silent training-signal loss.

use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::AppState;
use crate::routes::{err, ok, truthy};
use crate::stores::{Kind, positive_int};

/// The event endpoints are an INSERT and return; past this, drop the event
/// (the next interaction resends converging state).
pub const MIRROR_TIMEOUT: Duration = Duration::from_secs(3);
/// A full-library scoring call on a cold model can take seconds; a down
/// sidecar refuses the connection at once, so the ceiling costs nothing.
pub const SCORE_TIMEOUT: Duration = Duration::from_secs(15);

/// Small JSON bodies; Hono read these unbounded.
const EVENT_BODY_LIMIT: usize = 64 * 1024;

/// Who is acting, captured from the request for a call that may outlive it.
#[derive(Clone)]
pub struct Caller {
    pub principal: auth::Principal,
    pub req_id: Option<String>,
}

impl Caller {
    pub fn new(principal: &auth::Principal, headers: &HeaderMap) -> Caller {
        let id = crate::app::request_id_of(headers);
        Caller {
            principal: principal.clone(),
            req_id: (id != "-").then(|| id.to_string()),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct RecommenderError {
    pub message: String,
    /// The sidecar's status; None when it was never reached.
    pub status: Option<u16>,
}

/// The server_id the principal names, memoized after the first success
/// (resolving it writes server.db). A failure degrades this call to no
/// Bearer and is retried on the next.
pub(crate) async fn server_id(st: &AppState) -> Option<String> {
    st.server_id
        .get_or_try_init(|| auth::ensure_server_id(&st.auth.pool))
        .await
        .inspect_err(|e| {
            tracing::warn!(event = "recommender", error = %e, "ensureServerId failed; degrading to no-Bearer recommender calls");
        })
        .ok()
        .cloned()
}

async fn headers(st: &AppState, caller: Option<&Caller>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Some(v) = st
        .config
        .recommender_event_secret
        .as_deref()
        .and_then(|s| HeaderValue::from_str(s).ok())
    {
        h.insert("x-recommender-secret", v);
    }
    let secret = st.config.auth.internal_principal_secret.as_deref();
    if let (Some(caller), Some(_)) = (caller, secret)
        && let Some(server_id) = server_id(st).await
    {
        let who = crate::principal::Caller::from(&caller.principal);
        match crate::principal::mint(secret, &who, &server_id, caller.req_id.as_deref()) {
            Ok(token) => {
                if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    h.insert(header::AUTHORIZATION, v);
                }
            }
            Err(e) => {
                tracing::warn!(event = "recommender", error = %e, "failed to mint internal-principal")
            }
        }
    }
    h
}

fn url(st: &AppState, path: &str) -> String {
    format!("{}{path}", st.config.recommender_url)
}

fn head(text: &[u8]) -> String {
    auth::js_slice(&String::from_utf8_lossy(text), 200).to_string()
}

/// POST one event; never fails the caller.
pub async fn mirror(st: &AppState, path: &str, body: Value, label: &str, caller: Option<&Caller>) {
    let req = st
        .upstream
        .client()
        .post(url(st, path))
        .headers(headers(st, caller).await)
        .body(body.to_string());
    let reply = st.upstream.fetch(req, MIRROR_TIMEOUT, label).await;
    if !reply.is_success() {
        let status = reply.status.as_u16();
        tracing::warn!(event = "recommender", label, path, status, body = %head(&reply.body), "mirror POST failed");
        sentry::with_scope(
            |scope| {
                scope.set_extra("label", label.into());
                scope.set_extra("path", path.into());
                scope.set_extra("status", status.into());
            },
            || {
                sentry::capture_message(
                    &format!("recommender mirror non-ok: {label}"),
                    sentry::Level::Warning,
                )
            },
        );
    }
}

/// [`mirror`] in the background (the TS `void post...()`).
pub fn spawn_mirror(
    st: &AppState,
    path: &'static str,
    body: Value,
    label: &'static str,
    caller: Option<&Caller>,
) {
    let (st, caller) = (st.clone(), caller.cloned());
    tokio::spawn(async move { mirror(&st, path, body, label, caller.as_ref()).await });
}

/// A feedback-family event: like, dislike, clicked, added, watched.
pub fn post_feedback(
    st: &AppState,
    sub: &str,
    kind: Kind,
    tmdb_id: u64,
    signal: &str,
    caller: Option<&Caller>,
) {
    let body = json!({ "sub": sub, "kind": kind, "tmdb_id": tmdb_id, "signal": signal });
    spawn_mirror(
        st,
        "/events/feedback",
        body,
        "recommender.postFeedback",
        caller,
    );
}

pub fn post_rejection(st: &AppState, kind: Kind, tmdb_id: u64, caller: Option<&Caller>) {
    let body = json!({ "kind": kind, "tmdb_id": tmdb_id });
    spawn_mirror(
        st,
        "/events/rejection",
        body,
        "recommender.postRejection",
        caller,
    );
}

/// The recommender INSERTs one row per signal, so a toggle without an
/// explicit clear would leave both; this cancels the old one.
pub fn post_clear_feedback(
    st: &AppState,
    sub: &str,
    kind: Kind,
    tmdb_id: u64,
    signal: Option<&str>,
    caller: Option<&Caller>,
) {
    let mut body = json!({ "sub": sub, "kind": kind, "tmdb_id": tmdb_id });
    if let Some(signal) = signal {
        body["signal"] = signal.into();
    }
    spawn_mirror(
        st,
        "/events/feedback/clear",
        body,
        "recommender.postClearFeedback",
        caller,
    );
}

pub fn post_clear_rejection(st: &AppState, kind: Kind, tmdb_id: u64, caller: Option<&Caller>) {
    let body = json!({ "kind": kind, "tmdb_id": tmdb_id });
    spawn_mirror(
        st,
        "/events/rejection/clear",
        body,
        "recommender.postClearRejection",
        caller,
    );
}

/// Server-appended trending fill never passes through `/score`, so it is
/// marked shown here for the next refresh's recently-shown filter.
pub fn post_shown(st: &AppState, sub: &str, kind: Kind, tmdb_ids: &[u64], caller: Option<&Caller>) {
    if tmdb_ids.is_empty() {
        return;
    }
    let body = json!({ "sub": sub, "kind": kind, "tmdb_ids": tmdb_ids });
    spawn_mirror(st, "/events/shown", body, "recommender.postShown", caller);
}

#[derive(Clone, Debug, Serialize)]
pub struct Impression {
    pub tmdb_id: u64,
    pub rank: u32,
    pub score: f64,
    pub provenance: String,
    pub model_version: String,
}

pub fn post_impressions(
    st: &AppState,
    sub: &str,
    kind: Kind,
    items: &[Impression],
    caller: Option<&Caller>,
) {
    if items.is_empty() {
        return;
    }
    let body = json!({ "sub": sub, "kind": kind, "items": items });
    spawn_mirror(
        st,
        "/events/impressions",
        body,
        "recommender.postImpressions",
        caller,
    );
}

/// POST `/score`; the response is the caller's type.
pub async fn score_once<T: DeserializeOwned>(
    st: &AppState,
    req: &impl Serialize,
    caller: Option<&Caller>,
) -> Result<T, RecommenderError> {
    let fail = |message: String, status| RecommenderError { message, status };
    let send = async {
        let res = st
            .upstream
            .client()
            .post(url(st, "/score"))
            .headers(headers(st, caller).await)
            .json(req)
            .send()
            .await
            .map_err(|e| fail(e.without_url().to_string(), None))?;
        let status = res.status();
        let body = res
            .bytes()
            .await
            .map_err(|e| fail(e.without_url().to_string(), None))?;
        if !status.is_success() {
            let code = status.as_u16();
            return Err(fail(
                format!("recommender /score {code}: {}", head(&body)),
                Some(code),
            ));
        }
        serde_json::from_slice(&body).map_err(|e| fail(e.to_string(), None))
    };
    tokio::time::timeout(SCORE_TIMEOUT, send)
        .await
        .unwrap_or_else(|_| Err(fail("This operation was aborted".into(), None)))
}

/// The admin funnel (impressions to added/clicked plus dot feedback). The
/// caller needs the payload, so this fails instead of swallowing; the body
/// passes through as the sidecar wrote it once it parses as JSON.
pub async fn funnel_metrics(
    st: &AppState,
    window_days: f64,
    caller: Option<&Caller>,
) -> Result<Bytes, RecommenderError> {
    let wd = clamp_window(window_days);
    let req = st
        .upstream
        .client()
        .get(url(st, &format!("/metrics/funnel?window_days={wd}")))
        .headers(headers(st, caller).await);
    let reply = st
        .upstream
        .fetch(req, SCORE_TIMEOUT, "recommender.getFunnelMetrics")
        .await;
    if !reply.is_success() {
        let code = reply.status.as_u16();
        return Err(RecommenderError {
            message: format!("funnel metrics {code}: {}", head(&reply.body)),
            status: Some(code),
        });
    }
    serde_json::from_slice::<serde::de::IgnoredAny>(&reply.body).map_err(|e| RecommenderError {
        message: e.to_string(),
        status: None,
    })?;
    Ok(reply.body)
}

/// floor, then 1..=365; NaN or infinite is 30.
fn clamp_window(n: f64) -> i64 {
    if n.is_finite() {
        (n.floor() as i64).clamp(1, 365)
    } else {
        30
    }
}

// --- /api/recommender --------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/recommender/event", post(event))
        .route("/api/recommender/metrics", get(metrics))
}

/// Admin-only, read-only funnel observability.
async fn metrics(
    State(st): State<AppState>,
    auth::RequireAdmin(p): auth::RequireAdmin,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    if !st.config.use_local_recommender {
        return err(StatusCode::SERVICE_UNAVAILABLE, "recommender_disabled");
    }
    let raw = q
        .iter()
        .find(|(k, _)| k == "windowDays")
        .map_or(30.0, |(_, v)| crate::routes::js_str_number(v));
    match funnel_metrics(&st, raw, Some(&Caller::new(&p, &headers))).await {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(e) => {
            #[derive(Serialize)]
            struct Unavailable {
                error: &'static str,
                detail: String,
            }
            let body = Unavailable {
                error: "metrics_unavailable",
                detail: e.message,
            };
            (StatusCode::BAD_GATEWAY, axum::Json(body)).into_response()
        }
    }
}

/// Mirrors the one client-side signal with no other delivery path: a click
/// on a suggestion card. 'added' fires server-side once the *arr confirms,
/// and like/dislike go through /api/feedback's household-veto rules, so the
/// signal list is locked to 'clicked'.
async fn event(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let raw = match auth::json_body(body, EVENT_BODY_LIMIT).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !truthy(&raw) {
        return err(StatusCode::BAD_REQUEST, "invalid_body");
    }
    let Some(kind) = raw
        .get("kind")
        .and_then(Value::as_str)
        .and_then(Kind::parse)
    else {
        return err(StatusCode::BAD_REQUEST, "invalid_kind");
    };
    let Some(tmdb_id) = raw.get("tmdbId").and_then(positive_int) else {
        return err(StatusCode::BAD_REQUEST, "invalid_tmdbId");
    };
    if raw.get("signal").and_then(Value::as_str) != Some("clicked") {
        return err(StatusCode::BAD_REQUEST, "invalid_signal");
    }
    // Validation runs either way; the sidecar sees traffic only when on.
    if st.config.use_local_recommender {
        let caller = Caller::new(&p, &headers);
        post_feedback(&st, &p.session.sub, kind, tmdb_id, "clicked", Some(&caller));
    }
    ok()
}

#[cfg(test)]
mod tests;
