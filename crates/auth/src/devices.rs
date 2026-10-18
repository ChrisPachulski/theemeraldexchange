//! Paired-device management, the port of routes/devices.ts.
//!
//! Self (RequireAuth, scoped to the caller's sub):
//!   GET /api/devices/self, DELETE /api/devices/self (revoke all),
//!   DELETE /api/devices/self/:jti, PATCH /api/devices/self/:jti/name
//! Admin (RequireAdmin, any sub):
//!   GET /api/admin/devices, DELETE /api/admin/devices/:jti,
//!   PATCH /api/admin/devices/:jti/name
//!
//! Revocations are idempotent rows in `device_token_revocations`; the
//! `device_tokens` row stays for the audit trail and last_seen_*.

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;

use crate::signin::{error, json_body, text};
use crate::{AuthState, RequireAdmin, RequireAuth, Result, device_tokens, js_len, js_trim};

/// A rename body is one short field; this only bounds what is buffered.
const MAX_BODY_BYTES: usize = 64 * 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/devices/self", get(list_own).delete(revoke_all_own))
        .route("/api/devices/self/{jti}", delete(revoke_own))
        .route("/api/devices/self/{jti}/name", patch(rename_own))
        .route("/api/admin/devices", get(list_all))
        .route("/api/admin/devices/{jti}", delete(revoke_any))
        .route("/api/admin/devices/{jti}/name", patch(rename_any))
}

/// One query yields active and revoked devices in the same shape.
const SELECT_DEVICES: &str = "SELECT d.jti, d.sub, d.device_id, d.device_name, d.platform, \
     d.server_id, d.issued_at, d.expires_at, d.last_seen_at, d.last_seen_version, \
     r.revoked_at, r.reason AS revoked_reason \
     FROM device_tokens d LEFT JOIN device_token_revocations r ON d.jti = r.jti";

#[derive(sqlx::FromRow)]
struct Row {
    jti: String,
    sub: String,
    device_id: String,
    device_name: String,
    platform: String,
    server_id: String,
    issued_at: String,
    expires_at: String,
    last_seen_at: Option<String>,
    last_seen_version: Option<String>,
    revoked_at: Option<String>,
    revoked_reason: Option<String>,
}

/// The public view (field order is the TS one). No kid.
#[derive(Serialize)]
struct View {
    jti: String,
    device_id: String,
    device_name: String,
    platform: String,
    server_id: String,
    issued_at: String,
    expires_at: String,
    last_seen_at: Option<String>,
    last_seen_version: Option<String>,
    revoked: bool,
    revoked_at: Option<String>,
    revoked_reason: Option<String>,
    /// Self list only: the caller's own Bearer device.
    #[serde(skip_serializing_if = "Option::is_none")]
    is_current: Option<bool>,
    /// Admin list only.
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
}

impl View {
    fn new(r: Row, current_jti: Option<&str>, with_sub: bool) -> View {
        View {
            is_current: (current_jti == Some(r.jti.as_str())).then_some(true),
            sub: with_sub.then_some(r.sub),
            jti: r.jti,
            device_id: r.device_id,
            device_name: r.device_name,
            platform: r.platform,
            server_id: r.server_id,
            issued_at: r.issued_at,
            expires_at: r.expires_at,
            last_seen_at: r.last_seen_at,
            last_seen_version: r.last_seen_version,
            revoked: r.revoked_at.is_some(),
            revoked_at: r.revoked_at,
            revoked_reason: r.revoked_reason,
        }
    }
}

/// Serialized as a struct: `json!` would re-sort the view's keys.
#[derive(Serialize)]
struct Devices {
    devices: Vec<View>,
}

const NEWEST_FIRST: &str = "ORDER BY datetime(COALESCE(d.last_seen_at, d.issued_at)) DESC";

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, json!({ "error": "not_found" }))
}

fn revoked(jti: String) -> Response {
    Json(json!({ "ok": true, "revoked": jti })).into_response()
}

/// The caller's active devices; `is_current` marks the Bearer's own.
async fn list_own(State(st): State<AuthState>, RequireAuth(p): RequireAuth) -> Result<Response> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT_DEVICES} WHERE d.sub = ? AND r.jti IS NULL {NEWEST_FIRST}"
    )))
    .bind(&p.session.sub)
    .fetch_all(&st.pool)
    .await?;
    let current = p.device.as_ref().map(|d| d.jti.as_str());
    let devices: Vec<View> = rows
        .into_iter()
        .map(|r| View::new(r, current, false))
        .collect();
    Ok(Json(Devices { devices }).into_response())
}

async fn revoke_own(
    State(st): State<AuthState>,
    RequireAuth(p): RequireAuth,
    Path(jti): Path<String>,
) -> Result<Response> {
    let owned: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM device_tokens WHERE jti = ? AND sub = ?")
            .bind(&jti)
            .bind(&p.session.sub)
            .fetch_optional(&st.pool)
            .await?;
    if owned.is_none() {
        return Ok(not_found());
    }
    device_tokens::revoke(&st.pool, &jti, "self_revoke").await?;
    Ok(revoked(jti))
}

/// Logout everywhere: revoke every active device of the caller.
async fn revoke_all_own(
    State(st): State<AuthState>,
    RequireAuth(p): RequireAuth,
) -> Result<Response> {
    const ACTIVE: &str = "FROM device_tokens d LEFT JOIN device_token_revocations r \
         ON d.jti = r.jti WHERE d.sub = ? AND r.jti IS NULL";
    let mut tx = st.pool.begin().await?;
    let n: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) {ACTIVE}")))
        .bind(&p.session.sub)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason) \
         SELECT d.jti, datetime('now'), 'self_logout_everywhere' {ACTIVE}"
    )))
    .bind(&p.session.sub)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "revoked_count": n })).into_response())
}

#[derive(Serialize)]
struct Renamed {
    ok: bool,
    device_name: String,
}

/// The trimmed new name, or the TS 400.
async fn new_name(body: Body) -> std::result::Result<String, Response> {
    let body = json_body(body, MAX_BODY_BYTES).await?;
    let bad = |message: &str| {
        error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_body", "message": message }),
        )
    };
    let Some(name) = text(&body, "device_name") else {
        return Err(bad("device_name (string) required"));
    };
    let name = js_trim(name);
    if name.is_empty() || js_len(name) > 128 {
        return Err(bad("device_name must be 1-128 chars"));
    }
    Ok(name.to_string())
}

/// UPDATE scoped by `sub` when given; nothing changes on a foreign row.
async fn rename(st: &AuthState, jti: &str, sub: Option<&str>, body: Body) -> Result<Response> {
    let name = match new_name(body).await {
        Ok(n) => n,
        Err(r) => return Ok(r),
    };
    let changed = sqlx::query(
        "UPDATE device_tokens SET device_name = ?1 WHERE jti = ?2 AND (?3 IS NULL OR sub = ?3)",
    )
    .bind(&name)
    .bind(jti)
    .bind(sub)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if changed == 0 {
        return Ok(not_found());
    }
    Ok(Json(Renamed {
        ok: true,
        device_name: name,
    })
    .into_response())
}

async fn rename_own(
    State(st): State<AuthState>,
    RequireAuth(p): RequireAuth,
    Path(jti): Path<String>,
    body: Body,
) -> Result<Response> {
    rename(&st, &jti, Some(&p.session.sub), body).await
}

/// Every device, revoked included, with its sub.
async fn list_all(State(st): State<AuthState>, _: RequireAdmin) -> Result<Response> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT_DEVICES} {NEWEST_FIRST}"
    )))
    .fetch_all(&st.pool)
    .await?;
    let devices: Vec<View> = rows.into_iter().map(|r| View::new(r, None, true)).collect();
    Ok(Json(Devices { devices }).into_response())
}

async fn revoke_any(
    State(st): State<AuthState>,
    _: RequireAdmin,
    Path(jti): Path<String>,
) -> Result<Response> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM device_tokens WHERE jti = ?")
        .bind(&jti)
        .fetch_optional(&st.pool)
        .await?;
    if exists.is_none() {
        return Ok(not_found());
    }
    device_tokens::revoke(&st.pool, &jti, "admin_revoke").await?;
    Ok(revoked(jti))
}

async fn rename_any(
    State(st): State<AuthState>,
    _: RequireAdmin,
    Path(jti): Path<String>,
    body: Body,
) -> Result<Response> {
    rename(&st, &jti, None, body).await
}

#[cfg(test)]
mod tests;
