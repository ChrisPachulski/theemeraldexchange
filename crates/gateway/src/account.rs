//! Self-service account deletion for the Apple clients (App Store Guideline
//! 5.1.1(v); routes/account.ts, services/memberErasure.ts).
//!
//! `DELETE /api/account/self` revokes MY membership (the authoritative gate)
//! and every invite I issued, then purges my per-member state:
//! - 204: deleted, or already deleted (an idempotent replay)
//! - 401: no credential, or an already-revoked one
//! - 409 `last_admin`: I am the only administrator (or an ADMIN_SUBS owner)
//!
//! The subject is always the caller: the route takes no parameter. The
//! caller's own device token authorizes the request and dies in the cascade.
//! Every erasure step runs after the revoke commits, so a failed step is
//! logged for the operator and never surfaced: the member can no longer sign
//! in, and a 500 would make the app believe the account still exists.

use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::delete;

use crate::AppState;
use crate::routes::err;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/account/self", delete(delete_self))
}

async fn delete_self(
    State(st): State<AppState>,
    auth::RequireAuth(p): auth::RequireAuth,
    headers: HeaderMap,
) -> Response {
    let sub = &p.session.sub;
    let outcome = match auth::revoke_self(&st.auth.pool, &st.config.auth.admin_subs, sub).await {
        Ok(auth::members::SelfRevocation::LastAdmin) => {
            return err(StatusCode::CONFLICT, "last_admin");
        }
        Ok(auth::members::SelfRevocation::Revoked) => "revoked",
        Ok(auth::members::SelfRevocation::AlreadyRevoked) => "already_revoked",
        Err(e) => return e.into_response(),
    };
    // On its own task: a client hang-up must not stop the purge halfway.
    let (task_st, task_sub) = (st.clone(), sub.clone());
    let failures = tokio::spawn(async move { erase(&task_st, &task_sub).await })
        .await
        .unwrap_or_else(|e| vec![("erasure", e.to_string())]);
    let request_id = headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unavailable");
    for (step, error) in &failures {
        tracing::error!(
            event = "account",
            step,
            error,
            request_id,
            "account erasure step failed"
        );
    }
    let failed: Vec<&str> = failures.iter().map(|(s, _)| *s).collect();
    tracing::info!(event = "account", outcome, failed_steps = ?failed, request_id, "account deleted");
    StatusCode::NO_CONTENT.into_response()
}

/// Clear everything the server holds for `sub` besides the (kept, revoked)
/// members row and the device-token audit rows. Returns the failed steps.
pub async fn erase(st: &AppState, sub: &str) -> Vec<(&'static str, String)> {
    let mut failures = vec![];
    let mut attempt = |step: &'static str, r: Result<(), String>| {
        if let Err(e) = r {
            failures.push((step, e));
        }
    };
    let pool = &st.auth.pool;
    attempt(
        "device_tokens",
        auth::device_tokens::cascade_revoke_for_sub(pool, sub, "account_deleted")
            .await
            .map(drop)
            .map_err(|e| e.to_string()),
    );
    // Playlist tokens, favorites and watch history, in one iptv transaction.
    if !st.config.auth.iptv_disabled {
        let path = format!(
            "/internal/members/{}",
            crate::proxy::encode_uri_component(sub)
        );
        attempt(
            "iptv",
            crate::proxy::iptv_internal(
                st,
                Method::DELETE,
                &path,
                sub,
                None,
                Duration::from_secs(10),
            )
            .await
            .map(drop),
        );
    }
    attempt(
        "api_key",
        crate::stores::delete_api_key(pool, sub)
            .await
            .map(drop)
            .map_err(|e| e.to_string()),
    );
    attempt(
        "passkeys",
        sqlx::query("DELETE FROM webauthn_credentials WHERE sub = ?")
            .bind(sub)
            .execute(pool)
            .await
            .map(drop)
            .map_err(|e| e.to_string()),
    );
    let stores = &st.stores;
    attempt(
        "policy",
        stores.policies.remove(sub).await.map_err(|e| e.to_string()),
    );
    attempt(
        "feedback",
        stores
            .feedback
            .clear_user(sub)
            .await
            .map_err(|e| e.to_string()),
    );
    attempt(
        "watchlist",
        stores
            .watchlist
            .clear_user(sub)
            .await
            .map_err(|e| e.to_string()),
    );
    if st.config.use_media_core {
        attempt(
            "media_watch_state",
            crate::proxy::media::erase_watch_state(st, sub).await,
        );
    }
    failures
}

#[cfg(test)]
mod tests;
