//! The *arr and SAB surface: /api/sonarr, /api/radarr, /api/sab,
//! /api/grabs, /api/notifications, and the state they share (reservation
//! ledgers, the per-session mutate limiters, the grab log).

pub mod grabs;
pub mod notifications;
pub mod radarr;
pub mod sab;
pub mod shared;
pub mod sonarr;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::http::Method;
use axum::response::{IntoResponse, Response};
use media_core::rate_limit::RateLimiter;

use crate::AppState;
use crate::config::Config;
use crate::jsonl::JsonlLog;
use crate::stores::Section;
use shared::{GB, GrabLog, Ledger, Timings};

pub struct ArrState {
    pub timings: Timings,
    /// Each app's own in-flight disk reservations.
    pub sonarr_ledger: Ledger,
    pub radarr_ledger: Ledger,
    /// Per-session buckets on the release-search-bearing mutations: each one
    /// is a real indexer search or queue/disk work.
    pub sonarr_limit: RateLimiter,
    pub radarr_limit: RateLimiter,
    pub sab_limit: RateLimiter,
    pub grabs: GrabLog,
    /// Serializes every /api/notifications/discord mutation and test.
    pub discord: tokio::sync::Mutex<()>,
    /// Background TV grabs still running.
    tv_grabs: tokio::sync::watch::Sender<usize>,
}

impl ArrState {
    pub fn new(c: &Config, timings: Timings) -> ArrState {
        let limiter = || {
            RateLimiter::new(
                c.arr_mutate_rate_capacity,
                c.arr_mutate_rate_refill,
                Duration::from_millis(c.arr_mutate_rate_interval_ms),
            )
        };
        ArrState {
            timings,
            sonarr_ledger: Ledger::new("sonarr", c.min_free_gb * GB),
            radarr_ledger: Ledger::new("radarr", c.min_free_gb * GB),
            sonarr_limit: limiter(),
            radarr_limit: limiter(),
            sab_limit: limiter(),
            grabs: GrabLog(JsonlLog::new(&c.grab_log_path)),
            discord: tokio::sync::Mutex::new(()),
            tv_grabs: tokio::sync::watch::Sender::new(0),
        }
    }

    /// Resolves once no background TV grab is running (the completion hook
    /// tests await).
    pub async fn idle(&self) {
        let mut rx = self.tv_grabs.subscribe();
        // The sender lives in self, so the channel cannot close here.
        let _ = rx.wait_for(|n| *n == 0).await;
    }
}

/// Counts one background TV grab from spawn to finish.
pub(crate) struct Busy(Arc<ArrState>);

impl Busy {
    pub(crate) fn new(arr: &Arc<ArrState>) -> Busy {
        arr.tv_grabs.send_modify(|n| *n += 1);
        Busy(arr.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.tv_grabs.send_modify(|n| *n -= 1);
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(sonarr::router())
        .merge(radarr::router())
        .merge(sab::router())
        .merge(grabs::router())
        .merge(notifications::router())
}

/// The gates Hono stacked on a route, in its order: the section policy
/// (only for mutations when `mutations_only`), then admin, then the
/// per-session bucket. Admins are never section-blocked.
pub(crate) async fn gate(
    st: &AppState,
    p: &auth::Principal,
    method: &Method,
    section: (Section, bool),
    admin: bool,
    limit: Option<&RateLimiter>,
) -> Result<(), Response> {
    let (section, mutations_only) = section;
    let read = matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    if !(mutations_only && read) {
        st.stores
            .policies
            .require_section(&p.session, section)
            .await?;
    }
    if admin && p.session.role != auth::Role::Admin {
        return Err(auth::Rejection::AdminOnly.into_response());
    }
    if let Some(l) = limit {
        l.check(&format!("sub:{}", p.session.sub))?;
    }
    Ok(())
}

#[cfg(test)]
mod fake;
#[cfg(test)]
mod goldens;
#[cfg(test)]
mod tests;
