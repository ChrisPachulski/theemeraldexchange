//! The HTTP surface of `recommender/app/main.py`: /health, /score, /events/*
//! and /metrics/funnel. Every route but /health
//! sits behind the x-recommender-secret gate; /score and the event writers verify
//! the internal-principal Bearer the gateway mints.
//!
//! Checks run in FastAPI's order: an unparsable JSON body is a 422 before
//! anything else, then the secret gate, then the principal, then the body
//! schema (422), then the handler (403 on a sub mismatch in enforce).

pub mod events;
pub mod score;
pub mod validate;

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{DefaultBodyLimit, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use emerald_contracts::internal_principal::InternalClaims;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;

use crate::config::{Config, PrincipalMode};
use validate::Body;

/// FastAPI read bodies unbounded; the largest real one (a /score library of
/// 5000 items) is well under this.
const BODY_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub caches: Arc<crate::recipes::Caches>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/metrics/funnel", get(funnel))
        .route("/score", post(score::score))
        .route("/events/feedback", post(events::feedback))
        .route("/events/feedback/clear", post(events::clear_feedback))
        .route("/events/shown", post(events::shown))
        .route("/events/impressions", post(events::impressions))
        .route("/events/rejection", post(events::rejection))
        .route("/events/rejection/clear", post(events::clear_rejection))
        .fallback(|| async { ApiError::Detail(StatusCode::NOT_FOUND, "Not Found".into()) })
        .method_not_allowed_fallback(|| async {
            ApiError::Detail(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed".into())
        })
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(state)
}

#[derive(Debug)]
pub enum ApiError {
    /// FastAPI's HTTPException: `{"detail": "..."}`.
    Detail(StatusCode, String),
    /// A request validation error: 422 `{"detail": [...]}`.
    Invalid(validate::Errors),
    Internal(String),
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<crate::Error> for ApiError {
    fn from(e: crate::Error) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Detail(status, detail) => {
                (status, Json(json!({ "detail": detail }))).into_response()
            }
            ApiError::Invalid(errors) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(json!({ "detail": errors })),
            )
                .into_response(),
            ApiError::Internal(e) => {
                tracing::error!("recommender request failed: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error").into_response()
            }
        }
    }
}

fn mode_name(mode: &PrincipalMode) -> &'static str {
    match mode {
        PrincipalMode::Off => "off",
        PrincipalMode::Log => "log",
        PrincipalMode::Enforce => "enforce",
    }
}

/// Constant-time compare of x-recommender-secret; false when no secret is set.
fn secret_matches(config: &Config, headers: &HeaderMap) -> bool {
    match (
        config.event_secret.as_deref(),
        headers.get("x-recommender-secret"),
    ) {
        (Some(expected), Some(got)) => got.as_bytes().ct_eq(expected.as_bytes()).into(),
        _ => false,
    }
}

pub fn require_event_secret(config: &Config, headers: &HeaderMap) -> Result<(), ApiError> {
    if config.event_secret.is_none() {
        return Err(ApiError::Detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "event secret is not configured".into(),
        ));
    }
    if !secret_matches(config, headers) {
        return Err(ApiError::Detail(
            StatusCode::UNAUTHORIZED,
            "invalid event secret".into(),
        ));
    }
    Ok(())
}

/// Python `str.split(None, 1)` on the header, scheme matched case-insensitively.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    // Starlette decoded header values as latin-1.
    let raw: String = headers
        .get(header::AUTHORIZATION)?
        .as_bytes()
        .iter()
        .map(|&b| b as char)
        .collect();
    let space = |c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c);
    let rest = raw.trim_start_matches(space);
    let (scheme, token) = rest.split_once(space)?;
    let token = token.trim_matches(space);
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then(|| token.to_string())
}

/// The internal-principal dependency: off ignores the header, log verifies and
/// never blocks, enforce answers 401 (503 without the secret).
pub fn principal(config: &Config, headers: &HeaderMap) -> Result<Option<InternalClaims>, ApiError> {
    let enforce = match config.principal_mode {
        PrincipalMode::Off => return Ok(None),
        PrincipalMode::Log => false,
        PrincipalMode::Enforce => true,
    };
    let unauthorized = |detail: String| Err(ApiError::Detail(StatusCode::UNAUTHORIZED, detail));
    let Some(token) = bearer_token(headers) else {
        if enforce {
            return unauthorized("internal-principal required".into());
        }
        tracing::warn!("internal-principal: missing on request (mode=log)");
        return Ok(None);
    };
    let Some(secret) = config.internal_principal_secret.as_deref() else {
        if enforce {
            return Err(ApiError::Detail(
                StatusCode::SERVICE_UNAVAILABLE,
                "INTERNAL_PRINCIPAL_SECRET not configured".into(),
            ));
        }
        tracing::error!("internal-principal: secret unset but mode=log — cannot verify");
        return Ok(None);
    };
    match media_core::auth::verify_principal(secret, &token, chrono::Utc::now().timestamp()) {
        Ok(claims) => Ok(Some(claims)),
        Err(e) => {
            let e = python_reason(&e);
            if enforce {
                return unauthorized(format!("invalid internal-principal: {e}"));
            }
            tracing::warn!("internal-principal: verify failed: {e} (mode=log)");
            Ok(None)
        }
    }
}

/// verify_principal's Debug reasons, spelled as the PyO3 binding raised them.
fn python_reason(e: &str) -> String {
    if e == "Expired" {
        return "internal-principal expired".into();
    }
    if let Some(kid) = e
        .strip_prefix("UnknownKid(")
        .and_then(|k| k.strip_suffix(')'))
    {
        let kid: String = serde_json::from_str(kid).unwrap_or_else(|_| kid.to_string());
        return format!("'unknown kid: {kid}'");
    }
    e.to_string()
}

/// Which sub a per-user request acts for: the verified principal's when there
/// is one (in enforce, a disagreeing body sub is a 403), else the body's.
pub fn authoritative_sub(
    config: &Config,
    principal: Option<&InternalClaims>,
    body_sub: &str,
) -> Result<String, ApiError> {
    let Some(p) = principal else {
        return Ok(body_sub.to_string());
    };
    if config.principal_mode == PrincipalMode::Enforce && body_sub != p.sub {
        return Err(ApiError::Detail(
            StatusCode::FORBIDDEN,
            "sub does not match verified internal-principal".into(),
        ));
    }
    Ok(p.sub.clone())
}

/// FastAPI parsed a body as JSON only for an application/json or +json type.
fn is_json(headers: &HeaderMap) -> bool {
    let Some(ct) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let ct = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match ct.split_once('/') {
        Some((main, sub)) if !sub.contains('/') => {
            main == "application" && (sub == "json" || sub.ends_with("+json"))
        }
        _ => false,
    }
}

/// The body as pydantic would see it. Unparsable JSON is the one error that
/// beats the gates.
fn read_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Body, ApiError> {
    if bytes.is_empty() {
        return Ok(Body::Missing);
    }
    if !is_json(headers) {
        return Ok(Body::Raw(String::from_utf8_lossy(bytes).into_owned()));
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Null) => Ok(Body::Missing),
        Ok(v) => Ok(Body::Json(v)),
        Err(e) => {
            // Byte offset of the failure (Python reported a character offset
            // and its own decoder's message).
            let offset: usize = bytes
                .split_inclusive(|&b| b == b'\n')
                .take(e.line().saturating_sub(1))
                .map(<[u8]>::len)
                .sum::<usize>()
                + e.column().saturating_sub(1);
            Err(ApiError::Invalid(vec![json!({
                "type": "json_invalid",
                "loc": ["body", offset],
                "msg": "JSON decode error",
                "input": {},
                "ctx": { "error": e.to_string() },
            })]))
        }
    }
}

/// The prelude of every event writer: body, secret gate, principal.
pub fn gate(
    st: &AppState,
    headers: &HeaderMap,
    bytes: &[u8],
) -> Result<(Body, Option<InternalClaims>), ApiError> {
    let body = read_body(headers, bytes)?;
    require_event_secret(&st.config, headers)?;
    let principal = principal(&st.config, headers)?;
    Ok((body, principal))
}

/// Liveness, unauthenticated (the compose healthcheck sends no header). The
/// db path, principal mode and optimizer status need the event secret.
async fn health(State(st): State<AppState>, headers: HeaderMap) -> Result<Json<Value>, ApiError> {
    let titles: i64 = sqlx::query_scalar("SELECT COUNT(*) AS c FROM titles")
        .fetch_one(&st.pool)
        .await?;
    let vecs: i64 = sqlx::query_scalar("SELECT COUNT(*) AS c FROM title_vec")
        .fetch_one(&st.pool)
        .await?;
    let version: Option<String> =
        sqlx::query_scalar("SELECT version FROM model_config WHERE active = 1 LIMIT 1")
            .fetch_optional(&st.pool)
            .await?;
    let auth = secret_matches(&st.config, &headers);
    let optimizer = if auth {
        let path = st.config.holdout_path.clone();
        tokio::task::spawn_blocking(move || crate::holdout::holdout_status(path.as_deref()))
            .await
            .unwrap_or_else(|_| json!({ "mode": "unknown" }))
    } else {
        Value::Null
    };
    Ok(Json(json!({
        "ok": true,
        "db_path": auth.then(|| st.config.db_path.display().to_string()),
        "titles": titles,
        "title_vectors": vecs,
        "active_model_version": version,
        "internal_principal_mode": auth.then(|| mode_name(&st.config.principal_mode)),
        "optimizer": optimizer,
    })))
}

/// Funnel rates with Wilson CIs over the last `window_days` (default 30,
/// clamped to 1..=365). Read-only.
async fn funnel(
    State(st): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Json<Value>, ApiError> {
    require_event_secret(&st.config, &headers)?;
    // A repeated parameter: the last one wins, as in Starlette.
    let raw = form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .filter(|(k, _)| k == "window_days")
        .map(|(_, v)| v.into_owned())
        .last();
    let window_days = match raw {
        None => crate::metrics::WINDOW_DAYS_DEFAULT as i128,
        Some(s) => validate::py_int_str(&s).ok_or_else(|| {
            ApiError::Invalid(vec![json!({
                "type": "int_parsing",
                "loc": ["query", "window_days"],
                "msg": "Input should be a valid integer, unable to parse string as an integer",
                "input": s,
            })])
        })?,
    };
    Ok(Json(
        crate::metrics::compute_funnel(&st.pool, window_days).await?,
    ))
}

#[cfg(test)]
pub(crate) mod tests;
