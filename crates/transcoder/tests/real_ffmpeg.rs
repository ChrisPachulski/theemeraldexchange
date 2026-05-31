//! Real-ffmpeg integration coverage (§4 transcoder).
//!
//! GATED behind the `requires-ffmpeg` cargo feature (off by default) so the
//! ordinary `cargo test -p transcoder` stays hermetic and needs no ffmpeg on
//! the box. The full unit suite exercises the session state machine against a
//! shell stub (see `session.rs` `mod tests`); it deliberately never decodes a
//! byte — that is the honest scaffold boundary the module doc calls out. The
//! gap that leaves: nothing proved the argv we hand ffmpeg actually produces
//! *playable* HLS.
//!
//! This suite closes that gap with the smallest honest end-to-end check:
//!   1. generate a ~1s fixture via `ffmpeg -f lavfi -i testsrc`,
//!   2. assemble the production argv with the crate's real
//!      [`transcoder::args::ffmpeg_args`],
//!   3. run REAL ffmpeg with it,
//!   4. assert `index.m3u8` is valid HLS and a `seg_*.ts` is ffprobe-demuxable
//!      (reports a real video stream) — i.e. decoded media, not the 3 stub
//!      bytes (`b"seg"`) the unit harness writes.
//!
//! CI runs this inside the `mwader/static-ffmpeg` image already pinned in the
//! Dockerfile:  `cargo test -p transcoder --features requires-ffmpeg`.
//!
//! If the feature is enabled on a host with no ffmpeg/ffprobe on PATH the test
//! SKIPs (prints why) rather than failing — a missing toolchain is an
//! environment gap, not a regression in our code.

#![cfg(feature = "requires-ffmpeg")]

use std::path::Path;
use std::process::Command;

use transcoder::args::{HwEncoder, ffmpeg_args};
use transcoder::plan::{AudioOp, SubtitleOp, TranscodePlan, VideoOp};

/// Resolve an ffmpeg-family binary: honor the same `TRANSCODER_FFMPEG_BIN`
/// override the service uses for `ffmpeg`; fall back to the bare name on PATH.
fn ffmpeg_bin() -> String {
    std::env::var("TRANSCODER_FFMPEG_BIN").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// `ffprobe` is taken from `TRANSCODER_FFPROBE_BIN`, else next to a resolved
/// absolute ffmpeg, else the bare name on PATH.
fn ffprobe_bin() -> String {
    if let Ok(explicit) = std::env::var("TRANSCODER_FFPROBE_BIN") {
        return explicit;
    }
    let ff = ffmpeg_bin();
    if let Some(parent) = Path::new(&ff).parent() {
        if !parent.as_os_str().is_empty() {
            let candidate = parent.join("ffprobe");
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "ffprobe".to_string()
}

/// True if `bin -version` runs — used to SKIP cleanly when the toolchain is
/// absent rather than reporting a false failure.
fn runnable(bin: &str) -> bool {
    Command::new(bin)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Generate a tiny self-contained fixture so the suite needs no committed
/// binary media. `testsrc` is a built-in lavfi source; 1s @ 24fps is enough to
/// force at least one HLS segment.
fn make_fixture(dir: &Path) -> std::path::PathBuf {
    let ffmpeg = ffmpeg_bin();
    let fixture = dir.join("fixture.mp4");
    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=24:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&fixture)
        .status()
        .expect("spawn ffmpeg to build fixture");
    assert!(
        status.success(),
        "ffmpeg failed to build the testsrc fixture"
    );
    assert!(fixture.exists(), "fixture was not written");
    fixture
}

#[test]
fn production_argv_produces_playable_hls() {
    let ffmpeg = ffmpeg_bin();
    let ffprobe = ffprobe_bin();
    if !runnable(&ffmpeg) || !runnable(&ffprobe) {
        eprintln!(
            "SKIP production_argv_produces_playable_hls: ffmpeg/ffprobe not runnable \
             (ffmpeg={ffmpeg:?}, ffprobe={ffprobe:?}). Enable the toolchain to run the \
             real-ffmpeg gate (CI uses the static-ffmpeg image)."
        );
        return;
    }

    let tmp = tempfile::tempdir().expect("tmpdir");
    let fixture = make_fixture(tmp.path());

    let session_dir = tmp.path().join("session");
    std::fs::create_dir_all(&session_dir).expect("create session dir");

    // The crate's REAL argv assembly — the exact function the unit tests only
    // string-asserted and never executed. A remux plan (`Copy`/`Copy`) repacks
    // the elementary streams into HLS: a real ffmpeg run over real input that
    // still proves the muxer flags, segment filename, and playlist path are
    // all correct against a live binary. (DirectPlay would return an empty
    // argv by design, so we use the smallest non-direct-play plan.)
    let plan = TranscodePlan::Transcode {
        video: VideoOp::Copy,
        audio: AudioOp::Copy,
        subtitle: SubtitleOp::None,
        reason: "real-ffmpeg integration: remux to HLS".into(),
    };
    let argv = ffmpeg_args(
        &plan,
        &fixture.to_string_lossy(),
        &session_dir.to_string_lossy(),
        0,
        HwEncoder::Cpu,
    );
    assert!(
        !argv.is_empty(),
        "a Transcode plan must yield a non-empty ffmpeg argv"
    );

    let out = Command::new(&ffmpeg)
        .args(&argv)
        .output()
        .expect("spawn real ffmpeg with production argv");
    assert!(
        out.status.success(),
        "real ffmpeg rejected our production argv:\nargv={argv:?}\nstderr={}",
        String::from_utf8_lossy(&out.stderr)
    );

    // 1) index.m3u8 is valid HLS with at least one segment reference.
    let playlist = session_dir.join("index.m3u8");
    let m3u8 = std::fs::read_to_string(&playlist).expect("read index.m3u8");
    assert!(
        m3u8.starts_with("#EXTM3U"),
        "playlist is not a valid HLS manifest:\n{m3u8}"
    );
    assert!(
        m3u8.contains("#EXTINF") && m3u8.contains(".ts"),
        "playlist lists no media segments:\n{m3u8}"
    );

    // 2) at least one seg_*.ts segment exists and is more than the 3 stub bytes.
    let seg = std::fs::read_dir(&session_dir)
        .expect("read session dir")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("seg_") && n.ends_with(".ts"))
                .unwrap_or(false)
        })
        .expect("no seg_*.ts segment was written");
    let seg_len = std::fs::metadata(&seg).expect("stat segment").len();
    assert!(
        seg_len > 3,
        "segment is suspiciously tiny ({seg_len} bytes) — not real media"
    );

    // 3) ffprobe can demux the segment and reports a real video stream — i.e.
    //    decoded media, not the literal `b"seg"` a stub would write.
    let probe = Command::new(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&seg)
        .output()
        .expect("spawn ffprobe on segment");
    assert!(
        probe.status.success(),
        "ffprobe could not demux the segment:\nstderr={}",
        String::from_utf8_lossy(&probe.stderr)
    );
    let codec_type = String::from_utf8_lossy(&probe.stdout);
    // An HLS segment is MPEG-TS, which carries a PROGRAM. ffprobe therefore
    // enumerates each selected stream twice — once under `[PROGRAM]` and once
    // under the top-level `[STREAM]` list — so `-select_streams v:0` legitimately
    // prints "video" on more than one line (verified on static-ffmpeg 7.1 and
    // ffmpeg 8.1 alike). The honest assertion is that ffprobe resolved at least
    // one video stream and EVERY codec_type it reported for v:0 is "video" — not
    // that the raw stdout equals the single string "video".
    let codec_lines: Vec<&str> = codec_type
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    assert!(
        !codec_lines.is_empty() && codec_lines.iter().all(|&l| l == "video"),
        "segment has no decodable video stream (ffprobe reported {codec_type:?})"
    );
}
