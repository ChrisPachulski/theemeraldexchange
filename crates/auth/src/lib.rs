//! auth: the identity half of `server.db` (members, invites, device tokens,
//! server_id). A library linked in-process by the gateway, not a service:
//! every protected route needs its answer, so a network hop per request would
//! buy nothing.

mod admin;
mod client_address;
pub mod config;
pub mod csrf;
pub mod db;
mod device_link;
pub mod device_tokens;
mod devices;
pub mod invites;
pub mod jwks;
pub mod members;
pub mod outcome;
pub mod plex;
pub mod ratelimit;
pub mod reconcile;
pub mod session;
mod signin;
pub mod workos;

#[cfg(test)]
mod route_goldens;
#[cfg(test)]
mod testutil;

pub use db::ensure_server_id;
pub use device_tokens::spawn_sweep;
pub use members::{effective_role, member_status, revoke_self};
pub use reconcile::{Principal, Rejection, RequireAdmin, RequireAuth, authenticate};
pub use signin::json_body;

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
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
    /// The WorkOS endpoints and native states (tests point it at a fake).
    pub workos: Arc<workos::Workos>,
    /// The plex.tv client (tests point it at a fake).
    pub plex: Arc<plex::Plex>,
    /// The sessionGate's per-sub plex.tv verdicts.
    pub(crate) plex_gate: Arc<reconcile::PlexGate>,
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
            workos: Arc::default(),
            plex: Arc::default(),
            plex_gate: Arc::default(),
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

/// The auth routes, at their full /api paths: /api/me, /api/auth/*,
/// /api/devices/*, /api/admin/{devices,invites,members}. CSRF, CORS and the
/// request id are the gateway's layers.
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/api/me", get(me))
        .route("/api/auth/logout", post(logout))
        .merge(signin::routes())
        .merge(plex::routes())
        .merge(workos::routes())
        .merge(device_link::routes())
        .merge(devices::routes())
        .merge(admin::routes())
        .with_state(state)
}

/// GET /api/me: the reconciled caller. Over a Bearer the username is the
/// device's name.
async fn me(RequireAuth(p): RequireAuth) -> impl IntoResponse {
    // A struct, not `json!`, so the keys keep the TS order.
    #[derive(Serialize)]
    struct Me {
        user: session::Session,
    }
    Json(Me { user: p.session })
}

/// POST /api/auth/logout: clears the session cookie. The session is
/// stateless; a Plex sign-in's plex.tv token is signed out first, best effort
/// (a failure is logged and the cookie still goes).
async fn logout(State(st): State<AuthState>, headers: HeaderMap) -> impl IntoResponse {
    let token = session::read_cookie(&headers)
        .and_then(|c| session::verify(&st.session_key, c, st.now()))
        .and_then(|s| s.plex_auth_token);
    if let Some(token) = token
        && let Err(e) = st.plex.sign_out(&st.config, &token).await
    {
        tracing::warn!(event = "auth_logout", error = %e, "plex signout failed");
    }
    (
        [(header::SET_COOKIE, session::clear_cookie())],
        Json(serde_json::json!({ "ok": true })),
    )
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
    /// A plex.tv failure inside a sign-in (the Display names only the call
    /// and the status, never a token or PIN).
    #[error(transparent)]
    Plex(#[from] plex::PlexError),
}

pub type Result<T> = std::result::Result<T, Error>;

/// A store failure inside a route: logged, then the generic 500.
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        tracing::error!(event = "auth_store", error = %self, "auth store error");
        Rejection::Internal.into_response()
    }
}

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

/// The provider an identity signed in with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    Plex,
    Local,
    Apple,
    Google,
    Workos,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Plex => "plex",
            AuthMode::Local => "local",
            AuthMode::Apple => "apple",
            AuthMode::Google => "google",
            AuthMode::Workos => "workos",
        }
    }

    pub fn parse(s: &str) -> Option<AuthMode> {
        match s {
            "plex" => Some(AuthMode::Plex),
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

pub fn now_iso() -> String {
    iso(chrono::Utc::now())
}

/// JS whitespace (`String#trim`, regex `\s`): Unicode White_Space minus
/// U+0085, plus U+FEFF.
pub fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// JS `String#length`: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` in UTF-16 code units; a surrogate pair split at the
/// cut is dropped whole (JS keeps the lone high surrogate).
pub fn js_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// The provider namespace of a sub (`apple`, `workos`, ...).
pub(crate) fn sub_namespace(sub: &str) -> &str {
    sub.split(':').next().unwrap_or_default()
}
