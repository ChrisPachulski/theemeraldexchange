//! iptv service: sole owner of `iptv.db` and the only process that dials the
//! Xtream provider. Hono keeps auth and policy and forwards `/api/iptv/*` and
//! `/api/dvr/*` here once the routes are ported; for now the binary serves
//! `/healthz` and runs the catalog + EPG sync scheduler.

pub mod config;
pub mod db;
pub mod epg;
pub mod epg_resolve;
pub mod scheduler;
pub mod sync;
pub mod xmltv;
pub mod xtream;

#[cfg(test)]
mod testpanel;

pub fn build_router() -> axum::Router {
    axum::Router::new().route("/healthz", axum::routing::get(|| async { "ok" }))
}
