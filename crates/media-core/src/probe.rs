//! ffprobe integration. Spawns the system `ffprobe` via
//! `tokio::process::Command` (NO ffmpeg FFI bindings — same pattern as
//! Jellyfin) and parses its JSON into a [`FileProbe`].
//!
//! OWNER: agent A. Implement `ffprobe` (spawn + run) and `parse_ffprobe_json`
//! (pure). Unit-test `parse_ffprobe_json` heavily against captured fixtures
//! covering: h264/hevc, HDR (color_transfer smpte2084 / arib-std-b67),
//! multi audio/subtitle tracks, missing fields.

use std::path::Path;

use crate::models::FileProbe;

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("ffprobe spawn failed: {0}")]
    Spawn(String),
    #[error("ffprobe exited non-zero: {0}")]
    Failed(String),
    #[error("ffprobe output parse error: {0}")]
    Parse(String),
}

/// Run `ffprobe -v quiet -print_format json -show_format -show_streams <path>`
/// and return parsed metadata.
pub async fn ffprobe(_path: &Path) -> Result<FileProbe, ProbeError> {
    todo!("AGENT A: spawn ffprobe via tokio::process::Command, then parse_ffprobe_json")
}

/// Pure: map ffprobe's JSON document to a [`FileProbe`]. Keep this free of
/// I/O so it is exhaustively unit-testable.
pub fn parse_ffprobe_json(_doc: &serde_json::Value) -> FileProbe {
    todo!("AGENT A: parse ffprobe JSON (format + streams) into FileProbe")
}
