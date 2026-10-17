//! iptv service: sole owner of `iptv.db` and the only process that dials the
//! Xtream provider. Hono keeps auth and policy and forwards `/api/iptv/*` and
//! `/api/dvr/*` here (see `api`); the binary also runs the catalog + EPG sync
//! scheduler.

pub mod api;
pub mod catalog;
pub mod config;
pub mod db;
pub mod epg;
pub mod epg_resolve;
pub mod playlist;
pub mod scheduler;
pub mod sync;
pub mod xmltv;
pub mod xtream;

#[cfg(test)]
mod testpanel;
