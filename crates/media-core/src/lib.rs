//! media-core (M3) — The Emerald Exchange Rust library server.
//!
//! Scans local media roots, owns `media.db`, and serves a direct-play
//! library + watch state to Hono over the internal-principal boundary
//! (§4 Hybrid D). Hono proxies `/api/media/*`; media-core never speaks to
//! the SPA directly. ffprobe/ffmpeg are runtime deps invoked via
//! `tokio::process::Command` — no FFI bindings.

pub mod auth;
pub mod capability;
pub mod config;
pub mod db;
pub mod error;
pub mod filename;
pub mod models;
pub mod probe;
pub mod routes;
pub mod scanner;
pub mod tmdb;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Current `media.db` schema version. Bump in lockstep with a new file in
/// `migrations/` and the `db::MIGRATIONS` table.
pub const SCHEMA_VERSION: i64 = 2;

/// Shared application state, cheap to clone (pool + Arc'd config). The
/// `scanning` flag guards the background scan so a second `POST /scan`
/// returns `409` while one is already in flight.
#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub config: Arc<config::Config>,
    pub tmdb: tmdb::TmdbClient,
    pub scanning: Arc<AtomicBool>,
}

/// Build the full axum router (public `/health` + `/version`, authed
/// `/api/media/*`).
pub fn build_router(state: AppState) -> axum::Router {
    routes::router(state)
}
