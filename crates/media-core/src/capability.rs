//! Direct-play vs transcode decision (§3.5). Pure function over the file's
//! cached probe metadata + the client's advertised capabilities.
//!
//! OWNER: agent C. Implement `decide`. A file direct-plays when its
//! container, video codec, height, and HDR format are all within the
//! client's caps; otherwise transcode is required (→ HTTP 503 in M3-only
//! deployments). Unit-test the matrix: matching codec/container → direct;
//! HEVC to an h264-only client → transcode; HDR to an SDR-only client →
//! transcode; height over `max_height` → transcode.

use serde::{Deserialize, Serialize};

use crate::models::MediaFileRow;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ClientCaps {
    #[serde(default)]
    pub containers: Vec<String>,
    #[serde(default)]
    pub video_codecs: Vec<String>,
    #[serde(default)]
    pub max_height: Option<i64>,
    #[serde(default)]
    pub hdr: bool,
    #[serde(default)]
    pub max_bitrate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlayDecision {
    pub direct_play: bool,
    pub reason: String,
}

/// Decide whether `file` can be sent as-is to a client with `caps`.
pub fn decide(_file: &MediaFileRow, _caps: &ClientCaps) -> PlayDecision {
    todo!("AGENT C: implement direct-play capability matching")
}
