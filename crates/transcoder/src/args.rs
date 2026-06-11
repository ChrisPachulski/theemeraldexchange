//! ffmpeg argument assembly (§4.2 HLS invocation, §4.4 encoder selection).
//!
//! Pure string assembly from a [`TranscodePlan`] → a `Vec<String>` ready for
//! `tokio::process::Command::args`. The HLS muxer is configured per media kind:
//!
//! * LIVE (iptv/channel) — paced to wall-clock with `-re` and a bounded sliding
//!   window (`-hls_list_size 8 -hls_flags delete_segments+append_list+omit_endlist`),
//!   mirroring `iptvRemux.ts`. Only the live edge is ever on disk.
//! * VOD (movies/episodes, the default) — transcoded full-speed and retained
//!   WHOLE (`-hls_list_size 0 -hls_flags append_list -hls_playlist_type event`,
//!   no `-re`, no delete). The EVENT playlist grows as the encoder races ahead,
//!   so the player buffers deep and seeks to any produced position; a clean EOF
//!   appends `EXT-X-ENDLIST` for full seek-to-end. Requires durable scratch
//!   sized for a whole title (see docker-compose.yml), not a RAM tmpfs.
//!
//! Snapshot-tested per plan and per kind.

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

/// Bitrate target (kbps) for an H.264 re-encode at the given OUTPUT height
/// (the scale target when scaling, else the source height). Conservative VBR
/// ladder; `maxrate`/`bufsize` are derived from this.
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
/// keyframe — tens of seconds in. That pushes the first segment past the
/// backend's manifest-readiness probe, and the player is handed a not-yet-written
/// playlist (503) → a grey rectangle stuck at 0:00. (Most acute for live `-re`
/// pacing, but the cadence pin matters for full-speed VOD re-encodes too.)
pub(crate) const HLS_SEGMENT_SECS: u32 = 4;

/// Is this media kind a LIVE source (an unbounded stream with no EOF)?
///
/// Live streams must keep `omit_endlist`: ffmpeg only "ends" a live remux when
/// the upstream dies, and writing `EXT-X-ENDLIST` then would make every player
/// treat the outage as the programme ending instead of retrying. Finite VOD
/// (movie/episode — everything the local-library grant path produces today)
/// must NOT omit it: without `EXT-X-ENDLIST` a finished title looks like a
/// stalled live stream, so players poll the manifest forever and never fire
/// their natural "ended" handling.
///
/// Matching is by kind name so a future IPTV port onto this crate inherits the
/// correct live semantics; anything unrecognized is treated as FINITE — the
/// failure mode of a mislabeled live stream (premature ENDLIST on upstream
/// death) is more recoverable than every movie ending in a livelocked player.
fn is_live_media_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "live" | "iptv" | "channel"
    )
}

/// Everything [`ffmpeg_args_for`] needs to assemble one ffmpeg invocation.
#[derive(Clone, Copy)]
/// Bundled as a struct so the session manager's growing per-session knobs
/// (kind-dependent HLS flags, crash-resume segment numbering) don't balloon
/// the positional-argument wrappers below.
pub struct ArgSpec<'a> {
    /// The resolved transcode plan (never `DirectPlay` in practice).
    pub plan: &'a TranscodePlan,
    /// Absolute source path.
    pub input: &'a str,
    /// Per-session tmpdir; the playlist and segments land here.
    pub session_dir: &'a str,
    /// Seek offset for resume/seek (`-ss`); 0 for a fresh start.
    pub start_secs: u64,
    /// Selected HW encoder family.
    pub encoder: HwEncoder,
    /// Full-hardware VAAPI decode (see [`ffmpeg_args_hw`] docs).
    pub hw_decode: bool,
    /// The session's media kind (`movie`/`episode`/…). Drives the HLS endlist
    /// semantics: live kinds keep `omit_endlist`, finite VOD gets
    /// `EXT-X-ENDLIST` on clean EOF (see [`is_live_media_kind`]).
    pub media_kind: &'a str,
    /// First segment number for this invocation (`-start_number`). 0 for a
    /// fresh session; a supervisor respawn passes the next number after the
    /// furthest segment the previous child wrote, keeping segment numbering
    /// MONOTONIC across respawns — a player (or cache) still holding the
    /// pre-respawn playlist can then never alias a stale `seg_00000.ts` name
    /// onto new media.
    pub start_number: u64,
}

/// Build the ffmpeg argument vector for a transcode plan (software-decode path).
///
/// Thin wrapper over [`ffmpeg_args_for`] with hardware decode OFF — the
/// historical 5-arg signature, kept for the call sites and tests that assert
/// the CPU-decode behavior. Defaults to a FINITE (vod) media kind; the session
/// manager calls [`ffmpeg_args_for`] directly with the session's real kind.
pub fn ffmpeg_args(
    plan: &TranscodePlan,
    input: &str,
    session_dir: &str,
    start_secs: u64,
    encoder: HwEncoder,
) -> Vec<String> {
    ffmpeg_args_hw(plan, input, session_dir, start_secs, encoder, false)
}

/// Historical 6-arg wrapper over [`ffmpeg_args_for`] (finite/vod media kind).
///
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
pub fn ffmpeg_args_hw(
    plan: &TranscodePlan,
    input: &str,
    session_dir: &str,
    start_secs: u64,
    encoder: HwEncoder,
    hw_decode: bool,
) -> Vec<String> {
    ffmpeg_args_for(&ArgSpec {
        plan,
        input,
        session_dir,
        start_secs,
        encoder,
        hw_decode,
        media_kind: "movie",
        start_number: 0,
    })
}

/// Build the full ffmpeg argument vector for a transcode plan (see [`ArgSpec`]
/// for the per-field semantics).
///
/// Returns an empty vec for a [`TranscodePlan::DirectPlay`] (caller should
/// never invoke ffmpeg in that case — this is a defensive no-op).
pub fn ffmpeg_args_for(spec: &ArgSpec<'_>) -> Vec<String> {
    let ArgSpec {
        plan,
        input,
        session_dir,
        start_secs,
        encoder,
        hw_decode,
        media_kind,
        start_number,
    } = *spec;
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

    // Real-time input pacing (`-re`) is for LIVE sources ONLY. A live remux
    // streams at wall-clock rate, and its HLS sliding window (delete_segments +
    // hls_list_size 8) tracks the consumer so the bounded scratch only ever
    // holds the live edge. Finite VOD titles do the OPPOSITE: they transcode AS
    // FAST AS THE ENCODER ALLOWS and retain every segment (list_size 0, no
    // delete — see the HLS muxer block), so the player buffers deep ahead of
    // playback and can seek to anything already produced. Pacing a VOD title
    // with -re is exactly what pinned the buffer to the live edge (~one segment
    // at a time) and made forward-seeking impossible — segments past "now"
    // didn't exist yet. -re is an input option, so it sits with -ss before -i.
    if is_live_media_kind(media_kind) {
        push(&mut a, "-re");
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
            source_height,
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

            // Key the ladder on the OUTPUT height: the scale target when
            // down-scaling, else the source's own height (an unscaled re-encode
            // keeps it). Keying on scale_to_height alone (capped at 1080/None)
            // made the >1080p arm unreachable — an unscaled 4K re-encode got
            // the 1080p 6000k and looked like mud.
            let br = h264_bitrate_kbps(scale_to_height.or(*source_height));
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
            // Downmix to stereo. The HLS output is consumed by hls.js, which
            // transmuxes the TS audio to fMP4 for MSE; Chrome and Firefox FAIL
            // the SourceBuffer append of a >2-channel (5.1/7.1) AAC track
            // ("audio SourceBuffer error. MediaSource readyState: ended"),
            // which fails the whole fragment and freezes the player grey at
            // 0:00 — even though the codec string (mp4a.40.2) reports as
            // supported. Stereo appends and plays in every target browser
            // (proven by an in-browser A/B on a real 5.1 title). Mono upmixes
            // harmlessly; an already-stereo source is a no-op. TODO(M4+): when
            // ClientCaps grows an audio-channel capability, pass multichannel
            // through for native clients (AVPlayer handles 5.1) and downmix
            // only for browser/MSE consumers.
            push(&mut a, "-ac");
            push(&mut a, "2");
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
    if is_live_media_kind(media_kind) {
        // LIVE: a bounded sliding window on the scratch disk. delete_segments
        // prunes the oldest as new ones arrive (only the live edge is kept), and
        // omit_endlist keeps the playlist "live" so a player treats an upstream
        // death as a retryable gap, not a clean programme end. Paced by -re
        // above so the producer tracks the consumer and the window never races.
        push(&mut a, "-hls_list_size");
        push(&mut a, "8");
        push(&mut a, "-hls_flags");
        push(&mut a, "delete_segments+append_list+omit_endlist");
    } else {
        // VOD: retain EVERY segment (list_size 0, no delete_segments) and mark
        // the playlist EVENT so hls.js treats it as a growing, fully-seekable
        // VOD — the player buffers as far ahead as the (faster-than-realtime)
        // encoder has reached and can seek to any produced position, with full
        // seek-to-end once a clean EOF appends EXT-X-ENDLIST (the supervisor
        // parks the session `Completed` and keeps the segments for drain). A
        // backward seek/resume no longer needs a fresh -ss grant — the segment
        // is already on disk. This requires durable scratch sized for a whole
        // title, NOT the old 2 GB RAM tmpfs (see docker-compose.yml).
        push(&mut a, "-hls_list_size");
        push(&mut a, "0");
        push(&mut a, "-hls_flags");
        push(&mut a, "append_list");
        push(&mut a, "-hls_playlist_type");
        push(&mut a, "event");
    }
    // Monotonic segment numbering across supervisor respawns (see ArgSpec).
    // Omitted at 0 — ffmpeg's default — so fresh sessions keep the proven argv.
    if start_number > 0 {
        push(&mut a, "-start_number");
        a.push(start_number.to_string());
    }
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

/// Escape a path for use inside a single-quoted ffmpeg filtergraph argument
/// (colons and backslashes are special to the filter parser). Per ffmpeg's
/// quoting rules there is NO escape FOR a quote INSIDE a quoted string — the
/// quoting must be closed, the quote backslash-escaped outside it, and the
/// string reopened (`'\''`), exactly like POSIX shell quoting; `\'` would
/// terminate the string and leak the rest unquoted.
fn escape_filter_path(p: &str) -> String {
    p.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "'\\''")
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
        // The historical wrappers default to a finite/VOD kind: no -re, retain
        // every segment (list_size 0, append_list), EVENT playlist for a growing
        // seekable VOD.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/lib/m.mkv", "/tmp/sess", 0, HwEncoder::Cpu);
        let joined = args.join(" ");
        assert_eq!(
            joined,
            "-hide_banner -loglevel warning -nostdin -fflags +genpts -i /lib/m.mkv \
             -map 0:v:0 -map 0:a:0? -c:v copy -c:a copy \
             -f hls -hls_time 4 -hls_list_size 0 -hls_flags append_list \
             -hls_playlist_type event \
             -hls_segment_filename /tmp/sess/seg_%05d.ts /tmp/sess/index.m3u8"
        );
    }

    #[test]
    fn live_kinds_pace_with_re_before_input() {
        // -re is emitted for LIVE sources (so the producer tracks the consumer
        // and the sliding window never races) and must sit before -i.
        let args = args_for_kind("live");
        let re = args.iter().position(|s| s == "-re").expect("missing -re");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(re < i, "-re must precede -i");
    }

    #[test]
    fn vod_kinds_omit_re() {
        // Finite VOD must NOT be paced: -re is what capped the buffer at the live
        // edge and blocked forward-seeking. The encoder runs full speed.
        for kind in ["movie", "episode", "show"] {
            let args = args_for_kind(kind);
            assert!(
                !args.iter().any(|s| s == "-re"),
                "{kind}: VOD must not emit -re: {}",
                args.join(" ")
            );
        }
    }

    #[test]
    fn seek_offset_coexists_with_re_for_live() {
        // A live resume carries both -ss and -re before -i.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args_for(&ArgSpec {
            plan: &plan,
            input: "/in.mkv",
            session_dir: "/tmp/s",
            start_secs: 120,
            encoder: HwEncoder::Cpu,
            hw_decode: false,
            media_kind: "live",
            start_number: 0,
        });
        let ss = args.iter().position(|s| s == "-ss").expect("missing -ss");
        let re = args.iter().position(|s| s == "-re").expect("missing -re");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(ss < i && re < i, "-ss and -re must precede -i");
    }

    #[test]
    fn vod_seek_offset_has_ss_without_re() {
        // A VOD resume bakes -ss (fast keyframe seek) but never -re.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 120, HwEncoder::Cpu);
        let ss = args.iter().position(|s| s == "-ss").expect("missing -ss");
        let i = args.iter().position(|s| s == "-i").expect("missing -i");
        assert!(ss < i, "-ss must precede -i");
        assert!(!args.iter().any(|s| s == "-re"), "VOD must not emit -re");
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
                source_height: None,
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
        // AAC re-encode is forced to stereo (-ac 2) so the browser MSE path can
        // append it — a multichannel append fails ("audio SourceBuffer error").
        assert!(j.contains("-c:a aac -ac 2 -b:a 192k"), "{j}");
        // No -vf when nothing in the filtergraph.
        assert!(!j.contains("-vf"), "{j}");
    }

    #[test]
    fn reencoded_audio_is_downmixed_to_stereo() {
        // Regression for the American Dad! S02E03 grey-box: a 5.1 AAC append is
        // rejected by Chrome/Firefox MSE, so every AAC re-encode must emit -ac 2.
        let plan = transcode(
            VideoOp::Copy,
            AudioOp::EncodeAac { bitrate_kbps: 192 },
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu);
        let ac = args
            .iter()
            .position(|s| s == "-ac")
            .expect("must force channel count");
        assert_eq!(args[ac + 1], "2", "downmix to stereo");
        let j = args.join(" ");
        assert!(j.contains("-c:a aac -ac 2 -b:a 192k"), "{j}");
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
                source_height: None,
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
                source_height: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-c:v libx264"), "{j}");
        assert!(j.contains("-preset veryfast"), "{j}");
    }

    #[test]
    fn unscaled_4k_reencode_uses_4k_bitrate_arm() {
        // Regression: the ladder keyed on scale_to_height, which the planner
        // caps at 1080/None — so an UNSCALED 4K re-encode (e.g. an HEVC 2160p
        // source for a 4K-capable h264 client) fell into the 1080p 6000k arm.
        // The output keeps the source height, so the ladder must key on it.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: Some(2160),
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-b:v 12000k"), "4K arm must apply: {j}");
        assert!(j.contains("-maxrate 18000k"), "{j}");
        assert!(j.contains("-bufsize 24000k"), "{j}");
    }

    #[test]
    fn downscaled_4k_uses_scale_target_bitrate() {
        // When scaling IS applied the output height is the scale target, so a
        // 4K source down-scaled to 1080p stays on the 1080p arm.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(1080),
                tone_map: false,
                burn_subtitle_index: None,
                source_height: Some(2160),
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(
            j.contains("-b:v 6000k"),
            "scaled output keys the ladder: {j}"
        );
    }

    #[test]
    fn unscaled_720p_reencode_uses_720p_bitrate_arm() {
        // The output-height keying must also step DOWN: an unscaled 720p
        // source doesn't deserve the 1080p default rate.
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: Some(720),
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-b:v 3000k"), "720p arm must apply: {j}");
    }

    #[test]
    fn scale_filter_present_when_downscaling() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: Some(1080),
                tone_map: false,
                burn_subtitle_index: None,
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let j = ffmpeg_args(&plan, "/lib/show s01e01.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("subtitles="), "{j}");
        assert!(j.contains(":si=2"), "{j}");
    }

    #[test]
    fn escape_filter_path_quote_uses_close_escape_reopen() {
        // Inside ffmpeg's single-quoted strings the ONLY way to express a
        // literal quote is close-escape-reopen ('\''), shell-style; \' would
        // end the quoted string early and leak the remainder unquoted.
        // (Dormant path — burn-in is disabled — but it must stay correct.)
        assert_eq!(
            escape_filter_path("/lib/it's here.mkv"),
            "/lib/it'\\''s here.mkv"
        );
        // Colons and backslashes are filter-parser specials: backslash-escaped.
        assert_eq!(escape_filter_path("/lib/a:b.mkv"), "/lib/a\\:b.mkv");
        assert_eq!(escape_filter_path("/lib/a\\b.mkv"), "/lib/a\\\\b.mkv");
        // All three composed; the quote handling never re-escapes itself.
        assert_eq!(escape_filter_path("a'b:c\\d"), "a'\\''b\\:c\\\\d");
    }

    #[test]
    fn burn_in_filter_embeds_quoted_path_correctly() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: Some(1),
                source_height: None,
            },
            AudioOp::Copy,
            SubtitleOp::None,
        );
        let args = ffmpeg_args(&plan, "/lib/it's.mkv", "/tmp/s", 0, HwEncoder::Cpu);
        let vf_idx = args.iter().position(|s| s == "-vf").expect("missing -vf");
        assert_eq!(
            args[vf_idx + 1],
            "subtitles='/lib/it'\\''s.mkv':si=1",
            "quote must close-escape-reopen inside the quoted filename"
        );
    }

    #[test]
    fn webvtt_extract_maps_subtitle_stream() {
        let plan = transcode(
            VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
                source_height: None,
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
        // VOD default: append-only growing playlist, no deletion, EVENT type.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let j = ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" ");
        assert!(j.contains("-hls_list_size 0"), "{j}");
        assert!(j.contains("-hls_flags append_list"), "{j}");
        assert!(j.contains("-hls_playlist_type event"), "{j}");
        assert!(!j.contains("delete_segments"), "VOD must not prune: {j}");
        assert!(
            j.ends_with("/tmp/s/index.m3u8"),
            "playlist is last arg: {j}"
        );
    }

    fn args_for_kind(kind: &str) -> Vec<String> {
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        ffmpeg_args_for(&ArgSpec {
            plan: &plan,
            input: "/in.mkv",
            session_dir: "/tmp/s",
            start_secs: 0,
            encoder: HwEncoder::Cpu,
            hw_decode: false,
            media_kind: kind,
            start_number: 0,
        })
    }

    #[test]
    fn start_number_emitted_only_when_nonzero() {
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        let spec = |n: u64| ArgSpec {
            plan: &plan,
            input: "/in.mkv",
            session_dir: "/tmp/s",
            start_secs: 0,
            encoder: HwEncoder::Cpu,
            hw_decode: false,
            media_kind: "movie",
            start_number: n,
        };
        // Fresh session: ffmpeg's default numbering, no extra flag.
        let j0 = ffmpeg_args_for(&spec(0)).join(" ");
        assert!(!j0.contains("-start_number"), "{j0}");
        // Respawn: numbering continues from the supervisor's counter.
        let args = ffmpeg_args_for(&spec(7));
        let pos = args
            .iter()
            .position(|s| s == "-start_number")
            .expect("respawn must emit -start_number");
        assert_eq!(args[pos + 1], "7");
        // It must be a muxer (output) option: after -i.
        let i = args.iter().position(|s| s == "-i").unwrap();
        assert!(pos > i, "-start_number is an output option");
    }

    #[test]
    fn finite_vod_kinds_emit_endlist_on_eof() {
        // Movies/episodes are FINITE: omit_endlist must NOT be set, so a clean
        // ffmpeg EOF writes EXT-X-ENDLIST and the player ends the title instead
        // of polling a "live" manifest forever. (Regression: omit_endlist was
        // unconditional, copied from the live-IPTV invocation.) Unknown kinds
        // are treated as finite too — the conservative default.
        for kind in ["movie", "episode", "series", "show", "Movie", "whatever"] {
            let j = args_for_kind(kind).join(" ");
            // EVENT playlist + append-only, all segments retained, no pruning.
            assert!(j.contains("-hls_playlist_type event"), "{kind}: {j}");
            assert!(j.contains("-hls_flags append_list"), "{kind}: {j}");
            assert!(j.contains("-hls_list_size 0"), "{kind}: {j}");
            assert!(
                !j.contains("delete_segments"),
                "finite kind {kind:?} must retain segments: {j}"
            );
            assert!(
                !j.contains("omit_endlist"),
                "finite kind {kind:?} must not omit ENDLIST: {j}"
            );
        }
    }

    #[test]
    fn live_kinds_keep_omit_endlist() {
        // A live source has no real EOF: ffmpeg exiting means the upstream
        // died, and writing ENDLIST then would tell every player the programme
        // ended (no retry). Live kinds keep the omit.
        for kind in ["live", "iptv", "channel", "LIVE", " live "] {
            let j = args_for_kind(kind).join(" ");
            assert!(
                j.contains("-hls_flags delete_segments+append_list+omit_endlist"),
                "live kind {kind:?} must keep omit_endlist: {j}"
            );
        }
    }

    #[test]
    fn ffmpeg_args_wrappers_default_to_finite_kind() {
        // The historical wrappers (used by the bulk of the tests and any
        // external caller) must default to the finite/vod semantics — the only
        // sessions this crate starts today are local-library movies/episodes.
        let plan = transcode(VideoOp::Copy, AudioOp::Copy, SubtitleOp::None);
        for j in [
            ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu).join(" "),
            ffmpeg_args_hw(&plan, "/in.mkv", "/tmp/s", 0, HwEncoder::Cpu, false).join(" "),
        ] {
            assert!(!j.contains("omit_endlist"), "{j}");
        }
    }

    // ── Full-hardware VAAPI pipeline (hw_decode=true) ───────────────────────

    fn encode(scale: Option<i64>, tone_map: bool, burn: Option<i64>) -> TranscodePlan {
        transcode(
            VideoOp::EncodeH264 {
                scale_to_height: scale,
                tone_map,
                burn_subtitle_index: burn,
                source_height: None,
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
