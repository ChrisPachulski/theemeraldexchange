//! gateway: the public /api surface that replaces the Hono backend. It links
//! crates/auth in-process (its router, extractors, CSRF layer and server.db
//! pool) and reaches the internal services (recommender, media-core,
//! transcoder, iptv) and the *arr/SAB/TMDB upstreams through one client.

pub mod app;
pub mod config;
pub mod principal;
pub mod telemetry;
pub mod upstream;

#[cfg(test)]
mod edge_goldens;
#[cfg(test)]
mod testutil;

pub use app::router;

use std::path::PathBuf;
use std::sync::Arc;

use auth::AuthState;
use axum::extract::FromRef;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::upstream::Upstream;

#[derive(Clone)]
pub struct AppState {
    pub auth: AuthState,
    pub config: Arc<Config>,
    pub upstream: Upstream,
    /// The built SPA (./dist), when SERVE_SPA serves it same-origin.
    pub spa_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> AppState {
        AppState {
            auth: AuthState::new(pool, config.auth.clone()),
            spa_dir: config.auth.serve_spa.then(|| PathBuf::from("./dist")),
            upstream: Upstream::default(),
            config: Arc::new(config),
        }
    }
}

/// RequireAuth/RequireAdmin take the auth half of the state.
impl FromRef<AppState> for AuthState {
    fn from_ref(st: &AppState) -> AuthState {
        st.auth.clone()
    }
}
