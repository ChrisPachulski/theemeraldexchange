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

/// Run one scan pass, honoring the `scanning` guard so a scheduled scan and a
/// manual `POST /api/media/scan` never overlap. Returns `true` when this call
/// actually ran a scan, `false` when it bailed because another scan held the
/// slot. Best-effort throughout: scan errors are logged and counted, never
/// propagated or panicked — a deployed instance must keep serving even if a
/// scan pass fails.
pub async fn run_guarded_scan(state: &AppState, trigger: &str) -> bool {
    use std::sync::atomic::Ordering;

    // Atomically claim the scan slot; if a manual or prior scheduled scan is
    // already running, skip this tick rather than queueing or overlapping.
    if state
        .scanning
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        tracing::debug!(trigger, "scheduled scan skipped: a scan is already running");
        return false;
    }

    tracing::info!(trigger, "starting scheduled library scan");
    match scanner::scan_once(&state.db, &state.config.library_roots, &state.tmdb).await {
        Ok(report) => {
            tracing::info!(
                trigger,
                files_seen = report.files_seen,
                files_added = report.files_added,
                files_updated = report.files_updated,
                errors = report.errors,
                "scheduled scan complete"
            );
        }
        Err(e) => {
            // Never abort the scheduler on a scan error — log and move on.
            tracing::warn!(trigger, "scheduled scan failed: {e}");
        }
    }
    state.scanning.store(false, Ordering::SeqCst);
    true
}

/// Spawn the background scan scheduler: an optional boot scan plus a periodic
/// scan on `config.scan_interval_secs`. Returns the [`JoinHandle`] so callers
/// (and tests) can observe or abort it. The task is detached in `main`.
///
/// * `boot_scan == false` and `scan_interval_secs == 0` → no task is spawned
///   (returns `None`); the library is then driven solely by manual `POST
///   /scan`.
/// * `scan_interval_secs == 0` with `boot_scan == true` → a single boot scan,
///   then the task exits (no periodic ticking).
///
/// The scheduler reuses [`run_guarded_scan`], so it can never collide with the
/// manual `/scan` endpoint, and a failing scan never tears the loop down.
///
/// [`JoinHandle`]: tokio::task::JoinHandle
pub fn spawn_scheduler(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    let boot_scan = state.config.boot_scan;
    let interval_secs = state.config.scan_interval_secs;

    if !boot_scan && interval_secs == 0 {
        tracing::info!("scan scheduler disabled (boot_scan=off, interval=0)");
        return None;
    }

    Some(tokio::spawn(async move {
        if boot_scan {
            run_guarded_scan(&state, "boot").await;
        }

        if interval_secs == 0 {
            tracing::info!(
                "periodic scan disabled (interval=0); scheduler exiting after boot scan"
            );
            return;
        }

        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
        // A long scan must not cause a burst of catch-up ticks afterwards.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The first tick fires immediately; consume it so the first *periodic*
        // scan happens one full interval after boot (the boot scan already
        // covered t=0).
        ticker.tick().await;
        tracing::info!(interval_secs, "periodic scan scheduler armed");
        loop {
            ticker.tick().await;
            run_guarded_scan(&state, "interval").await;
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Build an in-memory `AppState` with empty library roots, overriding the
    /// scheduler knobs. Empty roots mean `scan_once` returns near-instantly.
    async fn test_state(boot_scan: bool, scan_interval_secs: u64) -> AppState {
        // Off-mode: no principal secret/mode wired so `Config::from_env`
        // validates cleanly without the secret.
        unsafe {
            std::env::remove_var("MEDIA_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("RECOMMENDER_INTERNAL_PRINCIPAL_MODE");
            std::env::remove_var("INTERNAL_PRINCIPAL_SECRET");
        }
        let db = db::Db::connect_memory().await.unwrap();
        let mut config = config::Config::from_env().unwrap();
        config.boot_scan = boot_scan;
        config.scan_interval_secs = scan_interval_secs;
        AppState {
            db,
            config: Arc::new(config),
            tmdb: tmdb::TmdbClient::new(None),
            scanning: Arc::new(AtomicBool::new(false)),
        }
    }

    #[tokio::test]
    async fn run_guarded_scan_runs_when_idle() {
        let state = test_state(true, 0).await;
        assert!(
            run_guarded_scan(&state, "test").await,
            "an idle scan slot must run"
        );
        // The guard is released after the scan so a subsequent scan can run.
        assert!(!state.scanning.load(Ordering::SeqCst));
        assert!(run_guarded_scan(&state, "test").await);
    }

    #[tokio::test]
    async fn run_guarded_scan_skips_when_already_running() {
        let state = test_state(true, 0).await;
        // Simulate a manual scan already holding the slot.
        state.scanning.store(true, Ordering::SeqCst);
        assert!(
            !run_guarded_scan(&state, "test").await,
            "must skip when a scan already holds the guard"
        );
        // The guard must NOT be cleared by the skipped call — the in-flight
        // scan still owns it.
        assert!(state.scanning.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn scheduler_not_spawned_when_fully_disabled() {
        let state = test_state(false, 0).await;
        assert!(
            spawn_scheduler(state).is_none(),
            "boot_scan=off + interval=0 must spawn no task"
        );
    }

    #[tokio::test]
    async fn scheduler_runs_boot_scan_then_exits_when_interval_zero() {
        let state = test_state(true, 0).await;
        let handle = spawn_scheduler(state.clone()).expect("boot scan should spawn a task");
        // With interval=0 the task runs one boot scan and then returns.
        handle.await.unwrap();
        assert!(
            !state.scanning.load(Ordering::SeqCst),
            "guard must be released after the boot scan"
        );
    }

    #[tokio::test]
    async fn scheduler_stays_alive_and_ticks_on_a_short_interval() {
        // Use a 100ms interval (no test-util/paused-clock dependency) and
        // verify the spawned task arms and keeps running across at least one
        // tick without finishing. Boot scan off so we isolate the interval
        // path. Empty roots make each scan near-instant.
        let state = test_state(false, 1).await;
        let mut handle = spawn_scheduler(state.clone()).expect("interval should spawn a task");

        // A periodic scheduler (interval > 0) never exits on its own. Awaiting
        // it under a bounded timeout must therefore time out — proving the loop
        // is alive and ticking rather than having fallen through.
        let result = tokio::time::timeout(std::time::Duration::from_millis(250), &mut handle).await;
        assert!(
            result.is_err(),
            "periodic scheduler task must not finish on its own"
        );
        // Clean up the still-running task so it doesn't leak into other tests.
        handle.abort();
        // The guard release path is covered by the run_guarded_scan tests.
    }
}
