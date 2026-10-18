//! Per-request authentication: a Bearer device token or the session cookie,
//! each re-checked against live server state (`member_status`, then the
//! effective role) so a revoke or a demotion lands on the next request instead
//! of at token expiry. Port of middleware/auth.ts, middleware/deviceTokenAuth.ts,
//! services/sessionGate.ts (no Plex probe) and services/reconcileDeviceToken.ts.

use axum::Json;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use emerald_contracts::DeviceClaims;
use serde_json::json;
use sqlx::SqlitePool;

use crate::members::MemberStatus;
use crate::session::{self, Session};
use crate::{AuthMode, AuthState, Result, Role, device_tokens, effective_role, member_status};

/// Who is calling. `device` is set on the Bearer path (the devices routes read
/// the caller's jti from it).
#[derive(Debug, Clone)]
pub struct Principal {
    pub session: Session,
    pub device: Option<DeviceClaims>,
}

/// Why a request was refused. The bodies are the TS ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    Unauthenticated,
    /// Cookie path: the sub is revoked or not a member. Clears the cookie.
    AccessRevoked,
    /// A Bearer header was sent and failed (never falls back to the cookie).
    InvalidBearer,
    /// Authenticated but not an admin.
    AdminOnly,
    Internal,
}

impl IntoResponse for Rejection {
    fn into_response(self) -> Response {
        let unauthenticated = |reason: Option<&str>| {
            let mut body = json!({ "error": "unauthenticated" });
            if let Some(reason) = reason {
                body["reason"] = reason.into();
            }
            (StatusCode::UNAUTHORIZED, Json(body))
        };
        match self {
            Rejection::Unauthenticated => unauthenticated(None).into_response(),
            Rejection::InvalidBearer => unauthenticated(Some("invalid_bearer")).into_response(),
            Rejection::AccessRevoked => (
                [(header::SET_COOKIE, session::clear_cookie())],
                unauthenticated(Some("access_revoked")),
            )
                .into_response(),
            Rejection::AdminOnly => (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "forbidden", "reason": "admin_only" })),
            )
                .into_response(),
            Rejection::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal" })),
            )
                .into_response(),
        }
    }
}

fn internal(e: crate::Error) -> Rejection {
    tracing::error!(event = "auth_reconcile", error = %e, "auth store error");
    Rejection::Internal
}

/// Revoke every device token of a denied sub so its paired devices fail on
/// their next request, not at the 180-day TTL. A bookkeeping failure must not
/// mask the denial, so it is logged (without the sub) and swallowed.
async fn cascade_on_denial(pool: &SqlitePool, sub: &str, status: MemberStatus, surface: &str) {
    let reason = if status == MemberStatus::Revoked {
        "member_revoked"
    } else {
        "not_member"
    };
    match device_tokens::cascade_revoke_for_sub(pool, sub, reason).await {
        Ok(0) => {}
        Ok(n) => tracing::warn!(
            event = "auth_device_cascade",
            outcome = "revoked",
            revoked_count = n,
            reason,
            surface,
            "device token cascade completed"
        ),
        Err(_) => tracing::error!(
            event = "auth_device_cascade",
            outcome = "bookkeeping_failed",
            cause_type = "error",
            surface,
            "device token cascade failed"
        ),
    }
}

/// Cookie path: allowlist first, then the live role (the cookie's role claim
/// is never trusted). None = sign the user out.
pub async fn reconcile_cookie(
    pool: &SqlitePool,
    admin_subs: &[String],
    session: Session,
) -> Result<Option<Session>> {
    let status = member_status(pool, admin_subs, &session.sub).await?;
    if status != MemberStatus::Allowed {
        cascade_on_denial(pool, &session.sub, status, "cookie").await;
        return Ok(None);
    }
    let role = effective_role(pool, admin_subs, &session.sub).await?;
    Ok(Some(Session { role, ..session }))
}

/// Bearer path, after the token verified: allowlist, then touch the row's
/// last_seen_at / last_seen_version (X-App-Version), then the live role. The
/// session's username is the device's name. None = reject.
pub async fn reconcile_bearer(
    pool: &SqlitePool,
    admin_subs: &[String],
    claims: &DeviceClaims,
    app_version: Option<&str>,
) -> Result<Option<Session>> {
    let status = member_status(pool, admin_subs, &claims.sub).await?;
    if status != MemberStatus::Allowed {
        cascade_on_denial(pool, &claims.sub, status, "bearer").await;
        return Ok(None);
    }
    let device_name: Option<String> = sqlx::query_scalar(
        "UPDATE device_tokens SET last_seen_at = datetime('now'), \
         last_seen_version = COALESCE(?, last_seen_version) WHERE jti = ? RETURNING device_name",
    )
    .bind(app_version)
    .bind(&claims.jti)
    .fetch_optional(pool)
    .await?;
    // The row vanished between verify and here (a concurrent delete).
    let (Some(device_name), Some(auth_mode)) = (device_name, AuthMode::parse(&claims.auth_mode))
    else {
        return Ok(None);
    };
    let role = effective_role(pool, admin_subs, &claims.sub).await?;
    Ok(Some(Session {
        sub: claims.sub.clone(),
        username: device_name,
        role,
        auth_mode,
    }))
}

/// `Authorization: Bearer <token>`: None when absent or another scheme (the
/// cookie path runs), Some(None) when the token is not UTF-8. The value is
/// trimmed first, as Fetch Headers does for Hono, so a bare `Bearer   ` is
/// another scheme, not an empty token.
fn bearer(headers: &HeaderMap) -> Option<Option<&str>> {
    let rest = headers
        .get(header::AUTHORIZATION)?
        .as_bytes()
        .trim_ascii()
        .strip_prefix(b"Bearer ")?;
    Some(
        std::str::from_utf8(rest)
            .ok()
            .map(str::trim)
            .filter(|t| !t.is_empty()),
    )
}

/// Bearer first; a request that sent a Bearer is decided by it alone, so a
/// revoked device token cannot be bypassed with a cookie.
pub async fn authenticate(
    state: &AuthState,
    headers: &HeaderMap,
) -> std::result::Result<Principal, Rejection> {
    let now = state.now();
    let pool = &state.pool;
    let admin_subs = &state.config.admin_subs;

    if let Some(token) = bearer(headers) {
        let (Some(token), Some(keys)) = (token, state.device_keys.as_deref()) else {
            return Err(Rejection::InvalidBearer);
        };
        let Some(claims) = device_tokens::verify(pool, keys, token, now)
            .await
            .map_err(internal)?
        else {
            return Err(Rejection::InvalidBearer);
        };
        let app_version = headers.get("x-app-version").and_then(|v| v.to_str().ok());
        return match reconcile_bearer(pool, admin_subs, &claims, app_version)
            .await
            .map_err(internal)?
        {
            Some(session) => Ok(Principal {
                session,
                device: Some(claims),
            }),
            None => Err(Rejection::InvalidBearer),
        };
    }

    let Some(decoded) =
        session::read_cookie(headers).and_then(|t| session::verify(&state.session_key, t, now))
    else {
        return Err(Rejection::Unauthenticated);
    };
    match reconcile_cookie(pool, admin_subs, decoded)
        .await
        .map_err(internal)?
    {
        Some(session) => Ok(Principal {
            session,
            device: None,
        }),
        None => Err(Rejection::AccessRevoked),
    }
}

/// Any authenticated member (requireAuth).
pub struct RequireAuth(pub Principal);

/// An authenticated admin (requireAdmin): 401 first, then 403 admin_only.
pub struct RequireAdmin(pub Principal);

impl<S: Send + Sync> FromRequestParts<S> for RequireAuth
where
    AuthState: FromRef<S>,
{
    type Rejection = Rejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> std::result::Result<Self, Rejection> {
        authenticate(&AuthState::from_ref(state), &parts.headers)
            .await
            .map(RequireAuth)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for RequireAdmin
where
    AuthState: FromRef<S>,
{
    type Rejection = Rejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> std::result::Result<Self, Rejection> {
        let p = authenticate(&AuthState::from_ref(state), &parts.headers).await?;
        if p.session.role != Role::Admin {
            return Err(Rejection::AdminOnly);
        }
        Ok(RequireAdmin(p))
    }
}

#[cfg(test)]
mod tests;
