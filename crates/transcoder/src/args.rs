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

/// DRM render node used for VAAPI hardware encode. Must match the device mapped
/// into the transcoder container in docker-compose.yml; change both together if
/// the host enumerates the iGPU at a different node. (QSV auto-selects the lone
/// render node via `qsv=hw`, so it needs no path here.)
pub(crate) const VAAPI_RENDER_NODE: &str = "/dev/dri/renderD128";

/// HLS target segment duration (seconds). Used both for `-hls_time` and for the
/// re-encode keyframe cadence (`-force_key_frames`), which MUST stay in lockstep:
/// the HLS muxer can only cut a segment at a keyframe, so if the encoder's GOP
/// runs longer than this the first segment can't close until the next native
/// keyframe — tens of seconds in. Under `-re` (real-time pacing) that pushes the
/// first segment past the backend's manifest-readiness probe, and the player is
/// handed a not-yet-written playlist (503) → a grey rectangle stuck at 0:00.
const HLS_SEGMENT_SECS: u32 = 4;

/// Build the ffmpeg argument vector for a transcode plan (software-decode path).
///
/// Thin wrapper over [`ffmpeg_args_hw`] with hardware decode OFF — the historical
/// 5-arg signature, kept for the call sites and tests that assert the CPU-decode
/// behavior. The session manager calls [`ffmpeg_args_hw`] directly so it can flip
/// on the full-hardware pipeline per session.
pub fn ffmpeg_args(
    plan: &TranscodePlan,
    input: &str,
    session_dir: &str,
    start_secs: u64,
    encoder: HwEncoder,
) -> Vec<String> {
    ffmpeg_args_hw(plan, input, session_dir, start_secs, encoder, false)
}

/// Build the full ffmpeg argument vector for a transcode plan.
///
/// * `input` — absolute source path.
/// * `session_dir` — per-session tmpdir; the playlist and segments land here.
/// * `start_secs` — seek offset for resume/seek (`-ss`); 0 for a fresh start.
/// * `encoder` — selected HW family.
/// * `hw_decode` — when set (and the family is VAAPI and the plan re-encodes
///   video with no subtitle burn-in), decode the source straight into VAAPI
///   surfaces (`-hwaccel vaapi -hwaccel_output_format vaapi`) and run tone-map +
///   scale on the iGPU (`tonemap_vaapi`/`scale_vaapi`), encoding with
///   `h264_vaapi` and NO CPU<->GPU `hwupload`. The whole pipeline (decode, VPP,
///   encode) then runs on the GPU. Otherwise the software-decode path runs (CPU
///   decode + CPU scale/tonemap/burn, then `format=nv12,hwupload` for a VAAPI/QSV
///   encoder). Only enable `hw_decode` for a source codec the device can decode —
///   under `-hwaccel_output_format vaapi` an undecodable codec has no software
///   fallback and hard-fails the session.
///
/// Returns an empty vec for a [`TranscodePlan::DirectPlay`] (caller should
/// never invoke ffmpeg in that case — this is a defensive no-op).
pub fn ffmpeg_args_hw(
    plan: &TranscodePlan,
    input: &str,
    session_dir: &str,
    start_secs: u64,
    encoder: HwEncoder,
    hw_decode: bool,
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

    // Full-hardware pipeline: decode the source directly into VAAPI surfaces and
    // keep every frame on the GPU through tone-map/scale/encode. Only for a VAAPI
    // re-encode with NO subtitle burn-in — image burn-in needs the libass
    // `subtitles` filter, which runs on CPU frames the GPU path doesn't have. The
    // caller gates `hw_decode` on a HW-decodable source codec, since
    // -hwaccel_output_format vaapi has no software fallback for an undecodable one.
    let full_hw = hw_decode
        && matches!(encoder, HwEncoder::Vaapi)
        && matches!(
            video,
            VideoOp::EncodeH264 {
                burn_subtitle_index: None,
                ..
            }
        );

    // VAAPI and QSV both encode from Intel hardware surfaces, so they need a
    // device initialized BEFORE -i (a global option) and the filtergraph
    // terminated with an upload to it (see the EncodeH264 branch). The init
    // differs per family: VAAPI takes an explicit DRM render node; QSV uses
    // `qsv=hw` (auto-selects the lone render node) plus `-filter_hw_device` so
    // the hwupload filter knows which device to target. Emitted only for a real
    // video re-encode — VideoToolbox/NVENC take software frames directly, and a
    // copy-remux (VideoOp::Copy — the common case for local titles that only
    // transcode because their container/audio isn't browser-safe) never touches
    // the encoder, so opening the GPU device for it would be pure waste.
    let hw_surface_reencode = matches!(encoder, HwEncoder::Vaapi | HwEncoder::Qsv)
        && matches!(video, VideoOp::EncodeH264 { .. });
    if full_hw {
        // Hardware-decode into VAAPI surfaces; the decoder, the VPP filters, and
        // h264_vaapi all share the device derived from this hw frames context, so
        // no separate -vaapi_device is needed. These are input options (they
        // apply to the -i that follows).
        push(&mut a, "-hwaccel");
        push(&mut a, "vaapi");
        push(&mut a, "-hwaccel_device");
        push(&mut a, VAAPI_RENDER_NODE);
        push(&mut a, "-hwaccel_output_format");
        push(&mut a, "vaapi");
    } else if hw_surface_reencode {
        match encoder {
            HwEncoder::Vaapi => {
                push(&mut a, "-vaapi_device");
                push(&mut a, VAAPI_RENDER_NODE);
            }
            HwEncoder::Qsv => {
                push(&mut a, "-init_hw_device");
                push(&mut a, "qsv=hw");
                push(&mut a, "-filter_hw_device");
                push(&mut a, "hw");
            }
            _ => {}
        }
    }

    // Seek BEFORE input for fast keyframe seek (§4.2). Omit at 0.
    if start_secs > 0 {
        push(&mut a, "-ss");
        a.push(start_secs.to_string());
    }

    // Throttle reading to the input's native rate so the HLS sliding window
    // (delete_segments + hls_list_size 8) tracks real playback instead of
    // racing to EOF. WITHOUT -re ffmpeg remuxes a whole movie in seconds,
    // deletes every segment behind the 8-deep window, then exits cleanly —
    // the player 404s on segments that already scrolled off (stuck grey at
    // 0:00) and the supervisor mistakes the early exit for a crash and
    // restart-loops until it tears the session down. With -re the producer
    // tracks the consumer, the 2 GB scratch tmpfs only ever holds the live
    // window, and ffmpeg runs for the title's real duration. -re is an input
    // option, so it sits with -ss just before -i.
    push(&mut a, "-re");

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

            // libx264 needs a speed preset; VideoToolbox/NVENC/QSV tolerate one
            // (a neutral value the CPU encoder understands and HW encoders
            // accept). VAAPI has NO preset concept — passing it logs "preset ...
            // has not been used for any stream" on every session — so skip it
            // there and instead pin the Low-Power H.264 entrypoint, the only one
            // Alder Lake exposes, so ffmpeg uses it deterministically rather than
            // probing for the absent full entrypoint.
            if matches!(encoder, HwEncoder::Vaapi) {
                push(&mut a, "-low_power");
                push(&mut a, "1");
            } else {
                push(&mut a, "-preset");
                push(&mut a, if encoder.is_cpu() { "veryfast" } else { "fast" });
            }

            let br = h264_bitrate_kbps(*scale_to_height);
            push(&mut a, "-b:v");
            a.push(format!("{br}k"));
            push(&mut a, "-maxrate");
            a.push(format!("{}k", br + br / 2));
            push(&mut a, "-bufsize");
            a.push(format!("{}k", br * 2));

            // Force a keyframe at every HLS segment boundary. The encoder's
            // native GOP can be far longer than a segment (h264_vaapi defaults to
            // ~tens of seconds), and the HLS muxer can only split at a keyframe —
            // so without this the FIRST segment doesn't close until the first
            // native keyframe past `hls_time`. Under -re (real-time pacing) that
            // is tens of seconds of wall-clock, blowing past the backend's
            // manifest-readiness probe; the player then loads a 503 and sits grey
            // at 0:00. The time-based expr is fps- and VFR-safe. Re-encode only:
            // a copy-remux cuts at the source's own keyframes (nothing to force).
            push(&mut a, "-force_key_frames");
            a.push(format!("expr:gte(t,n_forced*{HLS_SEGMENT_SECS})"));

            // Filtergraph. Under full-HW the frames are already VAAPI surfaces
            // decoded on the GPU, so tone-map/scale run on the iGPU
            // (tonemap_vaapi/scale_vaapi) and the graph terminates in NV12
            // directly — no upload. The software path scales/tone-maps/burns on
            // CPU frames, then converts to NV12 and uploads as the LAST link.
            let mut vf = if full_hw {
                Some(build_vaapi_hw_filter(*scale_to_height, *tone_map))
            } else {
                build_video_filter(*scale_to_height, *tone_map, *burn_subtitle_index, input)
            };

            // VAAPI/QSV software-decode path: the CPU-decoded (and CPU-scaled/
            // tone-mapped) frames must be converted to NV12 (8-bit 4:2:0 — the
            // format the iGPU encoder wants; this also collapses 10-bit p010
            // sources) and uploaded to a GPU surface. The upload is the LAST link
            // so it sits after any CPU filter; when there is no other filter it
            // stands alone as the whole graph. QSV takes an `extra_hw_frames`
            // surface pool for its look-ahead; VAAPI needs no such hint. Skipped
            // under full-HW (frames are already on the GPU). Empirically validated
            // against the deployed ffmpeg for plain 8-bit, 10-bit, scaled, and
            // 4K-HDR-tone-mapped sources (see crates/transcoder HW bring-up).
            if !full_hw {
                let upload = match encoder {
                    HwEncoder::Vaapi => Some("format=nv12,hwupload"),
                    HwEncoder::Qsv => Some("format=nv12,hwupload=extra_hw_frames=64"),
                    _ => None,
                };
                if let Some(up) = upload {
                    vf = Some(match vf {
                        Some(existing) => format!("{existing},{up}"),
                        None => up.to_string(),
                    });
                }
            }

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
    a.push(HLS_SEGMENT_SECS.to_string());
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

/// GPU-native VAAPI filtergraph for the full-hardware path: the source is decoded
/// straight into VAAPI surfaces, so tone-map and scale run on the iGPU
/// (`tonemap_vaapi`/`scale_vaapi`). The graph ALWAYS terminates in an NV12
/// surface — `h264_vaapi` (Low-Power on Alder Lake) cannot encode the 10-bit P010
/// surface a Main-10 HEVC decodes to, so a bare graph fails with "No usable
/// encoding profile found". `tonemap_vaapi` is only emitted when collapsing
/// HDR→SDR: it reads the input's HDR mastering-display metadata and errors on SDR
/// input. With neither tone-map nor scale we still run `scale_vaapi=format=nv12`
/// as a cheap GPU format pass to guarantee the NV12 the encoder needs.
fn build_vaapi_hw_filter(scale_to_height: Option<i64>, tone_map: bool) -> String {
    match (tone_map, scale_to_height) {
        // tonemap_vaapi outputs NV12; scale_vaapi after it keeps NV12.
        (true, Some(h)) => format!("tonemap_vaapi=format=nv12,scale_vaapi=w=-2:h={h}"),
        (true, None) => "tonemap_vaapi=format=nv12".to_string(),
        (false, Some(h)) => format!("scale_vaapi=w=-2:h={h}:format=nv12"),
        (false, None) => "scale_vaapi=format=nv12".to_string(),
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
            "-hide_banner -loglevel warning -nostdin -re -fflags +genpts -i /lib/m.mkv \
             -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy \
             -f hls -hls_time 4 -hls_list_size 8 -hls_flags delete_segments+append_list+omit_endlist \
             -hls_segment_filename /tmp/sess/seg_%05d.ts /tmp/sess/index.m3u8"
        );
    }

    #[test]
    fn realtime_throttle_present_and_precedes_input() {
        // -re must be emitted (so ffmpeg doesn't race a whole title to EOF and
        // blow past the sliding window) and must sit before -i as an input opt.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu);
        let re = args.iter().position(|s| s == "-re").expect("missing -re");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(re < i, "-re must precede -i");
    }

    #[test]
    fn realtime_throttle_coexists_with_seek() {
        // With a resume offset both -ss and -re precede -i.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 120, HwEncoder::Cpu);
        let ss = args.iter().position(|s| s == "-ss").expect("missing -ss");
        let re = args.iter().position(|s| s == "-re").expect("missing -re");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(ss < i && re < i, "-ss and -re must precede -i");
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
    fn reencode_forces_keyframes_at_segment_boundary() {
        // A re-encode MUST force keyframes at the HLS segment cadence (== -hls_time)
        // so the first segment closes promptly under -re. Otherwise the encoder's
        // long native GOP delays segment 0 past the readiness probe → grey 0:00.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        // Holds across every encoder family (CPU + each HW path).
        for enc in [
            HwEncoder::Cpu,
            HwEncoder::Vaapi,
            HwEncoder::Qsv,
            HwEncoder::Nvenc,
            HwEncoder::VideoToolbox,
        ] {
            let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, enc).join(" ");
            assert!(
                j.contains(&format!(
                    "-force_key_frames expr:gte(t,n_forced*{HLS_SEGMENT_SECS})"
                )),
                "re-encode must force keyframes ({enc:?}): {j}"
            );
            // The keyframe cadence and the segment length must be the same value.
            assert!(j.contains(&format!("-hls_time {HLS_SEGMENT_SECS}")), "{j}");
        }
    }

    #[test]
    fn copy_remux_does_not_force_keyframes() {
        // A copy-remux has no encoder to force keyframes on; it cuts at the
        // source's own keyframes. Forcing here would be a no-op flag at best.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(!j.contains("-force_key_frames"), "{j}");
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
    fn qsv_reencode_inits_device_and_uploads_with_no_other_filter() {
        // Plain HEVC→H264 (no scale/tone-map/burn): the QSV upload chain stands
        // alone as the whole filtergraph, and the hw device is initialized.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::EncodeAac { bitrate_kbps: 160 },
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv);
        let j = args.join(" ");
        assert!(j.contains("-init_hw_device qsv=hw"), "{j}");
        assert!(j.contains("-filter_hw_device hw"), "{j}");
        assert!(j.contains("-c:v h264_qsv"), "{j}");
        // HW encoders use the neutral `fast` preset, never libx264's veryfast.
        assert!(j.contains("-preset fast"), "{j}");
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "format=nv12,hwupload=extra_hw_frames=64",
            "standalone upload chain: {j}"
        );
    }

    #[test]
    fn qsv_appends_upload_after_scale() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(720),
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "scale=-2:720,format=nv12,hwupload=extra_hw_frames=64",
            "upload must be the last link, after the CPU scale"
        );
    }

    #[test]
    fn qsv_upload_is_last_after_tonemap_and_scale() {
        // The full HDR chain: tone-map → scale → nv12 → hwupload, in that order.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(720),
                tone_map: true,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv);
        let vf_idx = args.iter().position(|s| s == "-vf").unwrap();
        let filter = &args[vf_idx + 1];
        assert!(
            filter.ends_with(",format=nv12,hwupload=extra_hw_frames=64"),
            "{filter}"
        );
        let tone = filter.find("tonemap").unwrap();
        let scale = filter.find("scale=-2:720").unwrap();
        let upload = filter.find("hwupload").unwrap();
        assert!(
            tone < scale && scale < upload,
            "order tonemap<scale<hwupload: {filter}"
        );
    }

    #[test]
    fn qsv_device_init_precedes_input() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv);
        let dev = args
            .iter()
            .position(|s| s == "-init_hw_device")
            .expect("missing device init");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(dev < i, "-init_hw_device must precede -i (global opt)");
    }

    #[test]
    fn qsv_copy_remux_does_not_init_device() {
        // A pure remux never touches the encoder, so the GPU device must NOT be
        // opened and no hwupload is injected — even when the resolved family is
        // QSV. (Avoids a wasted device-open on the common local-title path.)
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv).join(" ");
        assert!(
            !j.contains("-init_hw_device"),
            "remux must not init hw device: {j}"
        );
        assert!(!j.contains("hwupload"), "remux must not upload: {j}");
        assert!(j.contains("-c:v copy"), "{j}");
    }

    #[test]
    fn cpu_reencode_never_inits_hw_device() {
        // Regression guard: the CPU (libx264) path must stay free of any QSV
        // device init or hwupload filter.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(720),
                tone_map: true,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(!j.contains("-init_hw_device"), "{j}");
        assert!(!j.contains("-vaapi_device"), "{j}");
        assert!(!j.contains("-low_power"), "{j}");
        assert!(!j.contains("hwupload"), "{j}");
        assert!(!j.contains("format=nv12"), "{j}");
    }

    #[test]
    fn vaapi_reencode_inits_device_low_power_and_uploads() {
        // Plain HEVC→H264 on VAAPI: explicit DRM device, low-power entrypoint,
        // and a standalone NV12 upload as the whole filtergraph.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::EncodeAac { bitrate_kbps: 160 },
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi);
        let j = args.join(" ");
        assert!(j.contains("-vaapi_device /dev/dri/renderD128"), "{j}");
        assert!(j.contains("-c:v h264_vaapi"), "{j}");
        assert!(j.contains("-low_power 1"), "{j}");
        // h264_vaapi has no preset; emitting one logs a per-session warning.
        assert!(!j.contains("-preset"), "VAAPI must not emit -preset: {j}");
        // VAAPI's hwupload takes no extra_hw_frames hint (that's QSV-only).
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(args[vf_idx + 1], "format=nv12,hwupload", "{j}");
    }

    #[test]
    fn vaapi_appends_upload_after_scale() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(720),
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "scale=-2:720,format=nv12,hwupload",
            "{}",
            args.join(" ")
        );
    }

    #[test]
    fn vaapi_device_precedes_input() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi);
        let dev = args
            .iter()
            .position(|s| s == "-vaapi_device")
            .expect("missing -vaapi_device");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(dev < i, "-vaapi_device must precede -i");
    }

    #[test]
    fn vaapi_copy_remux_does_not_init_device() {
        // A pure remux never re-encodes, so VAAPI must not open the GPU device,
        // emit -low_power, or inject an upload — even when the family is VAAPI.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi).join(" ");
        assert!(!j.contains("-vaapi_device"), "{j}");
        assert!(!j.contains("-low_power"), "{j}");
        assert!(!j.contains("hwupload"), "{j}");
        assert!(j.contains("-c:v copy"), "{j}");
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

    // ── Full-hardware VAAPI pipeline (hw_decode=true) ───────────────────────

    fn encode(scale: Option<i64>, tone_map: bool, burn: Option<i64>) -> TranscodePlan {
        transcode(
            VideoOp::EncodeH264 {
                scale_to_height: scale,
                tone_map,
                burn_subtitle_index: burn,
            },
            AudioOp::EncodeAac { bitrate_kbps: 192 },
            SubtitleOp::None,
        )
    }

    #[test]
    fn vaapi_full_hw_plain_inits_hwaccel_and_converts_nv12() {
        // Plain HEVC→H264 (no scale/tone-map): decode straight to VAAPI surfaces
        // and convert to NV12 on the GPU. NO software -vaapi_device, NO hwupload.
        let plan = encode(None, false, None);
        let args = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi, true);
        let j = args.join(" ");
        assert!(
            j.contains(
                "-hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi"
            ),
            "{j}"
        );
        assert!(j.contains("-c:v h264_vaapi"), "{j}");
        assert!(j.contains("-low_power 1"), "{j}");
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(args[vf_idx + 1], "scale_vaapi=format=nv12", "{j}");
        // Full-HW must NOT use the software-decode upload path.
        assert!(!j.contains("hwupload"), "no hwupload under full-HW: {j}");
        assert!(!j.contains("format=nv12,hwupload"), "{j}");
        assert!(
            !j.contains("-vaapi_device"),
            "no software -vaapi_device: {j}"
        );
        assert!(!j.contains("-preset"), "{j}");
    }

    #[test]
    fn vaapi_full_hw_hdr_uses_tonemap_vaapi_not_zscale() {
        // HDR→SDR runs on the GPU via tonemap_vaapi, NOT the CPU zscale/tonemap.
        let plan = encode(None, true, None);
        let args = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi, true);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "tonemap_vaapi=format=nv12",
            "{}",
            args.join(" ")
        );
        let j = args.join(" ");
        assert!(!j.contains("zscale"), "no CPU zscale under full-HW: {j}");
        assert!(
            !j.contains("tonemap=hable"),
            "no CPU tonemap under full-HW: {j}"
        );
        assert!(!j.contains("hwupload"), "{j}");
    }

    #[test]
    fn vaapi_full_hw_hdr_and_downscale_chain_order() {
        // 4K HDR → 1080p SDR: tonemap_vaapi then scale_vaapi, both on the GPU.
        let plan = encode(Some(1080), true, None);
        let args = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi, true);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "tonemap_vaapi=format=nv12,scale_vaapi=w=-2:h=1080",
            "{}",
            args.join(" ")
        );
    }

    #[test]
    fn vaapi_full_hw_scale_only_terminates_nv12() {
        // Non-HDR downscale: scale_vaapi carries the format=nv12 conversion.
        let plan = encode(Some(720), false, None);
        let args = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi, true);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "scale_vaapi=w=-2:h=720:format=nv12",
            "{}",
            args.join(" ")
        );
    }

    #[test]
    fn vaapi_full_hw_hwaccel_precedes_input_with_resume() {
        // -hwaccel* are input options: they (and -ss for resume) must precede -i.
        let plan = encode(None, false, None);
        let args = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 600, HwEncoder::Vaapi, true);
        let hw = args
            .iter()
            .position(|s| s == "-hwaccel")
            .expect("missing -hwaccel");
        let fmt = args
            .iter()
            .position(|s| s == "-hwaccel_output_format")
            .expect("missing -hwaccel_output_format");
        let ss = args.iter().position(|s| s == "-ss").expect("missing -ss");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(
            hw < i && fmt < i && ss < i,
            "hwaccel/ss must precede -i: {}",
            args.join(" ")
        );
        assert_eq!(args[ss + 1], "600");
    }

    #[test]
    fn vaapi_full_hw_falls_back_to_software_when_burning_subs() {
        // Image burn-in needs the CPU `subtitles` filter, so even with hw_decode
        // requested a burn forces the software-decode path (upload, no -hwaccel).
        let plan = encode(None, false, Some(2));
        let args = ffmpeg_args_hw(&plan, "/lib/m.mkv", "/tmp/s", 0, HwEncoder::Vaapi, true);
        let j = args.join(" ");
        assert!(
            !j.contains("-hwaccel"),
            "burn must not use full-HW decode: {j}"
        );
        assert!(j.contains("subtitles="), "{j}");
        assert!(
            j.contains("format=nv12,hwupload"),
            "burn uses software upload path: {j}"
        );
        assert!(j.contains("-vaapi_device /dev/dri/renderD128"), "{j}");
    }

    #[test]
    fn hw_decode_ignored_for_non_vaapi_family() {
        // hw_decode only drives the VAAPI full-HW path; QSV keeps its software
        // upload path even when hw_decode is set.
        let plan = encode(None, false, None);
        let j = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Qsv, true).join(" ");
        assert!(!j.contains("-hwaccel "), "no hwaccel decode for QSV: {j}");
        assert!(j.contains("-init_hw_device qsv=hw"), "{j}");
        assert!(j.contains("format=nv12,hwupload=extra_hw_frames=64"), "{j}");
    }

    #[test]
    fn hw_decode_false_keeps_software_vaapi_path() {
        // The default (hw_decode=false) is the proven software-decode VAAPI path.
        let plan = encode(None, false, None);
        let j = ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Vaapi, false).join(" ");
        assert!(!j.contains("-hwaccel"), "{j}");
        assert!(j.contains("-vaapi_device /dev/dri/renderD128"), "{j}");
        assert!(j.contains("format=nv12,hwupload"), "{j}");
    }
}
