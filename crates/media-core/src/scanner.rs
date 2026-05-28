//! Library scanner. Walks the configured roots, probes new/changed files
//! with ffprobe, classifies them via `filename::parse_filename`, and upserts
//! `media_files` + `movies`/`shows`/`episodes`.
//!
//! OWNER: agent B. Implement `scan_once`. Use `walkdir` to enumerate video
//! files (mkv, mp4, m4v, mov, avi, ts, webm). Skip files already present
//! with an unchanged `(path, size_bytes, mtime)` — reprobing is the slow
//! part. For new/changed files: probe → insert/replace `media_files` →
//! classify name → upsert into `movies` or `shows`+`episodes`. TMDB enrich
//! is best-effort and must never fail the scan. Return a [`ScanReport`].
//! Target: a 100-file fixture library scans in < 5s (§ success criteria).

use std::path::PathBuf;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanReport {
    pub files_seen: usize,
    pub files_added: usize,
    pub files_updated: usize,
    pub movies: usize,
    pub episodes: usize,
    pub errors: usize,
}

/// Run one full scan pass over `roots`, mutating `db`.
pub async fn scan_once(_db: &Db, _roots: &[PathBuf]) -> Result<ScanReport, AppError> {
    todo!("AGENT B: implement the library scan (walk → probe → classify → upsert)")
}

/// Video extensions the scanner considers. Shared so tests and the walker
/// agree.
pub const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "m4v", "mov", "avi", "ts", "webm"];

pub fn is_video_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| VIDEO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}
