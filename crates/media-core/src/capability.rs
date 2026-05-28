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

fn contains_ci(haystack: &[String], needle: &str) -> bool {
    haystack.iter().any(|c| c.eq_ignore_ascii_case(needle))
}

fn deny(reason: impl Into<String>) -> PlayDecision {
    PlayDecision {
        direct_play: false,
        reason: reason.into(),
    }
}

/// Decide whether `file` can be sent as-is to a client with `caps`.
pub fn decide(file: &MediaFileRow, caps: &ClientCaps) -> PlayDecision {
    let container = match file.container.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => c,
        _ => return deny("unknown container"),
    };
    if !contains_ci(&caps.containers, container) {
        return deny(format!("container {container} not supported by client"));
    }

    let codec = match file.video_codec.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => c,
        _ => return deny("unknown codec"),
    };
    if !contains_ci(&caps.video_codecs, codec) {
        return deny(format!("codec {codec} not supported by client"));
    }

    if let (Some(max), Some(height)) = (caps.max_height, file.video_height) {
        if height > max {
            return deny(format!("height {height} exceeds client max {max}"));
        }
    }

    let is_hdr = file
        .hdr_format
        .as_deref()
        .map(str::trim)
        .is_some_and(|h| !h.is_empty());
    if is_hdr && !caps.hdr {
        return deny("hdr requires tone-map");
    }

    PlayDecision {
        direct_play: true,
        reason: "direct play".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(
        container: Option<&str>,
        video_codec: Option<&str>,
        video_height: Option<i64>,
        hdr_format: Option<&str>,
    ) -> MediaFileRow {
        MediaFileRow {
            id: 1,
            path: "/library/movie.mkv".to_string(),
            size_bytes: 1_000_000,
            mtime: "2026-05-28T00:00:00Z".to_string(),
            container: container.map(str::to_string),
            duration_secs: Some(7200),
            video_codec: video_codec.map(str::to_string),
            video_height,
            video_profile: Some("main".to_string()),
            hdr_format: hdr_format.map(str::to_string),
            audio_tracks_json: "[]".to_string(),
            subtitle_tracks_json: "[]".to_string(),
            scanned_at: "2026-05-28T00:00:00Z".to_string(),
        }
    }

    fn h264_client() -> ClientCaps {
        ClientCaps {
            containers: vec!["mp4".to_string()],
            video_codecs: vec!["h264".to_string()],
            max_height: Some(1080),
            hdr: false,
            max_bitrate: None,
        }
    }

    #[test]
    fn matching_mp4_h264_1080p_sdr_direct_plays() {
        let f = file(Some("mp4"), Some("h264"), Some(1080), None);
        let d = decide(&f, &h264_client());
        assert!(d.direct_play, "expected direct play, got {}", d.reason);
        assert_eq!(d.reason, "direct play");
    }

    #[test]
    fn container_match_is_case_insensitive() {
        let f = file(Some("MP4"), Some("H264"), Some(720), None);
        assert!(decide(&f, &h264_client()).direct_play);
    }

    #[test]
    fn hevc_to_h264_only_client_transcodes() {
        let f = file(Some("mp4"), Some("hevc"), Some(1080), None);
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play);
        assert!(d.reason.contains("hevc"), "reason: {}", d.reason);
    }

    #[test]
    fn hdr10_to_sdr_only_client_transcodes() {
        let f = file(Some("mp4"), Some("h264"), Some(1080), Some("HDR10"));
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play);
        assert_eq!(d.reason, "hdr requires tone-map");
    }

    #[test]
    fn hdr_file_to_hdr_capable_client_direct_plays() {
        let mut caps = h264_client();
        caps.hdr = true;
        caps.max_height = Some(2160);
        let f = file(Some("mp4"), Some("h264"), Some(2160), Some("HDR10"));
        assert!(decide(&f, &caps).direct_play);
    }

    #[test]
    fn height_over_max_transcodes() {
        let f = file(Some("mp4"), Some("h264"), Some(2160), None);
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play);
        assert_eq!(d.reason, "height 2160 exceeds client max 1080");
    }

    #[test]
    fn no_max_height_allows_any_height() {
        let mut caps = h264_client();
        caps.max_height = None;
        let f = file(Some("mp4"), Some("h264"), Some(4320), None);
        assert!(decide(&f, &caps).direct_play);
    }

    #[test]
    fn unknown_codec_transcodes() {
        let f = file(Some("mp4"), None, Some(1080), None);
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play);
        assert_eq!(d.reason, "unknown codec");
    }

    #[test]
    fn unknown_container_transcodes() {
        let f = file(None, Some("h264"), Some(1080), None);
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play);
        assert_eq!(d.reason, "unknown container");
    }

    #[test]
    fn empty_hdr_format_is_treated_as_sdr() {
        let f = file(Some("mp4"), Some("h264"), Some(1080), Some(""));
        assert!(decide(&f, &h264_client()).direct_play);
    }
}
