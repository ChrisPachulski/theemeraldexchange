//! ffprobe integration. Spawns the system `ffprobe` via
//! `tokio::process::Command` (NO ffmpeg FFI bindings — same pattern as
//! Jellyfin) and parses its JSON into a [`FileProbe`].
//!
//! OWNER: agent A. Implement `ffprobe` (spawn + run) and `parse_ffprobe_json`
//! (pure). Unit-test `parse_ffprobe_json` heavily against captured fixtures
//! covering: h264/hevc/av1, HDR (color_transfer smpte2084 / arib-std-b67,
//! Dolby Vision with and without color_transfer, non-HDR wide-gamut transfers),
//! multi audio/subtitle tracks, untagged audio, attached_pic cover art,
//! multi-video first-wins selection, string-numeric and "N/A" fields,
//! missing fields.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

use crate::models::{AudioTrack, FileProbe, SubtitleTrack};

/// Wall-clock cap for a single `ffprobe` invocation. A corrupt/truncated file,
/// or a stalled network mount, can make ffprobe hang indefinitely; without a
/// deadline that wedges the (serial) scan slot forever and leaves `scanning`
/// stuck `true`, so `POST /scan` returns 409 permanently. 30s is generous for a
/// healthy probe and short enough that one bad file does not stall the library.
pub const PROBE_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("ffprobe spawn failed: {0}")]
    Spawn(String),
    #[error("ffprobe exited non-zero: {0}")]
    Failed(String),
    #[error("ffprobe output parse error: {0}")]
    Parse(String),
    #[error("ffprobe timed out after {0}s")]
    Timeout(u64),
}

/// Run `ffprobe -v quiet -print_format json -show_format -show_streams <path>`
/// and return parsed metadata.
///
/// The child is spawned with `kill_on_drop(true)` and awaited under a
/// [`PROBE_TIMEOUT_SECS`] deadline; on expiry it is force-killed and
/// [`ProbeError::Timeout`] is returned so the scanner can log it, count it, and
/// move on rather than blocking the scan forever. `-analyzeduration`/`-probesize`
/// bound how much of a well-formed-but-huge input ffprobe will read before it
/// reports, capping the common slow case in addition to the hard timeout.
pub async fn ffprobe(path: &Path) -> Result<FileProbe, ProbeError> {
    ffprobe_with_bin("ffprobe", path).await
}

/// Implementation with an injectable binary. Production passes the real
/// `ffprobe`; the scanner threads a custom bin so the crit-2 100-file timing
/// harness (and the timeout/throughput tests) can drive scan_once against a
/// deterministic stub instead of shelling out to the installed binary.
pub(crate) async fn ffprobe_with_bin(bin: &str, path: &Path) -> Result<FileProbe, ProbeError> {
    ffprobe_with_bin_timeout(bin, path, Duration::from_secs(PROBE_TIMEOUT_SECS)).await
}

/// Test-only crate-internal handle to the bin-injectable probe path, so
/// sibling test modules (e.g. scanner benchmarks) can drive a mock ffprobe
/// without shelling out to the real binary. Never compiled into release.
#[cfg(test)]
pub(crate) async fn ffprobe_with_bin_for_test(
    bin: &str,
    path: &Path,
) -> Result<FileProbe, ProbeError> {
    ffprobe_with_bin(bin, path).await
}

/// Test-only crate-internal re-export of the echoing stub writer (defined in
/// this module's `tests` submodule) so sibling test modules can build a
/// deterministic successful-ffprobe stub. Never compiled into release.
#[cfg(test)]
pub(crate) fn write_echoing_stub_path(dir: &std::path::Path) -> std::path::PathBuf {
    tests::write_echoing_stub(dir)
}

/// As [`ffprobe_with_bin`] but with an explicit deadline (tests use a short one
/// so the timeout path is exercised without a 30s wait).
async fn ffprobe_with_bin_timeout(
    bin: &str,
    path: &Path,
    deadline: Duration,
) -> Result<FileProbe, ProbeError> {
    let build = || {
        let mut cmd = Command::new(bin);
        cmd.arg("-v")
            .arg("quiet")
            .arg("-print_format")
            .arg("json")
            .arg("-show_format")
            .arg("-show_streams")
            .arg("-show_chapters")
            // Bound the bytes/μs ffprobe will analyze on pathologically large but
            // valid inputs (10s / 50MB are well above what stream metadata needs).
            .arg("-analyzeduration")
            .arg("10000000")
            .arg("-probesize")
            .arg("50000000")
            .arg(path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd
    };

    // Spawn, retrying the rare transient ETXTBSY ("text file busy"). On a loaded,
    // multi-threaded host another thread's `fork()` (every concurrent
    // `Command::spawn`) can momentarily inherit a just-written executable's
    // write fd — `O_CLOEXEC` closes it only at THAT child's `exec`, so an
    // `execve` racing the fork→exec window fails with ETXTBSY. This never fires
    // for the stable, installed `ffprobe` in production (it is never freshly
    // written), but it flaked tests that write+exec a fresh stub per case.
    // Errno-specific and bounded, with a short backoff.
    let mut child = None;
    for attempt in 0..6u8 {
        match build().spawn() {
            Ok(c) => {
                child = Some(c);
                break;
            }
            Err(e)
                if attempt < 5
                    && (e.kind() == std::io::ErrorKind::ExecutableFileBusy
                        || e.raw_os_error() == Some(26)) =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => return Err(ProbeError::Spawn(e.to_string())),
        }
    }
    let child = child.expect("spawn loop either returns a child or an error");

    let output = match tokio::time::timeout(deadline, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        // ffprobe ran to completion but the I/O plumbing failed.
        Ok(Err(e)) => return Err(ProbeError::Spawn(e.to_string())),
        // Deadline hit: the `child` handle was moved into wait_with_output, so
        // it is dropped here and `kill_on_drop` reaps the still-running ffprobe.
        Err(_) => return Err(ProbeError::Timeout(deadline.as_secs())),
    };

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

    // The main video stream: the first codec_type=="video" that is NOT
    // embedded cover art. MKVs frequently carry an mjpeg/png poster (an
    // attached_pic stream) ahead of the real movie stream; selecting it would
    // record video_codec='mjpeg' and force a pointless transcode of a file
    // whose actual video direct-plays.
    let video = streams
        .iter()
        .find(|s| stream_type(s) == Some("video") && !is_attached_pic(s));

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

    // Container-level tags (`format.tags`), keys lowercased. The video path
    // ignores this; the music scanner reads artist/album/title/track/date here.
    let format_tags = format
        .and_then(|f| f.get("tags"))
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.to_ascii_lowercase(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // Container chapters (audiobooks). ffprobe reports fractional-second
    // strings; whole seconds are plenty for chapter navigation.
    let chapters = doc
        .get("chapters")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|ch| {
                    let start_secs = ch.get("start_time").and_then(parse_f64)?.round() as i64;
                    let end_secs = ch
                        .get("end_time")
                        .and_then(parse_f64)
                        .map(|t| t.round() as i64)
                        .unwrap_or(start_secs);
                    Some(crate::models::Chapter {
                        title: ch
                            .get("tags")
                            .and_then(|t| t.get("title"))
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        start_secs,
                        end_secs,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    FileProbe {
        container,
        duration_secs,
        video_codec,
        video_height,
        video_profile,
        hdr_format,
        audio_tracks,
        subtitle_tracks,
        format_tags,
        chapters,
    }
}

/// `codec_type` of a stream, if present.
fn stream_type(stream: &Value) -> Option<&str> {
    stream.get("codec_type").and_then(Value::as_str)
}

/// `disposition.attached_pic == 1` → the stream is embedded cover art (an
/// album/poster image muxed as a video stream), not playable video.
fn is_attached_pic(stream: &Value) -> bool {
    stream
        .get("disposition")
        .and_then(|d| d.get("attached_pic"))
        .and_then(parse_i64)
        .map(|v| v == 1)
        .unwrap_or(false)
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
    // A "DOVI configuration record" entry (the stream-level DV box) carries
    // `dv_profile`; append it ("Dolby Vision P5") so the transcoder can gate
    // profile-dependent handling (P5/P8 may pass through to a DV-capable
    // client, P7 dual-layer never can). Frame-level "Dolby Vision Metadata"
    // entries carry no profile → the bare label, which downstream treats as
    // unknown-profile (fails closed to the RPU re-encode).
    if let Some(list) = video.get("side_data_list").and_then(Value::as_array) {
        for sd in list {
            let sd_type = sd
                .get("side_data_type")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !(sd_type.contains("Dolby Vision") || sd_type.contains("DOVI")) {
                continue;
            }
            if let Some(profile) = sd.get("dv_profile").and_then(parse_i64) {
                return Some(format!("Dolby Vision P{profile}"));
            }
            return Some("Dolby Vision".to_string());
        }
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

    /// A stub "ffprobe" that ignores its args and sleeps far past the deadline,
    /// modeling a hung probe on a corrupt file or stalled mount.
    #[cfg(unix)]
    fn write_sleeping_stub(dir: &std::path::Path) -> std::path::PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("ffprobe_sleep_stub.sh");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"#!/bin/sh\nsleep 30\n").unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
        p
    }

    /// A stub "ffprobe" that ignores its args and prints a fixed, valid
    /// ffprobe-style JSON document on stdout, exiting 0 — a deterministic
    /// stand-in for a successful probe so timing/throughput can be measured
    /// without the real binary. Returns the path to the executable stub.
    #[cfg(unix)]
    pub(crate) fn write_echoing_stub(dir: &std::path::Path) -> std::path::PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        // Minimal but realistic: one h264 1080p video stream + one aac audio
        // stream + a format block, matching what parse_ffprobe_json reads.
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","height":1080},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{"format_name":"mov,mp4,m4a","duration":"1.0"}}"#;
        let p = dir.join("ffprobe_echo_stub.sh");
        let mut f = std::fs::File::create(&p).unwrap();
        // Single-quote the heredoc delimiter so the shell does not interpolate.
        writeln!(f, "#!/bin/sh\ncat <<'EOF'\n{json}\nEOF").unwrap();
        // Sync + close the fd BEFORE chmod/exec. Exec'ing a file still held
        // open for writing intermittently fails with ETXTBSY ("text file
        // busy") on a loaded runner — the source of this test's flake.
        f.sync_all().unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
        p
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn echoing_stub_round_trips_through_spawn_and_parse() {
        let dir = tempfile::tempdir().unwrap();
        let stub = write_echoing_stub(dir.path());
        // Any path; the stub ignores its args.
        let probe = ffprobe_with_bin(stub.to_str().unwrap(), dir.path())
            .await
            .expect("echoing stub must spawn, exit 0, and parse");
        assert_eq!(probe.video_codec.as_deref(), Some("h264"));
        assert_eq!(probe.video_height, Some(1080));
        assert_eq!(probe.audio_tracks.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ffprobe_times_out_and_frees_the_slot() {
        // A hung probe must return ProbeError::Timeout quickly (well under the
        // stub's 30s sleep), proving the deadline fires and the await returns so
        // the scan slot is freed instead of wedging forever.
        let dir = tempfile::tempdir().unwrap();
        let stub = write_sleeping_stub(dir.path());
        let started = std::time::Instant::now();
        let result = ffprobe_with_bin_timeout(
            stub.to_str().unwrap(),
            std::path::Path::new("/whatever.mkv"),
            Duration::from_millis(150),
        )
        .await;
        assert!(
            matches!(result, Err(ProbeError::Timeout(_))),
            "expected Timeout, got {result:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout must return promptly, not after the stub's full sleep"
        );
    }

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
    fn dovi_config_record_profile_is_captured() {
        // A stream-level DOVI configuration record spells out dv_profile;
        // the label carries it so the transcoder can gate P5/P8 passthrough
        // vs P7 (dual-layer, never passable). ffprobe emits dv_profile as a
        // number; a string is tolerated (parse_i64 handles both).
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "color_transfer": "smpte2084",
                    "side_data_list": [
                        { "side_data_type": "DOVI configuration record", "dv_profile": 5 }
                    ]
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.hdr_format.as_deref(), Some("Dolby Vision P5"));
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

    // AV1 4K SDR remux — a modern codec not previously in the matrix.
    #[test]
    fn av1_video_codec_passthrough() {
        let doc = json!({
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "av1", "height": 2160 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_codec.as_deref(), Some("av1"));
        assert_eq!(probe.video_height, Some(2160));
        assert_eq!(probe.hdr_format, None);
    }

    // MKV with an embedded poster (mjpeg attached_pic) ahead of the real HEVC
    // video: the cover art must be skipped and the actual movie stream
    // selected. Previously the first codec_type=="video" won, recording
    // video_codec='mjpeg' and forcing a needless transcode.
    #[test]
    fn attached_pic_coverart_is_skipped_for_main_video() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "mjpeg",
                    "height": 600,
                    "disposition": { "attached_pic": 1 }
                },
                {
                    "index": 1,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "height": 2160,
                    "color_transfer": "smpte2084"
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_codec.as_deref(), Some("hevc"));
        assert_eq!(probe.video_height, Some(2160));
        assert_eq!(probe.hdr_format.as_deref(), Some("HDR10"));
    }

    // ffprobe sometimes emits attached_pic as a string-numeric ("1"); the
    // disposition check must parse it like every other numeric field.
    #[test]
    fn attached_pic_string_numeric_disposition_is_skipped() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "png",
                    "height": 1000,
                    "disposition": { "attached_pic": "1" }
                },
                { "index": 1, "codec_type": "video", "codec_name": "h264", "height": 1080 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_codec.as_deref(), Some("h264"));
        assert_eq!(probe.video_height, Some(1080));
    }

    // A file whose ONLY video stream is cover art (e.g. an audio container
    // with embedded artwork) has no playable video: all video fields None.
    #[test]
    fn only_attached_pic_yields_no_video_fields() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "mjpeg",
                    "height": 600,
                    "disposition": { "attached_pic": 1 }
                },
                { "index": 1, "codec_type": "audio", "codec_name": "flac", "channels": 2 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_codec, None);
        assert_eq!(probe.video_height, None);
        assert_eq!(probe.hdr_format, None);
        assert_eq!(probe.audio_tracks.len(), 1);
    }

    // Dolby Vision profile 5/8 where DV side-data is present but the stream carries
    // no color_transfer — DV must still win. NOTE: detect_hdr matches the substring
    // "Dolby Vision" in side_data_type, so the side-data must spell it out (ffprobe
    // emits e.g. "Dolby Vision Metadata"); the abbreviated "DOVI configuration
    // record" alone is NOT recognized by the current mapper.
    #[test]
    fn dolby_vision_without_color_transfer() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "side_data_list": [
                        { "side_data_type": "Dolby Vision Metadata" }
                    ]
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.hdr_format.as_deref(), Some("Dolby Vision"));
    }

    // BT.2020 10-bit SDR — wide gamut but not an HDR EOTF the mapper recognizes.
    #[test]
    fn unknown_color_transfer_is_not_hdr() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "color_transfer": "bt2020-10"
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.hdr_format, None);
    }

    // ffprobe frequently emits numeric fields as JSON strings.
    #[test]
    fn string_numeric_height_and_channels_parsed() {
        let doc = json!({
            "format": { "duration": "3600" },
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264", "height": "1080" },
                { "index": 1, "codec_type": "audio", "codec_name": "dts", "channels": "6" }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_height, Some(1080));
        assert_eq!(probe.audio_tracks[0].channels, Some(6));
        assert_eq!(probe.duration_secs, Some(3600));
    }

    // ffprobe emits "N/A" for unknowable fields — must yield None, never panic.
    #[test]
    fn non_numeric_strings_yield_none() {
        let doc = json!({
            "format": { "duration": "N/A" },
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264", "height": "N/A" }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_height, None);
        assert_eq!(probe.duration_secs, None);
    }

    // Many remuxes ship untagged audio (no language/title metadata at all).
    #[test]
    fn missing_audio_tags_leave_language_and_title_none() {
        let doc = json!({
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264", "height": 1080 },
                { "index": 1, "codec_type": "audio", "codec_name": "flac", "channels": 2 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.audio_tracks.len(), 1);
        assert_eq!(probe.audio_tracks[0].codec.as_deref(), Some("flac"));
        assert_eq!(probe.audio_tracks[0].language, None);
        assert_eq!(probe.audio_tracks[0].title, None);
    }

    // A stream with no `index` field falls back to 0 via .unwrap_or(0).
    #[test]
    fn audio_index_defaults_to_zero_when_missing() {
        let doc = json!({
            "streams": [
                { "codec_type": "audio", "codec_name": "aac", "channels": 2 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.audio_tracks[0].index, 0);
    }

    // Only disposition.forced == 1 is forced; explicit 0 and absent both mean false.
    #[test]
    fn subtitle_forced_false_when_disposition_absent_or_zero() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "subtitle",
                    "codec_name": "subrip",
                    "disposition": { "forced": 0 }
                },
                {
                    "index": 1,
                    "codec_type": "subtitle",
                    "codec_name": "subrip"
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.subtitle_tracks.len(), 2);
        assert!(!probe.subtitle_tracks[0].forced);
        assert!(!probe.subtitle_tracks[1].forced);
    }

    // Genuine multi-video container (e.g. concatenated angles) — first video wins.
    #[test]
    fn multiple_video_streams_first_wins_and_extra_ignored() {
        let doc = json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "height": 1080,
                    "color_transfer": "bt709"
                },
                {
                    "index": 1,
                    "codec_type": "video",
                    "codec_name": "hevc",
                    "height": 2160,
                    "color_transfer": "smpte2084"
                },
                {
                    "index": 2,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "channels": 2
                }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.video_codec.as_deref(), Some("h264"));
        assert_eq!(probe.video_height, Some(1080));
        assert_eq!(probe.hdr_format, None);
    }

    // A bare format_name with no comma must still parse as the container.
    #[test]
    fn format_name_single_token_no_comma() {
        let doc = json!({
            "format": { "format_name": "flac" },
            "streams": [
                { "index": 0, "codec_type": "audio", "codec_name": "flac", "channels": 2 }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.container.as_deref(), Some("flac"));
    }

    // A music file's container-level tags (format.tags) are captured with
    // lowercased keys; per-stream tags stay out of this map. Drives the music
    // scanner's artist/album/title classification.
    #[test]
    fn format_tags_are_captured_lowercased() {
        let doc = json!({
            "format": {
                "format_name": "flac",
                "duration": "215.0",
                "tags": {
                    "ARTIST": "Miles Davis",
                    "album_artist": "Miles Davis",
                    "ALBUM": "Kind of Blue",
                    "title": "So What",
                    "track": "1/5",
                    "date": "1959"
                }
            },
            "streams": [
                { "index": 0, "codec_type": "audio", "codec_name": "flac", "channels": 2,
                  "tags": { "language": "eng" } }
            ]
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(
            probe.format_tags.get("artist").map(String::as_str),
            Some("Miles Davis")
        );
        assert_eq!(
            probe.format_tags.get("album_artist").map(String::as_str),
            Some("Miles Davis")
        );
        assert_eq!(
            probe.format_tags.get("album").map(String::as_str),
            Some("Kind of Blue")
        );
        assert_eq!(
            probe.format_tags.get("title").map(String::as_str),
            Some("So What")
        );
        assert_eq!(
            probe.format_tags.get("track").map(String::as_str),
            Some("1/5")
        );
        assert_eq!(
            probe.format_tags.get("date").map(String::as_str),
            Some("1959")
        );
        // Per-stream tags (language) are NOT hoisted into the format map.
        assert!(!probe.format_tags.contains_key("language"));
        assert_eq!(probe.duration_secs, Some(215));
    }

    // A whitespace-only format_name trims to empty and is dropped.
    #[test]
    fn whitespace_only_format_name_is_dropped() {
        let doc = json!({
            "format": { "format_name": "   " }
        });
        let probe = parse_ffprobe_json(&doc);
        assert_eq!(probe.container, None);
    }
}
