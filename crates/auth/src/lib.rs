//! auth: the identity half of `server.db` (members, invites, device tokens,
//! server_id). A library linked in-process by the gateway, not a service:
//! every protected route needs its answer, so a network hop per request would
//! buy nothing.

mod client_address;
pub mod config;
pub mod csrf;
pub mod db;
pub mod device_tokens;
pub mod invites;
pub mod jwks;
pub mod members;
pub mod outcome;
pub mod ratelimit;
pub mod reconcile;
pub mod session;
mod signin;

#[cfg(test)]
mod testutil;

pub use db::ensure_server_id;
pub use members::{effective_role, member_status};
pub use reconcile::{Principal, Rejection, RequireAdmin, RequireAuth, authenticate};

use std::sync::Arc;

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use sqlx::SqlitePool;

/// What the auth routes and extractors need. Cheap to clone (the extractors
/// take it through `FromRef` on every request).
#[derive(Clone)]
pub struct AuthState {
    pub pool: SqlitePool,
    pub config: Arc<config::Config>,
    pub session_key: session::SessionKey,
    /// None in dev without DEVICE_TOKEN_SECRET: every Bearer is then invalid.
    pub device_keys: Option<Arc<device_tokens::Keys>>,
    /// The sign-in rate-limit buckets (process-wide, as in TS).
    pub limiter: Arc<ratelimit::Limiter>,
    /// The Apple and Google key sets (tests point them at a local server).
    pub apple_jwks: Arc<jwks::Jwks>,
    pub google_jwks: Arc<jwks::Jwks>,
    apple_nonces: Arc<signin::Nonces>,
    /// Pins the clock in tests so committed goldens never expire.
    #[cfg(test)]
    pub(crate) fixed_now: Option<i64>,
}

impl AuthState {
    pub fn new(pool: SqlitePool, config: config::Config) -> AuthState {
        AuthState {
            session_key: session::SessionKey::from_secret(&config.session_secret),
            device_keys: config
                .device_token_secret
                .as_deref()
                .map(|s| Arc::new(device_tokens::Keys::from_secret(s))),
            limiter: Arc::new(ratelimit::Limiter::new(config.trust_client_ip_headers)),
            apple_jwks: Arc::new(jwks::Jwks::apple()),
            google_jwks: Arc::new(jwks::Jwks::google()),
            apple_nonces: Arc::default(),
            config: Arc::new(config),
            pool,
            #[cfg(test)]
            fixed_now: None,
        }
    }

    pub(crate) fn now(&self) -> i64 {
        #[cfg(test)]
        if let Some(t) = self.fixed_now {
            return t;
        }
        chrono::Utc::now().timestamp()
    }
}

/// The auth routes, at their full /api paths.
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/me", get(me))
        .merge(signin::routes())
        .with_state(state)
}

/// GET /api/me: the reconciled caller. Over a Bearer the username is the
/// device's name.
async fn me(RequireAuth(p): RequireAuth) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "user": p.session }))
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    /// A sub that fails the contract grammar where the caller must supply a
    /// valid one (an invite issuer, a device-token subject).
    #[error("sub_invalid_format")]
    InvalidSub,
    /// A device-token mint without DEVICE_TOKEN_SECRET (dev only; prod
    /// refuses to boot without it).
    #[error("DEVICE_TOKEN_SECRET is not set")]
    NoDeviceSecret,
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "admin" => Some(Role::Admin),
            "user" => Some(Role::User),
            _ => None,
        }
    }
}

/// The provider an identity signed in with. Plex is gone (decisions.md), so a
/// stored `plex` row reads as a plain string on [`members::Member`] and a
/// `plex` device token or session cookie no longer verifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Local,
    Apple,
    Google,
    Workos,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Local => "local",
            AuthMode::Apple => "apple",
            AuthMode::Google => "google",
            AuthMode::Workos => "workos",
        }
    }

    pub fn parse(s: &str) -> Option<AuthMode> {
        match s {
            "local" => Some(AuthMode::Local),
            "apple" => Some(AuthMode::Apple),
            "google" => Some(AuthMode::Google),
            "workos" => Some(AuthMode::Workos),
            _ => None,
        }
    }
}

pub(crate) fn valid_sub(sub: &str) -> bool {
    emerald_contracts::parse_sub(sub).is_ok()
}

/// JS `Date#toISOString()`: millisecond precision, `Z`. Stored timestamps are
/// compared as strings, so the format must match the rows Node wrote.
pub(crate) fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn now_iso() -> String {
    iso(chrono::Utc::now())
}
