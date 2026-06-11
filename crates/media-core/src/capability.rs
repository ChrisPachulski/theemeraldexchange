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
    /// Maximum average bitrate (bits/second) the client wants to receive.
    /// Evaluated against the file's size/duration-derived average in
    /// [`decide`]; a file over the cap is routed to the transcoder.
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

/// Canonical container family used ONLY for comparison in [`decide`]; the
/// probed value stays stored as-is for honesty.
///
/// ffprobe reports one demuxer name for a whole family and the probe pins its
/// FIRST token: every ISO-BMFF/QuickTime file (.mp4/.mov/.m4v/…) probes as
/// `format_name = "mov,mp4,m4a,3gp,3g2,mj2"` and is stored as `container =
/// "mov"`, while clients advertise `containers: ["mp4"]` (server
/// DEFAULT_CAPS + SPA browserCaps). Without normalization no mp4 file ever
/// direct-plays. The mov family is one container format, so any member token
/// matches any other. Likewise `.mkv` probes as `"matroska,webm"` → stored
/// `"matroska"`, while a capable client would say `"mkv"`. `webm` is NOT
/// folded into that family: ffprobe cannot distinguish webm from mkv (same
/// demuxer), so a webm-only client must not be handed arbitrary matroska
/// files — it keeps its own token and only the explicit `matroska` stored
/// value matches `mkv`.
fn container_family(c: &str) -> &str {
    const MOV_FAMILY: &[&str] = &["mov", "mp4", "m4a", "m4v", "3gp", "3g2", "mj2"];
    if MOV_FAMILY.iter().any(|m| c.eq_ignore_ascii_case(m)) {
        return "mp4";
    }
    if c.eq_ignore_ascii_case("matroska") || c.eq_ignore_ascii_case("mkv") {
        return "mkv";
    }
    c
}

/// Case-insensitive, family-normalized container match (see
/// [`container_family`]).
fn container_supported(caps: &[String], stored: &str) -> bool {
    let stored_family = container_family(stored);
    caps.iter()
        .any(|c| container_family(c).eq_ignore_ascii_case(stored_family))
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
    if !container_supported(&caps.containers, container) {
        return deny(format!("container {container} not supported by client"));
    }

    let codec = match file.video_codec.as_deref().map(str::trim) {
        Some(c) if !c.is_empty() => c,
        _ => return deny("unknown codec"),
    };
    if !contains_ci(&caps.video_codecs, codec) {
        return deny(format!("codec {codec} not supported by client"));
    }

    if let (Some(max), Some(height)) = (caps.max_height, file.video_height)
        && height > max
    {
        return deny(format!("height {height} exceeds client max {max}"));
    }

    // Bandwidth gate: `max_bitrate` is bits/second; the probe records no
    // per-stream bitrate, so the file's whole-container average
    // (size_bytes * 8 / duration) is the comparison. Files missing a positive
    // duration are not gated — no average can be derived.
    if let (Some(max), Some(duration)) = (caps.max_bitrate, file.duration_secs)
        && max > 0
        && duration > 0
        && file.size_bytes > 0
    {
        let avg_bps = file.size_bytes.saturating_mul(8) / duration;
        if avg_bps > max {
            return deny(format!("bitrate {avg_bps} exceeds client max {max}"));
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

    // The primary audio must be decodable by the client too. A direct-play hands
    // the raw file to the client's <video> element; the shipped client is a
    // browser (hls.js/native HLS), which decodes AAC universally but NOT
    // AC-3/E-AC-3/DTS — those direct-play with dead audio. So a non-AAC primary
    // track denies direct-play, routing the file to the transcode path which
    // re-encodes audio to AAC (mirrors transcoder::plan::accepted_audio_codecs).
    // An unknown/absent audio codec is left to direct-play (nothing to gate on).
    // TODO(M4+): when ClientCaps carries an `audio_codecs` set, gate on the
    // client's real capabilities (Apple AVPlayer can pass AC-3/E-AC-3 through and
    // should direct-play them) instead of this fixed browser-safe baseline.
    if let Some(track) = file.audio_tracks().first() {
        let acodec = track.codec.as_deref().map(str::trim).unwrap_or("");
        if !acodec.is_empty() && !acodec.eq_ignore_ascii_case("aac") {
            return deny(format!("audio codec {acodec} not supported by client"));
        }
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
    fn probed_mov_container_direct_plays_to_mp4_client() {
        // REGRESSION: every real mp4 file is stored with container "mov" (the
        // first token of ffprobe's "mov,mp4,m4a,3gp,3g2,mj2" demuxer name,
        // pinned in probe.rs), while the Hono default and SPA browserCaps both
        // advertise containers:["mp4"]. The family normalization must let
        // these direct-play; without it NO mp4 in the library ever did.
        let f = file(Some("mov"), Some("h264"), Some(1080), None);
        let d = decide(&f, &h264_client());
        assert!(d.direct_play, "mov-family must match mp4 caps: {}", d.reason);
    }

    #[test]
    fn mov_family_aliasing_is_case_insensitive_and_symmetric() {
        // Any member of the ISO-BMFF/QuickTime family matches any other.
        for stored in ["MOV", "m4v", "mp4"] {
            let f = file(Some(stored), Some("h264"), Some(1080), None);
            assert!(
                decide(&f, &h264_client()).direct_play,
                "{stored} must match mp4 caps"
            );
        }
        // And a mov-advertising client plays a stored mp4.
        let mut caps = h264_client();
        caps.containers = vec!["mov".to_string()];
        let f = file(Some("mp4"), Some("h264"), Some(1080), None);
        assert!(decide(&f, &caps).direct_play);
    }

    #[test]
    fn mkv_still_transcodes_for_mp4_client() {
        // The normalization must NOT widen what an mp4-only browser accepts:
        // matroska (the stored token for .mkv) still routes to the transcoder.
        for stored in ["matroska", "mkv", "webm"] {
            let f = file(Some(stored), Some("h264"), Some(1080), None);
            let d = decide(&f, &h264_client());
            assert!(!d.direct_play, "{stored} must not match mp4 caps");
            assert!(d.reason.contains("container"), "reason: {}", d.reason);
        }
    }

    #[test]
    fn stored_matroska_matches_mkv_caps_but_not_webm() {
        // A client advertising "mkv" plays the stored "matroska" token…
        let mut caps = h264_client();
        caps.containers = vec!["mkv".to_string()];
        let f = file(Some("matroska"), Some("h264"), Some(1080), None);
        assert!(decide(&f, &caps).direct_play);

        // …but webm is NOT folded into the matroska family: ffprobe cannot
        // tell webm from mkv, so a webm-only client never receives matroska.
        caps.containers = vec!["webm".to_string()];
        assert!(!decide(&f, &caps).direct_play);
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

    fn with_audio(mut f: MediaFileRow, codec: &str) -> MediaFileRow {
        f.audio_tracks_json = format!(
            r#"[{{"index":1,"codec":"{codec}","channels":6,"language":"eng","title":null}}]"#
        );
        f
    }

    #[test]
    fn eac3_audio_denies_direct_play() {
        // mp4/h264/SDR/1080p would direct-play, but E-AC-3 audio is undecodable
        // by the browser <video>, so it must transcode (→ AAC). Regression for
        // the 200+ direct-play-eligible files that were shipping silent audio.
        let f = with_audio(file(Some("mp4"), Some("h264"), Some(1080), None), "eac3");
        let d = decide(&f, &h264_client());
        assert!(!d.direct_play, "eac3 must not direct-play");
        assert!(d.reason.contains("audio"), "reason: {}", d.reason);
    }

    #[test]
    fn ac3_and_dts_audio_deny_direct_play() {
        for codec in ["ac3", "dts", "truehd"] {
            let f = with_audio(file(Some("mp4"), Some("h264"), Some(720), None), codec);
            assert!(
                !decide(&f, &h264_client()).direct_play,
                "{codec} must transcode"
            );
        }
    }

    #[test]
    fn aac_audio_still_direct_plays() {
        let f = with_audio(file(Some("mp4"), Some("h264"), Some(1080), None), "aac");
        assert!(
            decide(&f, &h264_client()).direct_play,
            "aac must direct-play"
        );
    }

    #[test]
    fn aac_audio_match_is_case_insensitive() {
        let f = with_audio(file(Some("mp4"), Some("h264"), Some(1080), None), "AAC");
        assert!(decide(&f, &h264_client()).direct_play);
    }

    #[test]
    fn bitrate_over_client_max_transcodes() {
        // 9 GB over 3600s ≈ 20 Mbps average. A 10 Mbps client must transcode;
        // a 25 Mbps client direct-plays the same file.
        let mut f = file(Some("mp4"), Some("h264"), Some(1080), None);
        f.size_bytes = 9_000_000_000;
        f.duration_secs = Some(3600);

        let mut caps = h264_client();
        caps.max_bitrate = Some(10_000_000);
        let d = decide(&f, &caps);
        assert!(!d.direct_play);
        assert!(d.reason.contains("bitrate"), "reason: {}", d.reason);

        caps.max_bitrate = Some(25_000_000);
        assert!(decide(&f, &caps).direct_play);
    }

    #[test]
    fn bitrate_gate_skipped_without_duration_or_cap() {
        // No duration → no derivable average → not gated.
        let mut f = file(Some("mp4"), Some("h264"), Some(1080), None);
        f.size_bytes = 9_000_000_000;
        f.duration_secs = None;
        let mut caps = h264_client();
        caps.max_bitrate = Some(10_000_000);
        assert!(decide(&f, &caps).direct_play);

        // No advertised cap → never gated (back-compat default).
        let f = file(Some("mp4"), Some("h264"), Some(1080), None);
        assert!(decide(&f, &h264_client()).direct_play);
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
