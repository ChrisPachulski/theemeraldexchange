//! transcoder (M4 scaffold) — The Emerald Exchange Rust transcode service.
//!
//! Turns media-core's "503 transcoder required" seam (§3.5) into a real grant:
//! it computes a capability-driven transcode PLAN (extending
//! `media_core::capability::decide`), runs ffmpeg via `tokio::process` to
//! produce an HLS ladder (mirroring `server/services/iptvRemux.ts`), and
//! manages session lifecycle (start / heartbeat / seek / stop) with a
//! supervisor, idle sweep, and concurrency caps.
//!
//! This is an honest SCAFFOLD: every module compiles and is unit-tested, the
//! ffmpeg binary is injectable so the session lifecycle is exercised end-to-end
//! against a shell stub, but real-codec transcode wiring (LL-HLS, ABR ladders,
//! true HW pipelines) is the multi-month long pole and is intentionally out of
//! scope here.

pub mod args;
pub mod concurrency;
pub mod encoders;
pub mod keyframes;
pub mod plan;
pub mod routes;
pub mod session;
mod trickplay;
mod vod_manifest;

pub use routes::{AppState, router};

/// Build the full axum router from the transcoder [`AppState`].
pub fn build_router(state: AppState) -> axum::Router {
    routes::router(state)
}
