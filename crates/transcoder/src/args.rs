//! ffmpeg argument assembly (§4.2 HLS invocation, §4.4 encoder selection).
//!
//! Pure string assembly from a [`TranscodePlan`] → a `Vec<String>` ready for
//! `tokio::process::Command::args`. The HLS flags mirror the shipped
//! `iptvRemux.ts` invocation (`-f hls -hls_time 4 -hls_list_size 8 -hls_flags
//! delete_segments+append_list+omit_endlist`) so live and transcode sessions
//! produce byte-identical playlist semantics. Snapshot-tested per plan.

use crate::plan::{AudioOp, SubtitleOp, TranscodePlan, VideoOp};

/// Hardware encoder family, selected from `TRANSCODER_HW_ENCODER`, with
/// `TRANSCODER_FORCE_CPU=1` pinning `Cpu` regardless of that value (§4.4).
/// `Cpu` is the always-available libx264 fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HwEncoder {
    VideoToolbox,
    Nvenc,
    Vaapi,
    Qsv,
    Cpu,
}

impl HwEncoder {
    /// Parse the `TRANSCODER_HW_ENCODER` value; unknown / empty → `Cpu`.
    pub fn parse(s: &str) -> HwEncoder {
        match s.trim().to_ascii_lowercase().as_str() {
            "videotoolbox" | "vt" => HwEncoder::VideoToolbox,
            "nvenc" => HwEncoder::Nvenc,
            "vaapi" => HwEncoder::Vaapi,
            "qsv" => HwEncoder::Qsv,
            _ => HwEncoder::Cpu,
        }
    }

    /// True when `TRANSCODER_FORCE_CPU` is set to a truthy value (`1`, `true`,
    /// `yes`, `on`, case-insensitive). Unset / empty / `0` / `false` / `no` /
    /// `off` are all NOT forced. This is the operator escape hatch from §4.4:
    /// pin the service to libx264 regardless of `TRANSCODER_HW_ENCODER` (e.g.
    /// to sidestep a flaky GPU driver without changing the encoder family).
    fn force_cpu_from_env() -> bool {
        match std::env::var("TRANSCODER_FORCE_CPU") {
            Ok(v) => matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            ),
            Err(_) => false,
        }
    }

    /// Read the selection from the environment. `TRANSCODER_FORCE_CPU=1` (or any
    /// truthy spelling) forces `Cpu` regardless of `TRANSCODER_HW_ENCODER`;
    /// otherwise the family is parsed from `TRANSCODER_HW_ENCODER`.
    pub fn from_env() -> HwEncoder {
        if Self::force_cpu_from_env() {
            return HwEncoder::Cpu;
        }
        HwEncoder::parse(&std::env::var("TRANSCODER_HW_ENCODER").unwrap_or_default())
    }

    /// The ffmpeg `-c:v` encoder name for H.264 on this family.
    pub fn h264_encoder(self) -> &'static str {
        match self {
            HwEncoder::VideoToolbox => "h264_videotoolbox",
            HwEncoder::Nvenc => "h264_nvenc",
            HwEncoder::Vaapi => "h264_vaapi",
            HwEncoder::Qsv => "h264_qsv",
            HwEncoder::Cpu => "libx264",
        }
    }

    /// True when this family runs on the CPU (counts against the stricter CPU
    /// concurrency cap, §4.4/§4.5 phase 6).
    pub fn is_cpu(self) -> bool {
        matches!(self, HwEncoder::Cpu)
    }
}

/// Bitrate target (kbps) for an H.264 re-encode at a given height. Conservative
/// VBR ladder; `maxrate`/`bufsize` are derived from this.
fn h264_bitrate_kbps(height: Option<i64>) -> u32 {
    match height.unwrap_or(1080) {
        h if h <= 480 => 1_500,
        h if h <= 720 => 3_000,
        h if h <= 1080 => 6_000,
        _ => 12_000,
    }
}

/// Build the full ffmpeg argument vector for a transcode plan.
///
/// * `input` — absolute source path.
/// * `session_dir` — per-session tmpdir; the playlist and segments land here.
/// * `start_secs` — seek offset for resume/seek (`-ss`); 0 for a fresh start.
/// * `encoder` — selected HW family.
///
/// Returns an empty vec for a [`TranscodePlan::DirectPlay`] (caller should
/// never invoke ffmpeg in that case — this is a defensive no-op).
pub fn ffmpeg_args(
    plan: &TranscodePlan,
    input: &str,
    session_dir: &str,
    start_secs: u64,
    encoder: HwEncoder,
) -> Vec<String> {
    let (video, audio, subtitle) = match plan {
        TranscodePlan::DirectPlay { .. } => return Vec::new(),
        TranscodePlan::Transcode {
            video,
            audio,
            subtitle,
            ..
        } => (video, audio, subtitle),
    };

    let mut a: Vec<String> = Vec::new();
    let push = |a: &mut Vec<String>, s: &str| a.push(s.to_string());

    push(&mut a, "-hide_banner");
    push(&mut a, "-loglevel");
    push(&mut a, "warning");
    push(&mut a, "-nostdin");

    // Seek BEFORE input for fast keyframe seek (§4.2). Omit at 0.
    if start_secs > 0 {
        push(&mut a, "-ss");
        a.push(start_secs.to_string());
    }

    push(&mut a, "-fflags");
    push(&mut a, "+genpts");
    push(&mut a, "-i");
    a.push(input.to_string());

    // ── Stream mapping ─────────────────────────────────────────────────────
    push(&mut a, "-map");
    push(&mut a, "0:v:0");
    push(&mut a, "-map");
    push(&mut a, "0:a:0?");

    // ── Video ────────────────────────────────────────────────────────────
    match video {
        VideoOp::Copy => {
            push(&mut a, "-c:v");
            push(&mut a, "copy");
        }
        VideoOp::EncodeH264 {
            scale_to_height,
            tone_map,
            burn_subtitle_index,
        } => {
            push(&mut a, "-c:v");
            push(&mut a, encoder.h264_encoder());
            push(&mut a, "-preset");
            // VideoToolbox ignores libx264 presets; use a neutral value the
            // CPU encoder understands and HW encoders tolerate.
            push(&mut a, if encoder.is_cpu() { "veryfast" } else { "fast" });

            let br = h264_bitrate_kbps(*scale_to_height);
            push(&mut a, "-b:v");
            a.push(format!("{br}k"));
            push(&mut a, "-maxrate");
            a.push(format!("{}k", br + br / 2));
            push(&mut a, "-bufsize");
            a.push(format!("{}k", br * 2));

            // Filtergraph: scale, tone-map, burn-in. Composed into one -vf.
            let vf = build_video_filter(*scale_to_height, *tone_map, *burn_subtitle_index, input);
            if let Some(filter) = vf {
                push(&mut a, "-vf");
                a.push(filter);
            }
        }
    }

    // ── Audio ────────────────────────────────────────────────────────────
    match audio {
        AudioOp::Copy => {
            push(&mut a, "-c:a");
            push(&mut a, "copy");
        }
        AudioOp::EncodeAac { bitrate_kbps } => {
            push(&mut a, "-c:a");
            push(&mut a, "aac");
            push(&mut a, "-b:a");
            a.push(format!("{bitrate_kbps}k"));
        }
    }

    // ── Subtitles ──────────────────────────────────────────────────────────
    // Burn-in is handled inside the video filtergraph (no separate map). Text
    // extraction adds a WebVTT subtitle stream to the output.
    if let SubtitleOp::ExtractWebVtt { source_index } = subtitle {
        push(&mut a, "-map");
        a.push(format!("0:{source_index}"));
        push(&mut a, "-c:s");
        push(&mut a, "webvtt");
    }

    // ── HLS muxer (§4.2; mirrors iptvRemux.ts) ──────────────────────────────
    push(&mut a, "-f");
    push(&mut a, "hls");
    push(&mut a, "-hls_time");
    push(&mut a, "4");
    push(&mut a, "-hls_list_size");
    push(&mut a, "8");
    push(&mut a, "-hls_flags");
    push(&mut a, "delete_segments+append_list+omit_endlist");
    push(&mut a, "-hls_segment_filename");
    a.push(format!("{session_dir}/seg_%05d.ts"));
    a.push(format!("{session_dir}/index.m3u8"));

    a
}

/// Compose the `-vf` filtergraph from scale / tone-map / burn-in. Returns
/// `None` when no filter is needed (e.g. an encode driven solely by an audio
/// or container change).
fn build_video_filter(
    scale_to_height: Option<i64>,
    tone_map: bool,
    burn_subtitle_index: Option<i64>,
    input: &str,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if tone_map {
        // HDR → SDR BT.709 tone-map (§8). zscale+tonemap is the standard chain.
        parts.push(
            "zscale=t=linear:npl=100,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
                .to_string(),
        );
    }
    if let Some(h) = scale_to_height {
        parts.push(format!("scale=-2:{h}"));
    }
    if let Some(si) = burn_subtitle_index {
        // Burn the image subtitle by absolute stream index. The input path is
        // re-referenced so the filter can read the subtitle stream.
        parts.push(format!(
            "subtitles='{}':si={}",
            escape_filter_path(input),
            si
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// Escape a path for use inside an ffmpeg filtergraph argument (single quotes,
/// colons, backslashes are special to the filter parser).
fn escape_filter_path(p: &str) -> String {
    p.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace(':', "\\:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{AudioOp, SubtitleOp, TranscodePlan, VideoOp};
    use std::sync::Mutex;

    /// Serializes all tests that mutate process-global env vars. `from_env`
    /// reads both `TRANSCODER_FORCE_CPU` and `TRANSCODER_HW_ENCODER`, so any
    /// concurrent test touching either var would flake without this lock.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Clears both env vars `from_env` reads. Edition 2024 makes these `unsafe`.
    fn clear_encoder_env() {
        unsafe {
            std::env::remove_var("TRANSCODER_FORCE_CPU");
            std::env::remove_var("TRANSCODER_HW_ENCODER");
        }
    }

    #[test]
    fn force_cpu_overrides_hw_encoder() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var("TRANSCODER_HW_ENCODER", "nvenc");
            std::env::set_var("TRANSCODER_FORCE_CPU", "1");
        }
        assert_eq!(HwEncoder::from_env(), HwEncoder::Cpu);
        clear_encoder_env();
    }

    #[test]
    fn force_cpu_truthy_values() {
        let _guard = ENV_LOCK.lock().unwrap();
        for v in ["1", "true", "TRUE", "yes", "on", " On "] {
            unsafe {
                std::env::set_var("TRANSCODER_HW_ENCODER", "videotoolbox");
                std::env::set_var("TRANSCODER_FORCE_CPU", v);
            }
            assert_eq!(
                HwEncoder::from_env(),
                HwEncoder::Cpu,
                "truthy value {v:?} must force Cpu"
            );
        }
        clear_encoder_env();
    }

    #[test]
    fn force_cpu_falsey_values_do_not_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        for v in ["0", "false", "no", "off", ""] {
            unsafe {
                std::env::set_var("TRANSCODER_HW_ENCODER", "nvenc");
                std::env::set_var("TRANSCODER_FORCE_CPU", v);
            }
            assert_eq!(
                HwEncoder::from_env(),
                HwEncoder::Nvenc,
                "falsey value {v:?} must NOT force Cpu"
            );
        }
        // Var removed entirely → HW selection still honored.
        unsafe {
            std::env::set_var("TRANSCODER_HW_ENCODER", "nvenc");
            std::env::remove_var("TRANSCODER_FORCE_CPU");
        }
        assert_eq!(HwEncoder::from_env(), HwEncoder::Nvenc);
        clear_encoder_env();
    }

    #[test]
    fn force_cpu_unset_preserves_hw_selection() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var("TRANSCODER_FORCE_CPU");
            std::env::set_var("TRANSCODER_HW_ENCODER", "videotoolbox");
        }
        assert_eq!(HwEncoder::from_env(), HwEncoder::VideoToolbox);
        clear_encoder_env();
    }

    fn transcode(video: VideoOp, audio: AudioOp, subtitle: SubtitleOp) -> TranscodePlan {
        TranscodePlan::Transcode {
            video,
            audio,
            subtitle,
            reason: "test".into(),
        }
    }

    #[test]
    fn hw_encoder_parse_matrix() {
        assert_eq!(HwEncoder::parse("videotoolbox"), HwEncoder::VideoToolbox);
        assert_eq!(HwEncoder::parse(" NVENC "), HwEncoder::Nvenc);
        assert_eq!(HwEncoder::parse("vaapi"), HwEncoder::Vaapi);
        assert_eq!(HwEncoder::parse("qsv"), HwEncoder::Qsv);
        assert_eq!(HwEncoder::parse("cpu"), HwEncoder::Cpu);
        assert_eq!(HwEncoder::parse(""), HwEncoder::Cpu);
        assert_eq!(HwEncoder::parse("garbage"), HwEncoder::Cpu);
    }

    #[test]
    fn encoder_names_per_family() {
        assert_eq!(HwEncoder::VideoToolbox.h264_encoder(), "h264_videotoolbox");
        assert_eq!(HwEncoder::Nvenc.h264_encoder(), "h264_nvenc");
        assert_eq!(HwEncoder::Vaapi.h264_encoder(), "h264_vaapi");
        assert_eq!(HwEncoder::Qsv.h264_encoder(), "h264_qsv");
        assert_eq!(HwEncoder::Cpu.h264_encoder(), "libx264");
        assert!(HwEncoder::Cpu.is_cpu());
        assert!(!HwEncoder::VideoToolbox.is_cpu());
    }

    #[test]
    fn direct_play_produces_no_args() {
        let plan = TranscodePlan::DirectPlay {
            reason: "direct play".into(),
        };
        assert!(ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).is_empty());
    }

    #[test]
    fn remux_copy_copy_hls_snapshot() {
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/lib/m.mkv", "/tmp/sess", 0, HwEncoder::Cpu);
        let joined = args.join(" ");
        assert_eq!(
            joined,
            "-hide_banner -loglevel warning -nostdin -fflags +genpts -i /lib/m.mkv \
             -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy \
             -f hls -hls_time 4 -hls_list_size 8 -hls_flags delete_segments+append_list+omit_endlist \
             -hls_segment_filename /tmp/sess/seg_%05d.ts /tmp/sess/index.m3u8"
        );
    }

    #[test]
    fn seek_inserts_ss_before_input() {
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 90, HwEncoder::Cpu);
        // -ss 90 must appear before -i.
        let ss = args.iter().position(|s| s == "-ss").expect("missing -ss");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(ss < i, "-ss must precede -i");
        assert_eq!(args[ss + 1], "90");
    }

    #[test]
    fn h264_videotoolbox_reencode_uses_vt_encoder_and_bitrate_ladder() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::EncodeAac { bitrate_kbps: 192 },
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::VideoToolbox);
        let j = args.join(" ");
        assert!(j.contains("-c:v h264_videotoolbox"), "{j}");
        assert!(j.contains("-b:v 6000k"), "1080p default ladder: {j}");
        assert!(j.contains("-maxrate 9000k"), "{j}");
        assert!(j.contains("-bufsize 12000k"), "{j}");
        assert!(j.contains("-c:a aac -b:a 192k"), "{j}");
        // No -vf when nothing in the filtergraph.
        assert!(!j.contains("-vf"), "{j}");
    }

    #[test]
    fn cpu_fallback_uses_libx264_and_veryfast() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-c:v libx264"), "{j}");
        assert!(j.contains("-preset veryfast"), "{j}");
    }

    #[test]
    fn scale_filter_present_when_downscaling() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(1080),
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-vf scale=-2:1080"), "{j}");
        // 1080p ladder applies to the scaled target.
        assert!(j.contains("-b:v 6000k"), "{j}");
    }

    #[test]
    fn tone_map_filter_present_when_collapsing_hdr() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: true,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("tonemap=hable"), "{j}");
        assert!(j.contains("format=yuv420p"), "{j}");
    }

    #[test]
    fn tone_map_and_scale_compose_in_order() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(1080),
                tone_map: true,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu);
        let vf_idx = args.iter().position(|s| s == "-vf").unwrap();
        let filter = &args[vf_idx + 1];
        // tone-map precedes scale in the chain.
        let t = filter.find("tonemap").unwrap();
        let s = filter.find("scale=-2:1080").unwrap();
        assert!(t < s, "tone-map must precede scale: {filter}");
    }

    #[test]
    fn burn_in_adds_subtitles_filter_with_escaped_path() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: Some(2),
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/lib/show s01e01.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("subtitles="), "{j}");
        assert!(j.contains(":si=2"), "{j}");
    }

    #[test]
    fn webvtt_extract_maps_subtitle_stream() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::ExtractWebVtt { source_index: 3 },
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu);
        let j = args.join(" ");
        assert!(j.contains("-map 0:3"), "{j}");
        assert!(j.contains("-c:s webvtt"), "{j}");
    }

    #[test]
    fn hls_flags_always_present() {
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(
            j.contains("-hls_flags delete_segments+append_list+omit_endlist"),
            "{j}"
        );
        assert!(
            j.ends_with("/tmp/s/index.m3u8"),
            "playlist is last arg: {j}"
        );
    }
}
