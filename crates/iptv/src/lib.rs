//! iptv service: sole owner of `iptv.db` and the only process that dials the
//! Xtream provider. Hono keeps auth and policy and forwards `/api/iptv/*` and
//! `/api/dvr/*` here (see `api`); the binary also runs the catalog + EPG sync
//! scheduler, the DVR recorder and the nightly iptv.db snapshot.

pub mod api;
pub mod backup;
pub mod catalog;
pub mod concurrency;
pub mod config;
pub mod db;
pub mod dvr;
pub mod egress;
pub mod epg;
pub mod epg_resolve;
pub mod feed_checks;
pub mod feed_sweep;
pub mod feed_verify;
pub mod fingerprint;
pub mod hls;
pub mod playlist;
pub mod remux;
pub mod remux_map;
pub mod scheduler;
pub mod siblings;
pub mod streams;
pub mod sync;
pub mod xmltv;
pub mod xtream;

#[cfg(test)]
mod testpanel;
