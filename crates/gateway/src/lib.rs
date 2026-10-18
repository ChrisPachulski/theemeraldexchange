//! gateway: the public /api surface that replaces the Hono backend. It links
//! crates/auth in-process (its router, extractors, CSRF layer and server.db
//! pool) and reaches the internal services (recommender, media-core,
//! transcoder, iptv) and the *arr/SAB/TMDB/OMDb upstreams through one client.

pub mod account;
pub mod app;
pub mod arr;
pub mod backup;
pub mod config;
pub mod jsonl;
pub mod media_token;
pub mod parental;
pub mod plex;
pub mod principal;
pub mod proxy;
pub mod ratings;
pub mod recommender;
pub mod routes;
pub mod stores;
pub mod suggestions;
pub mod syncplay;
pub mod telemetry;
pub mod tmdb;
pub mod trailer;
pub mod upstream;
pub mod usage;

#[cfg(test)]
mod edge_goldens;
#[cfg(test)]
mod store_goldens;
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
    /// The per-user JSON stores.
    pub stores: Arc<stores::Stores>,
    /// Serializes the two-store feedback writes per title.
    pub item_locks: Arc<routes::ItemLocks>,
    pub syncplay: Arc<syncplay::Syncplay>,
    /// server.db's server_id for internal principals, once resolved.
    pub server_id: Arc<tokio::sync::OnceCell<String>>,
    /// Reservation ledgers, mutate limiters and the grab log.
    pub arr: Arc<arr::ArrState>,
    /// The title_ratings fill queue.
    pub ratings: Arc<ratings::Ratings>,
    /// Trailer resolver caches and the mux single-flight.
    pub trailers: Arc<trailer::Trailers>,
    /// The suggestion strip's caches, rotation and media.db handle.
    pub suggestions: Arc<suggestions::Suggestions>,
    /// data/usage.jsonl: one line per Claude call.
    pub usage: Arc<jsonl::JsonlLog>,
    /// The streaming proxies' client and the grant's readiness timings.
    pub proxy: Arc<proxy::Proxy>,
    /// Radarr/Sonarr certification caches for the rating gate.
    pub certs: Arc<parental::Certs>,
    /// The per-sub "Play in Plex" link maps.
    pub plex_links: Arc<plex::Links>,
    /// POST /api/telemetry/tunnel's bucket.
    pub tunnel: Arc<media_core::rate_limit::RateLimiter>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config) -> AppState {
        AppState {
            auth: AuthState::new(pool, config.auth.clone()),
            spa_dir: config.auth.serve_spa.then(|| PathBuf::from("./dist")),
            upstream: Upstream::default(),
            stores: Arc::new(stores::Stores::new(&config)),
            item_locks: Arc::default(),
            syncplay: Arc::default(),
            server_id: Arc::default(),
            arr: Arc::new(arr::ArrState::new(&config, arr::shared::Timings::default())),
            ratings: Arc::default(),
            trailers: Arc::default(),
            suggestions: Arc::default(),
            usage: Arc::new(jsonl::JsonlLog::new(&config.usage_log_path)),
            proxy: Arc::default(),
            certs: Arc::default(),
            plex_links: Arc::default(),
            tunnel: Arc::new(telemetry::tunnel_limiter()),
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
