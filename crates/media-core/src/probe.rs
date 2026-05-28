//! ffprobe integration. Spawns the system `ffprobe` via
//! `tokio::process::Command` (NO ffmpeg FFI bindings — same pattern as
//! Jellyfin) and parses its JSON into a [`FileProbe`].
//!
//! OWNER: agent A. Implement `ffprobe` (spawn + run) and `parse_ffprobe_json`
//! (pure). Unit-test `parse_ffprobe_json` heavily against captured fixtures
//! covering: h264/hevc, HDR (color_transfer smpte2084 / arib-std-b67),
//! multi audio/subtitle tracks, missing fields.

use std::path::Path;

use serde_json::Value;
use tokio::process::Command;

use crate::models::{AudioTrack, FileProbe, SubtitleTrack};

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
pub async fn ffprobe(path: &Path) -> Result<FileProbe, ProbeError> {
    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(path)
        .output()
        .await
        .map_err(|e| ProbeError::Spawn(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ProbeError::Failed(format!(
            "status {}: {}",
            output.status,
            stderr.trim()
        )));
    }

    let doc: Value =
        serde_json::from_slice(&output.stdout).map_err(|e| ProbeError::Parse(e.to_string()))?;

    Ok(parse_ffprobe_json(&doc))
}

/// Pure: map ffprobe's JSON document to a [`FileProbe`]. Keep this free of
/// I/O so it is exhaustively unit-testable.
pub fn parse_ffprobe_json(doc: &Value) -> FileProbe {
    let format = doc.get("format");

    let container = format
        .and_then(|f| f.get("format_name"))
        .and_then(Value::as_str)
        .and_then(|s| s.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let duration_secs = format
        .and_then(|f| f.get("duration"))
        .and_then(parse_f64)
        .map(|d| d.round() as i64);

    let streams = doc
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let video = streams.iter().find(|s| stream_type(s) == Some("video"));

    let video_codec = video
        .and_then(|s| s.get("codec_name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let video_height = video.and_then(|s| s.get("height")).and_then(parse_i64);

    let video_profile = video
        .and_then(|s| s.get("profile"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let hdr_format = video.and_then(detect_hdr);

    let audio_tracks = streams
        .iter()
        .filter(|s| stream_type(s) == Some("audio"))
        .map(|s| AudioTrack {
            index: s.get("index").and_then(parse_i64).unwrap_or(0),
            codec: s
                .get("codec_name")
                .and_then(Value::as_str)
                .map(str::to_string),
            channels: s.get("channels").and_then(parse_i64),
            language: tag(s, "language"),
            title: tag(s, "title"),
        })
        .collect();

    let subtitle_tracks = streams
        .iter()
        .filter(|s| stream_type(s) == Some("subtitle"))
        .map(|s| SubtitleTrack {
            index: s.get("index").and_then(parse_i64).unwrap_or(0),
            codec: s
                .get("codec_name")
                .and_then(Value::as_str)
                .map(str::to_string),
            language: tag(s, "language"),
            title: tag(s, "title"),
            forced: s
                .get("disposition")
                .and_then(|d| d.get("forced"))
                .and_then(parse_i64)
                .map(|f| f == 1)
                .unwrap_or(false),
        })
        .collect();

    FileProbe {
        container,
        duration_secs,
        video_codec,
        video_height,
        video_profile,
        hdr_format,
        audio_tracks,
        subtitle_tracks,
    }
}

/// `codec_type` of a stream, if present.
fn stream_type(stream: &Value) -> Option<&str> {
    stream.get("codec_type").and_then(Value::as_str)
}

/// Read a value from a stream's `tags` object as a string.
fn tag(stream: &Value, key: &str) -> Option<String> {
    stream
        .get("tags")
        .and_then(|t| t.get(key))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Derive an HDR label from the video stream. Dolby Vision is detected via a
/// side-data entry; otherwise the transfer characteristics decide HDR10/HLG.
fn detect_hdr(video: &Value) -> Option<String> {
    let dolby_vision = video
        .get("side_data_list")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter().any(|sd| {
                sd.get("side_data_type")
                    .and_then(Value::as_str)
                    .map(|t| t.contains("Dolby Vision"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);

    if dolby_vision {
        return Some("Dolby Vision".to_string());
    }

    match video.get("color_transfer").and_then(Value::as_str) {
        Some("smpte2084") => Some("HDR10".to_string()),
        Some("arib-std-b67") => Some("HLG".to_string()),
        _ => None,
    }
}

/// Parse a JSON value that may be a number or a numeric string into f64.
fn parse_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// Parse a JSON value that may be a number or a numeric string into i64.
fn parse_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => s
            .parse::<i64>()
            .ok()
            .or_else(|| s.parse::<f64>().ok().map(|f| f.round() as i64)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn h264_mp4_sdr_stereo_aac() {
        let doc = json!({
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "5400.480000"
            },
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "height": 1080,
                    "profile": "High",
                    "color_transfer": "bt709"
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2,
                    "tags": { "language": "eng", "title": "Stereo" }
                }
            ]
        });

        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.container.as_deref(), Some("mov"));
        assert_eq!(probe.duration_secs, Some(5400));
        assert_eq!(probe.video_codec.as_deref(), Some("h264"));
        assert_eq!(probe.video_height, Some(1080));
        assert_eq!(probe.video_profile.as_deref(), Some("High"));
        assert_eq!(probe.hdr_format, None);

        assert_eq!(probe.audio_tracks.len(), 1);
        let a = &probe.audio_tracks[0];
        assert_eq!(a.index, 1);
        assert_eq!(a.codec.as_deref(), Some("aac"));
        assert_eq!(a.channels, Some(2));
        assert_eq!(a.language.as_deref(), Some("eng"));
        assert_eq!(a.title.as_deref(), Some("Stereo"));
        assert!(probe.subtitle_tracks.is_empty());
    }

    #[test]
    fn hevc_mkv_hdr10_multi_audio_forced_sub() {
        let doc = json!({
            "format": {
                "format_name": "matroska,webm",
                "duration": "7200.000000"
            },
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "height": 2160,
                    "profile": "Main 10",
                    "color_transfer": "smpte2084"
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "truehd",
                    "channels": 8,
                    "tags": { "language": "eng" }
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "ac3",
                    "channels": 6,
                    "tags": { "language": "fra", "title": "Commentary" }
                },
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "subrip",
                    "tags": { "language": "eng", "title": "Forced" },
                    "disposition": { "forced": 1 }
                }
            ]
        });

        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.container.as_deref(), Some("matroska"));
        assert_eq!(probe.duration_secs, Some(7200));
        assert_eq!(probe.video_codec.as_deref(), Some("hevc"));
        assert_eq!(probe.video_height, Some(2160));
        assert_eq!(probe.video_profile.as_deref(), Some("Main 10"));
        assert_eq!(probe.hdr_format.as_deref(), Some("HDR10"));

        assert_eq!(probe.audio_tracks.len(), 2);
        assert_eq!(probe.audio_tracks[0].codec.as_deref(), Some("truehd"));
        assert_eq!(probe.audio_tracks[0].channels, Some(8));
        assert_eq!(probe.audio_tracks[1].language.as_deref(), Some("fra"));
        assert_eq!(probe.audio_tracks[1].title.as_deref(), Some("Commentary"));

        assert_eq!(probe.subtitle_tracks.len(), 1);
        let s = &probe.subtitle_tracks[0];
        assert_eq!(s.index, 3);
        assert_eq!(s.codec.as_deref(), Some("subrip"));
        assert_eq!(s.language.as_deref(), Some("eng"));
        assert!(s.forced);
    }

    #[test]
    fn hlg_transfer_maps_to_hlg() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "color_transfer": "arib-std-b67"
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.hdr_format.as_deref(), Some("HLG"));
    }

    #[test]
    fn dolby_vision_side_data_wins() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "color_transfer": "smpte2084",
                    "side_data_list": [
                        { "side_data_type": "DOVI configuration record" },
                        { "side_data_type": "Dolby Vision Metadata" }
                    ]
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.hdr_format.as_deref(), Some("Dolby Vision"));
    }

    #[test]
    fn missing_fields_default_to_none_and_empty() {
        let doc = json!({});
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe, FileProbe::default());
        assert_eq!(probe.container, None);
        assert_eq!(probe.duration_secs, None);
        assert_eq!(probe.video_codec, None);
        assert_eq!(probe.video_height, None);
        assert_eq!(probe.video_profile, None);
        assert_eq!(probe.hdr_format, None);
        assert!(probe.audio_tracks.is_empty());
        assert!(probe.subtitle_tracks.is_empty());
    }

    #[test]
    fn numeric_duration_and_height_as_json_numbers() {
        let doc = json!({
            "format": { "format_name": "matroska", "duration": 60.6 },
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "vp9", "height": 720 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.duration_secs, Some(61));
        assert_eq!(probe.video_height, Some(720));
    }
}
