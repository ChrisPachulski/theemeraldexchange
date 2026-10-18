//! Web-claimed device pairing, the port of routes/deviceLink.ts. An Apple
//! device has no browser session (tvOS has no web view), so it shows a short
//! code; a member signed in on the web (any provider) claims it, and the
//! device's next poll mints a device token for that member: the same JWE and
//! `device_tokens` row as every other pairing.
//!
//!   POST /api/auth/device/link/start  {device_id, device_name, device_platform}
//!   POST /api/auth/device/link/claim  {code}             (RequireAuth)
//!   POST /api/auth/device/link/poll   {code, device_id}

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{Value, json};

use crate::device_tokens::{self, MintInput};
use crate::outcome::{Outcome, Phase, Provider, Reason, Reporter};
use crate::ratelimit::Kind;
use crate::signin::{error, internal, json_body, text};
use crate::{AuthMode, AuthState, Error, RequireAuth, Result, Role, js_space, js_trim};

/// No 0/O/1/I, so the code survives being read off a TV and typed on a phone.
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 8;
pub const LINK_CODE_TTL_SECS: i64 = 600;
const POLL_INTERVAL_SECS: i64 = 2;
const MAX_BODY_BYTES: usize = 2048;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/auth/device/link/start", post(start))
        .route("/api/auth/device/link/claim", post(claim))
        .route("/api/auth/device/link/poll", post(poll))
}

/// 8 chars from the 32-letter alphabet (256 % 32 == 0, so unbiased).
pub fn generate_code() -> String {
    (0..CODE_LENGTH)
        .map(|_| CODE_ALPHABET[usize::from(rand::random::<u8>()) % CODE_ALPHABET.len()] as char)
        .collect()
}

/// Trimmed, upper-cased, spaces and dashes dropped ("abcd-efgh" works).
fn normalize_code(raw: Option<&Value>) -> String {
    raw.and_then(Value::as_str)
        .map(|s| {
            js_trim(s)
                .to_uppercase()
                .chars()
                .filter(|c| !js_space(*c) && *c != '-')
                .collect()
        })
        .unwrap_or_default()
}

fn code_shape(code: &str) -> bool {
    code.len() == CODE_LENGTH
        && code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'9').contains(&b))
}

#[derive(Serialize)]
struct Started {
    code: String,
    verify_url: String,
    expires_in: i64,
    interval: i64,
}

#[derive(Serialize)]
struct Claimed {
    ok: bool,
    device_name: String,
    device_platform: String,
}

#[derive(Serialize)]
struct Denied {
    status: &'static str,
    reason: &'static str,
}

#[derive(Serialize)]
struct Authorized<'a> {
    status: &'static str,
    token: String,
    server_id: String,
    user: LinkedUser<'a>,
}

#[derive(Serialize)]
struct LinkedUser<'a> {
    sub: &'a str,
    username: &'a str,
    role: Role,
}

#[derive(sqlx::FromRow)]
struct Row {
    device_id: String,
    device_name: String,
    device_platform: String,
    expires_at: i64,
    claimed_sub: Option<String>,
    claimed_username: Option<String>,
    claimed_role: Option<String>,
    claimed_auth_mode: Option<String>,
    consumed_at: Option<i64>,
}

async fn row(st: &AuthState, code: &str) -> Result<Option<Row>> {
    Ok(sqlx::query_as(
        "SELECT device_id, device_name, device_platform, expires_at, claimed_sub, \
         claimed_username, claimed_role, claimed_auth_mode, consumed_at \
         FROM device_link_codes WHERE code = ?",
    )
    .bind(code)
    .fetch_optional(&st.pool)
    .await?)
}

/// The SPA origin for verify_url: the request's own origin when the backend
/// serves the SPA, else the first allowed origin, else the request's.
fn spa_origin(st: &AuthState, uri: &Uri, headers: &HeaderMap) -> String {
    let own = || crate::workos::request_origin(uri, headers).unwrap_or_default();
    if st.config.serve_spa {
        own()
    } else {
        st.config
            .allowed_origins
            .first()
            .cloned()
            .unwrap_or_else(own)
    }
}

fn invalid(outcome: &Reporter, r: Response) -> Response {
    outcome.record(Outcome::Invalid, Reason::InvalidRequest);
    r
}

async fn start(State(st): State<AuthState>, uri: Uri, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Link, Phase::Check);
    outcome
        .run(start_inner(&st, &uri, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn start_inner(
    st: &AuthState,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Pin, outcome) {
        return Ok(r);
    }
    let body = match json_body(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(r) => return Ok(invalid(outcome, r)),
    };
    let field = |k: &str| text(&body, k).map(js_trim).unwrap_or_default();
    let (device_id, device_name, device_platform) = (
        field("device_id"),
        field("device_name"),
        field("device_platform"),
    );
    if device_id.is_empty() || device_name.is_empty() || device_platform.is_empty() {
        return Ok(invalid(
            outcome,
            error(
                StatusCode::BAD_REQUEST,
                json!({ "error": "missing_device_fields" }),
            ),
        ));
    }
    let now = st.now();
    sqlx::query("DELETE FROM device_link_codes WHERE expires_at < ?")
        .bind(now - LINK_CODE_TTL_SECS)
        .execute(&st.pool)
        .await?;
    let code = generate_code();
    sqlx::query(
        "INSERT INTO device_link_codes \
         (code, device_id, device_name, device_platform, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&code)
    .bind(device_id)
    .bind(device_name)
    .bind(device_platform)
    .bind(now)
    .bind(now + LINK_CODE_TTL_SECS)
    .execute(&st.pool)
    .await?;
    outcome.record(Outcome::Authorized, Reason::DeviceLink);
    Ok(Json(Started {
        verify_url: format!("{}/#/link/{code}", spa_origin(st, uri, headers)),
        code,
        expires_in: LINK_CODE_TTL_SECS,
        interval: POLL_INTERVAL_SECS,
    })
    .into_response())
}

/// Bind the signed-in member (sub, name, live role, provider) to a code.
async fn claim(
    State(st): State<AuthState>,
    RequireAuth(p): RequireAuth,
    body: Body,
) -> Result<Response> {
    let body = match json_body(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(r) => return Ok(r),
    };
    let code = normalize_code(body.get("code"));
    if !code_shape(&code) {
        return Ok(error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_code" }),
        ));
    }
    let now = st.now();
    let Some(row) = row(&st, &code).await? else {
        return Ok(error(
            StatusCode::NOT_FOUND,
            json!({ "error": "unknown_code" }),
        ));
    };
    if row.expires_at < now {
        return Ok(error(StatusCode::GONE, json!({ "error": "expired" })));
    }
    let already = || error(StatusCode::CONFLICT, json!({ "error": "already_claimed" }));
    if row.claimed_sub.is_some() {
        return Ok(already());
    }
    let s = &p.session;
    // Guarded on claimed_sub so two racing claims cannot both bind.
    let bound = sqlx::query(
        "UPDATE device_link_codes SET claimed_sub = ?, claimed_username = ?, claimed_role = ?, \
         claimed_auth_mode = ?, claimed_at = ? WHERE code = ? AND claimed_sub IS NULL",
    )
    .bind(&s.sub)
    .bind(&s.username)
    .bind(s.role)
    .bind(s.auth_mode.as_str())
    .bind(now)
    .bind(&code)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if bound == 0 {
        return Ok(already());
    }
    Ok(Json(Claimed {
        ok: true,
        device_name: row.device_name,
        device_platform: row.device_platform,
    })
    .into_response())
}

async fn poll(State(st): State<AuthState>, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Link, Phase::Check);
    outcome
        .run(poll_inner(&st, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn poll_inner(
    st: &AuthState,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Check, outcome) {
        return Ok(r);
    }
    let body = match json_body(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(r) => return Ok(invalid(outcome, r)),
    };
    let code = normalize_code(body.get("code"));
    let device_id = text(&body, "device_id").map(js_trim).unwrap_or_default();
    if !code_shape(&code) || device_id.is_empty() {
        return Ok(invalid(
            outcome,
            error(
                StatusCode::BAD_REQUEST,
                json!({ "error": "invalid_request" }),
            ),
        ));
    }
    let denied = |reason| {
        invalid(
            outcome,
            Json(Denied {
                status: "denied",
                reason,
            })
            .into_response(),
        )
    };
    let now = st.now();
    // A wrong device_id answers exactly like an unknown code, so the poll
    // cannot be used to probe which codes exist.
    let row = match row(st, &code).await? {
        Some(r) if r.device_id == device_id && r.consumed_at.is_none() => r,
        _ => return Ok(denied("unknown_code")),
    };
    if row.expires_at < now {
        return Ok(denied("expired"));
    }
    let Some(sub) = row.claimed_sub.as_deref() else {
        return Ok(Json(json!({ "status": "pending" })).into_response());
    };
    let role = row
        .claimed_role
        .as_deref()
        .and_then(Role::parse)
        .unwrap_or(Role::User);
    let username = row.claimed_username.as_deref().unwrap_or(sub);
    // A claim always records the mode (TS's `?? 'plex'` default had no row to
    // serve), so a row without one is refused rather than guessed.
    let Some(auth_mode) = row.claimed_auth_mode.as_deref().and_then(AuthMode::parse) else {
        return Ok(denied("unknown_code"));
    };
    let keys = st.device_keys.as_deref().ok_or(Error::NoDeviceSecret)?;
    // Consume before minting, guarded, so two racing polls mint one token.
    let won = sqlx::query(
        "UPDATE device_link_codes SET consumed_at = ? WHERE code = ? AND consumed_at IS NULL",
    )
    .bind(now)
    .bind(&code)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if won == 0 {
        return Ok(denied("unknown_code"));
    }
    let server_id = crate::ensure_server_id(&st.pool).await?;
    let token = device_tokens::mint(
        &st.pool,
        keys,
        &MintInput {
            sub,
            role,
            auth_mode,
            device_id: &row.device_id,
            device_platform: &row.device_platform,
            device_name: &row.device_name,
            username: Some(username),
            server_id: &server_id,
        },
    )
    .await?;
    outcome.record(Outcome::Authorized, Reason::DeviceLink);
    Ok(Json(Authorized {
        status: "authorized",
        token,
        server_id,
        user: LinkedUser {
            sub,
            username,
            role,
        },
    })
    .into_response())
}

#[cfg(test)]
mod tests;
