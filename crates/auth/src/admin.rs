//! The owner-only allowlist surface, the port of routes/adminInvites.ts. Both
//! halves are RequireAdmin.
//!
//!   GET    /api/admin/invites           redacted list
//!   POST   /api/admin/invites           issue; the code is shown this once
//!   DELETE /api/admin/invites/:prefix   revoke by code_hash prefix
//!   GET    /api/admin/members           active and revoked, plus ADMIN_SUBS
//!   DELETE /api/admin/members/:sub      revoke, then cascade

use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use emerald_contracts::internal_principal::{self, DEFAULT_TTL_SECS, InternalClaims};
use serde::Serialize;
use serde_json::{Value, json};

use crate::invites::{self, DEFAULT_EXPIRES_IN_DAYS, IssueOptions};
use crate::members::{self, Member, SafeRevocation};
use crate::reconcile::Rejection;
use crate::signin::{error, json_body};
use crate::{AuthState, RequireAdmin, Result, Role, device_tokens, js_trim, sub_namespace};

/// An invite body is four small fields; this only bounds what is buffered.
const MAX_BODY_BYTES: usize = 64 * 1024;
const IPTV_TIMEOUT: Duration = Duration::from_secs(10);
/// JS Date's range (ms either side of the epoch): past it TS threw.
const JS_DATE_MAX_MS: f64 = 8.64e15;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/admin/invites", get(list_invites).post(issue_invite))
        .route("/api/admin/invites/{prefix}", delete(revoke_invite))
        .route("/api/admin/members", get(list_members))
        .route("/api/admin/members/{sub}", delete(revoke_member))
}

#[derive(Serialize)]
struct Invites {
    invites: Vec<invites::Summary>,
}

async fn list_invites(State(st): State<AuthState>, _: RequireAdmin) -> Result<Response> {
    Ok(Json(Invites {
        invites: invites::list(&st.pool).await?,
    })
    .into_response())
}

fn invalid_body(message: &str) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        json!({ "error": "invalid_body", "message": message }),
    )
}

/// The TS body rules: every field optional, a wrong type is a 400 (never a
/// silent default). An unparseable body reads as empty.
fn issue_options(body: &Value) -> std::result::Result<IssueOptions, &'static str> {
    let label = match body.get("label") {
        None | Some(Value::Null) => None,
        // trim, then the first 120 UTF-16 units; empty becomes null.
        Some(Value::String(s)) => {
            let units: Vec<u16> = js_trim(s).encode_utf16().take(120).collect();
            Some(String::from_utf16_lossy(&units)).filter(|l| !l.is_empty())
        }
        Some(_) => return Err("label must be a string"),
    };
    let expires_in_days = match body.get("expiresInDays") {
        None => Some(DEFAULT_EXPIRES_IN_DAYS),
        Some(Value::Null) => None,
        Some(v) => match v.as_f64() {
            Some(d)
                if (chrono::Utc::now().timestamp_millis() as f64 + d * 86_400_000.0).abs()
                    <= JS_DATE_MAX_MS =>
            {
                Some(d)
            }
            _ => return Err("expiresInDays must be a number or null"),
        },
    };
    let max_uses = match body.get("maxUses") {
        None => 1,
        Some(v) => match v.as_f64() {
            Some(n) if n >= 1.0 && n.fract() == 0.0 => n as i64,
            _ => return Err("maxUses must be an integer >= 1"),
        },
    };
    let role = match body.get("role") {
        None => Role::User,
        Some(v) => match v.as_str().and_then(Role::parse) {
            Some(r) => r,
            None => return Err("role must be 'user' or 'admin'"),
        },
    };
    Ok(IssueOptions {
        label,
        expires_in_days,
        max_uses,
        role,
    })
}

/// 201 with the plaintext code: the only place it is ever surfaced.
async fn issue_invite(
    State(st): State<AuthState>,
    RequireAdmin(p): RequireAdmin,
    body: Body,
) -> Result<Response> {
    let body = match json_body(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(r) => return Ok(r),
    };
    let opts = match issue_options(&body) {
        Ok(o) => o,
        Err(message) => return Ok(invalid_body(message)),
    };
    let issued = invites::issue(&st.pool, &p.session.sub, opts).await?;
    Ok((StatusCode::CREATED, Json(issued)).into_response())
}

async fn revoke_invite(
    State(st): State<AuthState>,
    _: RequireAdmin,
    Path(prefix): Path<String>,
) -> Result<Response> {
    if !invites::revoke(&st.pool, &prefix).await? {
        return Ok(error(
            StatusCode::NOT_FOUND,
            json!({ "error": "not_found" }),
        ));
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

/// A member row plus the SPA's owner flag (ADMIN_SUBS or role admin).
#[derive(Serialize)]
struct MemberView {
    #[serde(flatten)]
    member: Member,
    is_admin: bool,
}

#[derive(Serialize)]
struct Members {
    members: Vec<MemberView>,
}

/// Every member, newest first, with each ADMIN_SUBS owner that has no row
/// yet synthesized at the top (the owner must see themselves before their
/// first sign-in writes a row).
async fn list_members(State(st): State<AuthState>, _: RequireAdmin) -> Result<Response> {
    let admin_subs = &st.config.admin_subs;
    let mut members: Vec<MemberView> = members::list(&st.pool)
        .await?
        .into_iter()
        .map(|m| MemberView {
            is_admin: admin_subs.contains(&m.sub) || m.role == Role::Admin,
            member: m,
        })
        .collect();
    for sub in admin_subs {
        if members.iter().any(|m| &m.member.sub == sub) {
            continue;
        }
        members.insert(
            0,
            MemberView {
                member: Member {
                    sub: sub.clone(),
                    display_name: None,
                    role: Role::Admin,
                    auth_mode: sub_namespace(sub).to_string(),
                    invited_by: None,
                    joined_at: String::new(),
                    revoked_at: None,
                },
                is_admin: true,
            },
        );
    }
    Ok(Json(Members { members }).into_response())
}

/// Revoke a member while the caller is still an admin, then converge their
/// credentials. The members row is the authZ gate and is committed first;
/// the device-token and playlist-token cascades are best effort (a bearer
/// reconcile denies a revoked member anyway), so their failures are logged
/// with the request id, never the sub, and never surfaced.
async fn revoke_member(
    State(st): State<AuthState>,
    RequireAdmin(p): RequireAdmin,
    Path(sub): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let conflict = |e: &str| error(StatusCode::CONFLICT, json!({ "error": e }));
    match members::revoke_safely(&st.pool, &st.config.admin_subs, &sub, &p.session.sub).await? {
        SafeRevocation::Revoked => {}
        SafeRevocation::NotFound => {
            return Ok(error(
                StatusCode::NOT_FOUND,
                json!({ "error": "not_found" }),
            ));
        }
        SafeRevocation::Owner => return Ok(conflict("cannot_revoke_owner")),
        SafeRevocation::OwnSub => return Ok(conflict("cannot_revoke_self")),
        SafeRevocation::ActorNotAdmin => return Ok(Rejection::AdminOnly.into_response()),
    }
    let request_id = crate::outcome::request_id(&headers);
    if let Err(e) = device_tokens::cascade_revoke_for_sub(&st.pool, &sub, "member_revoked").await {
        tracing::error!(event = "admin_members", request_id, error = %e, "device-token cascade revoke failed");
    }
    if let Err(e) = revoke_iptv_playlist_tokens(&st, &sub).await {
        tracing::error!(event = "admin_members", request_id, error = %e, "playlist-token cascade revoke failed");
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

/// JS `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A 60 s admin principal for `sub`: the iptv service answers /internal only
/// for an admin, and no admin session exists on every path that calls it.
async fn principal_for(st: &AuthState, secret: &str, sub: &str) -> Result<String> {
    let now = chrono::Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: Role::Admin.as_str().into(),
        auth_mode: sub_namespace(sub).into(),
        server_id: crate::ensure_server_id(&st.pool).await?,
        device_id: None,
        req_id: ulid::Ulid::generate().to_string(),
        iat: now,
        exp: now + DEFAULT_TTL_SECS,
    };
    Ok(internal_principal::encrypt_with_secret(
        secret.as_bytes(),
        &claims,
    ))
}

/// POST the iptv service's revoke-playlist-tokens for `sub`. No-op under
/// IPTV_DISABLED; no Authorization without INTERNAL_PRINCIPAL_SECRET (dev).
/// Error strings carry no URL: the path holds the member sub.
pub(crate) async fn revoke_iptv_playlist_tokens(
    st: &AuthState,
    sub: &str,
) -> std::result::Result<(), String> {
    if st.config.iptv_disabled {
        return Ok(());
    }
    let url = format!(
        "{}/internal/members/{}/revoke-playlist-tokens",
        st.config.iptv_service_url,
        encode_uri_component(sub)
    );
    let client = reqwest::Client::builder()
        .timeout(IPTV_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.without_url().to_string())?;
    let mut req = client.post(url);
    if let Some(secret) = &st.config.internal_principal_secret {
        let token = principal_for(st, secret, sub)
            .await
            .map_err(|e| format!("principal mint failed: {e}"))?;
        req = req.bearer_auth(token);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("iptv internal POST failed: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!(
            "iptv internal POST answered {}",
            res.status().as_u16()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
