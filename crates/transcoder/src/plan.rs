//! Transcode planning (§4.3). A pure function over a file's cached probe
//! metadata + a client's advertised capabilities that produces the SMALLEST
//! re-encode satisfying the client.
//!
//! The gate is media-core's [`capability::decide`]: when a file direct-plays,
//! the plan is [`TranscodePlan::DirectPlay`] and no ffmpeg ever runs. Only when
//! `decide()` denies do we compute per-stream operations:
//!
//! * video — copy when the codec is already accepted *and* the height is in
//!   range; otherwise re-encode to the smallest accepted target (h264), adding
//!   a scale filter when the source exceeds the client's `max_height` and a
//!   tone-map flag when the source is HDR and the client is SDR.
//! * audio — copy only when the codec is accepted *and* the track is stereo/
//!   mono; otherwise transcode to AAC (stereo). Multichannel (5.1/7.1) audio is
//!   downmixed because the browser MSE path rejects a >2-channel append.
//! * subtitles — NOT carried on the live stream. Inline WebVTT extraction
//!   stalled the first segment under `-re` (and was orphaned with no master
//!   playlist), so it is disabled; image formats were already dropped (libass
//!   can't render bitmaps). A title transcodes without in-player subs rather
//!   than not playing at all; selectable subs return via a sidecar `<track>`.
//!   See [`plan_subtitle`].
//!
//! This is deliberately deterministic: every branch is exercised by a unit
//! test, and `ffmpeg_args` (in [`crate::args`]) turns a plan into a concrete
//! invocation. No real transcode happens here.

use media_core::capability::{ClientCaps, decide};
use media_core::models::{AudioTrack, MediaFileRow, SubtitleTrack};
use serde::Serialize;

/// Target H.264 height once we re-encode. The capability matrix only ever
/// down-scales to 1080p in v1 (§4.3); 4K passthrough requires an HEVC-capable
/// client and is handled by `decide()` returning direct-play.
pub const DEFAULT_TARGET_HEIGHT: i64 = 1080;

/// The accepted text-subtitle codecs we can repackage as WebVTT without
/// burning pixels.
const TEXT_SUBTITLE_CODECS: &[&str] = &[
    "subrip", "srt", "webvtt", "vtt", "ass", "ssa", "mov_text", "text",
];

/// Image-based (bitmap) subtitle codecs. These can only be shown by
/// compositing onto the video; we currently drop them (see [`plan_subtitle`])
/// because the libass `subtitles` filter cannot render bitmap subtitles.
const IMAGE_SUBTITLE_CODECS: &[&str] = &[
    "hdmv_pgs_subtitle",
    "pgssub",
    "pgs",
    "dvd_subtitle",
    "dvdsub",
    "vobsub",
];

/// What to do with the video stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum VideoOp {
    /// `-c:v copy` — keep the elementary stream untouched.
    Copy,
    /// `-c:v copy` of a **Dolby Vision** HEVC stream, DV metadata intact, for
    /// a client that advertised `dolby_vision` (its pipeline applies the RPU).
    /// Only single-layer profiles ride this path (5 and 8 — P7's enhancement
    /// layer cannot be carried in HLS), always in fMP4 segments. `dv_profile`
    /// picks the sample-entry tag: P5 is DV-only (`dvh1`), P8 has a
    /// cross-compatible base layer (`hvc1`).
    CopyDolbyVision { dv_profile: u8 },
    /// Re-encode to H.264. `scale_to_height` is `Some` when we down-scale,
    /// `tone_map` is set when collapsing HDR → SDR, and `burn_subtitle_index`
    /// carries the absolute stream index of an image subtitle to burn in.
    /// `source_height` is the probe height of the source; with no scale the
    /// OUTPUT keeps it, so the bitrate ladder must key on it (an unscaled 4K
    /// re-encode needs the 4K rate arm, not the 1080p default).
    EncodeH264 {
        scale_to_height: Option<i64>,
        tone_map: bool,
        burn_subtitle_index: Option<i64>,
        source_height: Option<i64>,
    },
    /// Re-encode a **Dolby Vision** source to H.264 SDR via libplacebo, which
    /// APPLIES the DV RPU metadata (`apply_dolbyvision`) before tone-mapping to
    /// BT.709. Profile 5 (single-layer, no HDR10-compatible base) is the reason
    /// this exists: stream-copying it hands AVPlayer an undecodable elementary
    /// stream (CoreMediaErrorDomain -4), and a plain re-encode without the RPU
    /// produces grossly wrong colors (green skies, magenta skin). libplacebo
    /// needs a Vulkan device (Mesa ANV on the iGPU) — a separate pipeline from
    /// the VAAPI path, so it is its own op. Always caps output at
    /// `DEFAULT_TARGET_HEIGHT` so the (CPU libx264) encode stays tractable.
    EncodeDolbyVision {
        /// `Some(h)` to down-scale to height `h` (CPU scale after libplacebo);
        /// `None` keeps the source resolution.
        scale_to_height: Option<i64>,
        /// Probe height of the source — keys the H.264 bitrate ladder.
        source_height: Option<i64>,
    },
}

/// What to do with the audio stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum AudioOp {
    /// `-c:a copy`.
    Copy,
    /// `-c:a aac -b:a <kbps>k`.
    EncodeAac { bitrate_kbps: u32 },
}

/// What to do with subtitles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum SubtitleOp {
    /// No subtitle stream selected.
    None,
    /// Repackage a text subtitle as WebVTT (`-c:s webvtt`).
    ExtractWebVtt { source_index: i64 },
}

/// A subtitle track selected for **sidecar** WebVTT extraction. Unlike
/// [`SubtitleOp`] — which governs the LIVE HLS output and stays `None` — this
/// drives a SEPARATE one-shot ffmpeg pass (no `-re`, no HLS) that writes a
/// COMPLETE `subtitles.vtt` beside the session, loaded by the player as a
/// `<track>`. Decoupled from the segment stream, it reintroduces selectable
/// subs without the first-segment stall that killed inline extraction (see
/// [`plan_subtitle`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SidecarSubtitle {
    /// Absolute source stream index to extract (`-map 0:<index>`).
    pub source_index: i64,
    /// ISO language tag from the probe, when known (for `<track srclang>`).
    pub language: Option<String>,
    /// Whether the chosen track is a forced/narrative track.
    pub forced: bool,
}

/// Default AAC bitrate when we have to re-encode audio (§4.3).
pub const DEFAULT_AAC_BITRATE_KBPS: u32 = 192;

/// AAC bitrate when the re-encode is a multichannel → stereo DOWNMIX. A 5.1
/// mix folded to 2.0 carries more spectral content than a native stereo
/// track; 192k audibly smears it, 256k is transparent for AAC-LC stereo.
pub const DOWNMIX_AAC_BITRATE_KBPS: u32 = 256;

/// HLS segment container for the session's output.
///
/// MPEG-TS is the default (H.264-only delivery: hls.js transmuxes TS→fMP4
/// itself but its transmuxer DEMUXES ONLY H.264). fMP4 is selected when (and
/// only when) the plan copies an HEVC stream — HEVC must arrive already in
/// fMP4 for hls.js/MSE (and Apple's HLS spec requires fMP4 for HEVC too).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SegmentFormat {
    #[default]
    MpegTs,
    Fmp4,
}

/// The resolved plan. `DirectPlay` short-circuits the whole pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TranscodePlan {
    DirectPlay {
        reason: String,
    },
    Transcode {
        video: VideoOp,
        audio: AudioOp,
        subtitle: SubtitleOp,
        /// HLS segment container (TS for H.264 delivery, fMP4 for HEVC copy).
        #[serde(default)]
        segment_format: SegmentFormat,
        /// Audio-relative index (`-map 0:a:<n>`) of the track to play: the first
        /// English-tagged audio, else the file's first audio. Some releases flag a
        /// foreign track DEFAULT (e.g. Italian on "Hoppers"), so taking `0:a:0`
        /// blindly played the wrong language; this lands on English like
        /// Plex/Jellyfin. See [`preferred_audio_index`].
        #[serde(default)]
        audio_index: usize,
        /// ADDITIONAL audio tracks to mux in after the primary `audio_index`, as
        /// `(audio-relative source index, per-track op)`, in menu order. Non-empty
        /// ONLY for a `native_hls` client (AVPlayer), which exposes them as
        /// switchable in-band renditions; the primary stays first so it's the
        /// default. Empty for browser/MSE (single track) — the single-audio arg
        /// path is then byte-identical to before. See [`plan_extra_audio`].
        #[serde(default)]
        extra_audio: Vec<(usize, AudioOp)>,
        /// Echo of why direct-play was denied — useful for telemetry/inventory.
        reason: String,
    },
}

impl TranscodePlan {
    /// True iff the file can be sent as-is (no ffmpeg).
    pub fn is_direct_play(&self) -> bool {
        matches!(self, TranscodePlan::DirectPlay { .. })
    }

    /// True iff the plan RE-ENCODES the video stream (libx264/HW H.264) — the
    /// only work that actually loads the CPU. A copy-remux (changing only the
    /// container and/or audio codec) uses negligible CPU, so it must NOT be
    /// charged against the stricter CPU-transcode cap; otherwise a box with no
    /// HW encoder (every session resolves to the CPU encoder) throttles the
    /// whole household to ONE concurrent stream even though remuxes are nearly
    /// free, and a second title (or a reopen within the idle-reap window) 503s.
    pub fn reencodes_video(&self) -> bool {
        matches!(
            self,
            TranscodePlan::Transcode {
                video: VideoOp::EncodeH264 { .. } | VideoOp::EncodeDolbyVision { .. },
                ..
            }
        )
    }
}

fn contains_ci(haystack: &[String], needle: &str) -> bool {
    haystack.iter().any(|c| c.eq_ignore_ascii_case(needle))
}

/// Is this codec+profile pair safe to COPY (`-c:v copy`) for the client?
///
/// The codec STRING alone is not enough: browsers advertise/decode only the
/// 8-bit 4:2:0 profiles. A 10-bit H.264 (Hi10P — ffprobe profile "High 10")
/// stream is still `h264`, so a codec-only gate video-copies it straight into
/// an HLS session no browser can decode — the player demuxes it, MSE rejects
/// (or renders garbage on) the append, and the user gets the grey-box-at-0:00
/// failure class with a "successful" session on the server.
///
/// This mirrors the AAC-copy-only-≤2ch pattern in [`plan_audio`]: copy is the
/// CONSERVATIVE branch (only profiles proven browser-decodable), re-encode is
/// the permissive fallback (a needless re-encode costs some GPU/CPU; a wrong
/// copy is a total playback failure).
///
/// * h264 — allowlist of the 8-bit 4:2:0 profiles every target browser
///   decodes. "High 10", "High 10 Intra", "High 4:2:2", "High 4:4:4
///   Predictive" all fall through to re-encode.
/// * hevc — "Main" and "Main 10". An hevc copy is additionally gated on the
///   client's `hls_fmp4_hevc` bit in [`plan_transcode`] (HEVC can only be
///   delivered in fMP4 segments); a client setting that bit probed real
///   Main 10 hardware decode, so both 8- and 10-bit profiles are copy-safe.
/// * unknown/empty profile on h264/hevc — re-encode. Mirrors the
///   unknown-channel-count audio rule: we cannot prove the copy is safe.
/// * other codecs (vp9/av1/…) — never copied; see `hls_copy_deliverable` in
///   [`plan_transcode`]: there is no HLS segment container the shipped player
///   stack demuxes them from, so the codec gate alone is not enough.
fn video_profile_copy_safe(codec: &str, profile: Option<&str>) -> bool {
    let profile = profile.map(str::trim).unwrap_or("").to_ascii_lowercase();
    match codec.trim().to_ascii_lowercase().as_str() {
        "h264" | "avc" | "avc1" => matches!(
            profile.as_str(),
            "baseline" | "constrained baseline" | "main" | "high" | "constrained high"
        ),
        "hevc" | "h265" => matches!(profile.as_str(), "main" | "main 10"),
        _ => true,
    }
}

fn is_text_subtitle(codec: &str) -> bool {
    TEXT_SUBTITLE_CODECS
        .iter()
        .any(|c| codec.eq_ignore_ascii_case(c))
}

fn is_image_subtitle(codec: &str) -> bool {
    IMAGE_SUBTITLE_CODECS
        .iter()
        .any(|c| codec.eq_ignore_ascii_case(c))
}

/// Subtitle disposition for the live HLS output. Currently always `None`:
/// inline subtitle handling is DISABLED on the real-time stream for two reasons.
///
/// 1. **Latency.** Under `-re` (real-time input pacing) the HLS muxer holds a
///    segment open until *every* mapped stream — including the sparse subtitle
///    stream — reaches the segment boundary. On a title whose first subtitle cue
///    is late, that delays the FIRST video segment by ~9s of wall-clock, long
///    enough to blow past the player's manifest-readiness window and leave a grey
///    rectangle at 0:00. (Measured: ~13s with the WebVTT map, ~4.5s without it.)
/// 2. **It delivered nothing.** ffmpeg wrote the WebVTT rendition as a separate
///    `index_vtt.m3u8`, but the muxer emits no master playlist (`-master_pl_name`
///    is unset), so nothing referenced it — the extracted subs were orphaned and
///    never shown by the player anyway.
///
/// So removing inline extraction costs no working feature and fixes the stall.
/// Subtitles return instead as a pre-extracted **sidecar WebVTT** (`<track>`,
/// decoupled from the live stream) — IMPLEMENTED by [`plan_sidecar_subtitle`] +
/// [`crate::args::sidecar_vtt_args`] + the session manager's one-shot extraction.
/// This live-stream disposition therefore stays `None` on purpose.
///
/// Returns `(op, burn_index)`; both are `None`. Detection is still run for the
/// log trail (and to keep the text/image classifiers + the `ExtractWebVtt` op
/// live for the args-builder test).
///
/// Image subtitles (PGS/VOBSUB/DVD) were already dropped: the libass `subtitles`
/// filter cannot decode bitmaps and would abort the session ("Only text based
/// subtitles are currently supported"); a correct burn needs an `overlay`-based
/// filtergraph fed by the decoded subtitle stream.
fn plan_subtitle(file: &MediaFileRow) -> (SubtitleOp, Option<i64>) {
    let tracks = file.subtitle_tracks();
    let is_text = |t: &&SubtitleTrack| is_text_subtitle(t.codec.as_deref().unwrap_or("").trim());
    if let Some(track) = tracks
        .iter()
        .find(|t| t.forced && is_text(t))
        .or_else(|| tracks.iter().find(is_text))
    {
        tracing::debug!(
            path = %file.path,
            index = track.index,
            "text subtitle present; inline extraction disabled (needs sidecar)"
        );
    } else if tracks
        .iter()
        .any(|t| is_image_subtitle(t.codec.as_deref().unwrap_or("").trim()))
    {
        tracing::debug!(path = %file.path, "dropping image-only subtitles (burn-in not yet supported)");
    }
    (SubtitleOp::None, None)
}

/// Choose the best TEXT subtitle track to pre-extract to a sidecar WebVTT, or
/// `None` when the file carries no text subtitle.
///
/// Selection mirrors the (now dormant) inline picker in [`plan_subtitle`]: a
/// FORCED text track wins (foreign-dialogue subs the viewer almost always wants
/// burned on), else the FIRST text track in probe order. Image subtitles
/// (PGS/VOBSUB/DVD) are never eligible — WebVTT is text-only, and a bitmap
/// track can only be shown by compositing onto the video (the dropped burn-in
/// path) — so they are skipped here exactly as in [`plan_subtitle`].
///
/// Pure over the file's probe metadata. The actual extraction command is
/// [`crate::args::sidecar_vtt_args`]; the one-shot run is wired into the session
/// manager's start path (decoupled from the live HLS child).
pub fn plan_sidecar_subtitle(file: &MediaFileRow) -> Option<SidecarSubtitle> {
    let tracks = file.subtitle_tracks();
    let is_text = |t: &&SubtitleTrack| is_text_subtitle(t.codec.as_deref().unwrap_or("").trim());
    let chosen = tracks
        .iter()
        .find(|t| t.forced && is_text(t))
        .or_else(|| tracks.iter().find(is_text))?;
    Some(SidecarSubtitle {
        source_index: chosen.index,
        language: chosen.language.clone(),
        forced: chosen.forced,
    })
}

/// Compute the transcode plan for `file` against `caps`.
///
/// Pure and deterministic — see the module-level test matrix.
pub fn plan_transcode(file: &MediaFileRow, caps: &ClientCaps) -> TranscodePlan {
    let decision = decide(file, caps);
    if decision.direct_play {
        return TranscodePlan::DirectPlay {
            reason: decision.reason,
        };
    }
    plan_transcode_ops(file, caps, decision.reason)
}

/// Like [`plan_transcode`] but never returns `DirectPlay`: the client has
/// explicitly asked for buffered (HLS) delivery, so a direct-play-eligible
/// file resolves to a lossless copy-remux (h264→TS, hevc→fMP4) instead of a
/// progressive grant. Per-stream copy-vs-reencode safety gates are unchanged.
pub fn plan_transcode_forced(file: &MediaFileRow, caps: &ClientCaps) -> TranscodePlan {
    plan_transcode_ops(file, caps, "forced buffered delivery".to_string())
}

/// True when the probed HDR label marks the source as Dolby Vision. media-core's
/// probe sets `hdr_format = "Dolby Vision"` from stream side-data; the transcoder
/// grant additionally back-fills it after a frame-level probe for in-band RPU
/// (Profile 5 in Matroska carries no stream-level DV box). See
/// [`crate::routes`] grant DV detection.
pub fn is_dolby_vision(hdr_format: Option<&str>) -> bool {
    hdr_format
        .map(str::trim)
        .map(|h| h.to_ascii_lowercase().contains("dolby vision") || h.eq_ignore_ascii_case("dovi"))
        .unwrap_or(false)
}

/// DV profile parsed from the probe's label ("Dolby Vision P5" → 5). `None`
/// for a bare "Dolby Vision" (stream-level config box absent or predates the
/// profile capture) — unknown profile fails closed to the RPU re-encode.
pub fn dolby_vision_profile(hdr_format: Option<&str>) -> Option<u8> {
    let label = hdr_format?.trim().to_ascii_lowercase();
    let rest = label.strip_prefix("dolby vision p")?;
    rest.split_whitespace().next()?.parse().ok()
}

/// `TRANSCODER_DV_PASSTHROUGH` gate (default OFF, same truthy convention as
/// TRANSCODER_TRICKPLAY). DV copy has real client-matrix risk — a mistagged
/// or misadvertised client shows wrong colors — so it ships dark until the
/// living-room devices prove it.
fn dv_passthrough_enabled() -> bool {
    matches!(
        std::env::var("TRANSCODER_DV_PASSTHROUGH")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn plan_transcode_ops(file: &MediaFileRow, caps: &ClientCaps, reason: String) -> TranscodePlan {
    plan_transcode_ops_with(file, caps, reason, dv_passthrough_enabled())
}

/// The env-independent core — `dv_passthrough` is threaded as a parameter so
/// the test matrix never mutates process env (tests run in parallel).
fn plan_transcode_ops_with(
    file: &MediaFileRow,
    caps: &ClientCaps,
    reason: String,
    dv_passthrough: bool,
) -> TranscodePlan {
    // ── Subtitles. burn_index is always None now (image subs are dropped, not
    // burned), so subtitles no longer force a video re-encode on their own. ──
    let (subtitle, burn_index) = plan_subtitle(file);

    // ── Dolby Vision ─────────────────────────────────────────────────────────
    // DV (especially Profile 5: single-layer, no HDR10-compatible base) cannot
    // be stream-copied into a plain HLS that AVPlayer decodes — it fails with
    // CoreMediaErrorDomain -4 — and a naive re-encode that ignores the RPU
    // produces grossly wrong colors. Route it to the libplacebo path, which
    // APPLIES the RPU before tone-mapping to SDR. Capped at DEFAULT_TARGET_HEIGHT
    // because that encode runs on the CPU (libx264) — libplacebo is a Vulkan
    // filter that can't hand frames straight to the iGPU's VAAPI encoder.
    //
    // EXCEPTION — DV passthrough (TRANSCODER_DV_PASSTHROUGH, default off): a
    // client that advertised `dolby_vision` (RPU-applying pipeline) AND
    // fMP4-HEVC delivery gets the stream copied with DV metadata intact,
    // provided the profile is a known single-layer one (5/8 — P7's
    // enhancement layer cannot ride HLS) and no down-scale is needed.
    if is_dolby_vision(file.hdr_format.as_deref()) {
        let codec_lc = file
            .video_codec
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase();
        let needs_scale =
            matches!((caps.max_height, file.video_height), (Some(max), Some(h)) if h > max);
        let dv_profile = dolby_vision_profile(file.hdr_format.as_deref());
        if dv_passthrough
            && caps.dolby_vision
            && caps.hls_fmp4_hevc
            && matches!(codec_lc.as_str(), "hevc" | "h265")
            && matches!(dv_profile, Some(5 | 8))
            && !needs_scale
        {
            let dv_profile = dv_profile.expect("matched Some above");
            return TranscodePlan::Transcode {
                video: VideoOp::CopyDolbyVision { dv_profile },
                audio: plan_audio(file, caps),
                subtitle,
                segment_format: SegmentFormat::Fmp4,
                audio_index: preferred_audio_index(file),
                extra_audio: plan_extra_audio(file, caps),
                reason: format!("{reason} (dolby vision P{dv_profile} passthrough)"),
            };
        }
        let scale_to_height = match file.video_height {
            Some(h) if h > DEFAULT_TARGET_HEIGHT => Some(DEFAULT_TARGET_HEIGHT),
            _ => None,
        };
        return TranscodePlan::Transcode {
            video: VideoOp::EncodeDolbyVision {
                scale_to_height,
                source_height: file.video_height,
            },
            audio: plan_audio(file, caps),
            subtitle,
            segment_format: SegmentFormat::MpegTs,
            audio_index: preferred_audio_index(file),
            extra_audio: plan_extra_audio(file, caps),
            reason: format!("{reason} (dolby vision: libplacebo RPU re-encode)"),
        };
    }

    // ── Video ──────────────────────────────────────────────────────────────
    let video_codec = file.video_codec.as_deref().map(str::trim).unwrap_or("");
    let codec_ok = !video_codec.is_empty() && contains_ci(&caps.video_codecs, video_codec);
    // Profile gate: an accepted codec STRING can still hide an undecodable
    // stream (Hi10P is "h264"); see video_profile_copy_safe.
    let profile_ok = video_profile_copy_safe(video_codec, file.video_profile.as_deref());
    // Delivery gate: a copied stream must be playable inside the HLS segments
    // we actually emit. H.264 rides MPEG-TS (hls.js's transmuxer demuxes only
    // H.264 from TS). HEVC is playable ONLY as fMP4 segments, so it copies
    // exclusively when the client advertised `hls_fmp4_hevc` (probed hardware
    // decode + an fMP4-capable player). Everything else (vp9/av1/…) has no
    // deliverable HLS container in the shipped player stack — re-encode.
    // Fixes the latent failure where an hevc-advertising client got an HEVC
    // elementary stream copied into .ts segments: hls.js rejects the append
    // and the player sits grey at 0:00 with a "healthy" session.
    let codec_lc = video_codec.trim().to_ascii_lowercase();
    let is_hevc = matches!(codec_lc.as_str(), "hevc" | "h265");
    let hls_copy_deliverable = match codec_lc.as_str() {
        "h264" | "avc" | "avc1" => true,
        "hevc" | "h265" => caps.hls_fmp4_hevc,
        _ => false,
    };

    let needs_scale =
        matches!((caps.max_height, file.video_height), (Some(max), Some(h)) if h > max);
    let scale_to_height = if needs_scale {
        // Down-scale to the client's max, but never above our H.264 target.
        Some(
            caps.max_height
                .unwrap_or(DEFAULT_TARGET_HEIGHT)
                .min(DEFAULT_TARGET_HEIGHT),
        )
    } else {
        None
    };

    let is_hdr = file
        .hdr_format
        .as_deref()
        .map(str::trim)
        .is_some_and(|h| !h.is_empty());
    let tone_map = is_hdr && !caps.hdr;

    // Copy the video only when the codec is accepted, the PROFILE is a
    // known-decodable one for that codec, the copy is DELIVERABLE in an HLS
    // segment container the player demuxes, no scale is needed, no tone-map
    // is needed, and there is no burn-in to composite. Otherwise re-encode to
    // H.264 — the smallest re-encode that satisfies the client.
    let video = if codec_ok
        && profile_ok
        && hls_copy_deliverable
        && !needs_scale
        && !tone_map
        && burn_index.is_none()
    {
        VideoOp::Copy
    } else {
        VideoOp::EncodeH264 {
            scale_to_height,
            tone_map,
            burn_subtitle_index: burn_index,
            source_height: file.video_height,
        }
    };

    // An HEVC copy is only legal in fMP4 segments; every other plan (H.264
    // copy or any re-encode) stays on MPEG-TS, the smallest-blast-radius
    // default the whole serving path is proven on.
    let segment_format = if is_hevc && video == VideoOp::Copy {
        SegmentFormat::Fmp4
    } else {
        SegmentFormat::MpegTs
    };

    // ── Audio ────────────────────────────────────────────────────────────
    let audio = plan_audio(file, caps);

    TranscodePlan::Transcode {
        video,
        audio,
        subtitle,
        segment_format,
        audio_index: preferred_audio_index(file),
        extra_audio: plan_extra_audio(file, caps),
        reason,
    }
}

/// True for a BCP-47 / ISO-639 English audio language tag ("en", "eng",
/// "en-US", or the bare word "english"). Tag-only, like the client's
/// `AudioPreference.isEnglish`, so "bn"/"Bengali" never reads as English.
fn is_english_lang(tag: &str) -> bool {
    let t = tag.trim().to_ascii_lowercase();
    t == "en" || t == "eng" || t == "english" || t.starts_with("en-") || t.starts_with("en_")
}

/// Audio-relative index (`-map 0:a:<n>`) of the track to play: the first
/// English-tagged audio track, else 0 (the file's first audio). Some releases
/// flag a foreign track DEFAULT (e.g. Italian on "Hoppers"), so `0:a:0` blindly
/// played the wrong language; this forces English — the same default-to-English
/// correction Plex/Jellyfin apply, and the client's `AudioPreference` mirrors.
pub fn preferred_audio_index(file: &MediaFileRow) -> usize {
    file.audio_tracks()
        .iter()
        .position(|t| t.language.as_deref().map(is_english_lang).unwrap_or(false))
        .unwrap_or(0)
}

/// Audio op: copy only when the chosen track (see [`preferred_audio_index`]) is
/// a codec the CLIENT advertised AND (for AAC) within the client's appendable
/// channel count; otherwise re-encode to AAC (the args builder downmixes to
/// stereo). Gating on the SAME track the `-map` selects keeps the copy/encode
/// decision consistent with the audio that's actually delivered.
fn plan_audio(file: &MediaFileRow, caps: &ClientCaps) -> AudioOp {
    // The accepted set is the client's advertised `audio_codecs` (default
    // ["aac"], the only codec every browser MSE path decodes — Chrome and
    // Firefox reject AC-3/E-AC-3 appends, so passthrough of those is opt-in
    // for clients that probed real system decode, e.g. Safari/Edge).
    //
    // AAC copy requires a second, independent gate: the channel count must be
    // within `caps.aac_max_channels` (default 2). Chrome/Firefox MSE REJECT
    // the SourceBuffer append of a >2-channel AAC track ("audio SourceBuffer
    // error. MediaSource readyState: ended"), failing the whole fragment and
    // freezing the player grey at 0:00 — even though the codec STRING
    // (mp4a.40.2) reports as supported. A client whose decodingInfo probe
    // proved a 6-channel AAC append raises the cap and keeps its surround
    // track. When channel count is unknown we re-encode: a wrongly-copied 5.1
    // track is a silent total playback failure, whereas a needless stereo
    // re-encode merely costs a little CPU. A multichannel source downmixed to
    // stereo gets the higher DOWNMIX bitrate so the fold-down isn't smeared.
    let tracks = file.audio_tracks();
    // The track the `-map` will select (English-preferred), not blindly the first.
    let Some(track) = tracks
        .get(preferred_audio_index(file))
        .or_else(|| tracks.first())
    else {
        // No audio at all: nothing to encode; ffmpeg_args guards on -map, so a
        // copy op is a harmless no-op.
        return AudioOp::Copy;
    };
    audio_op_for(track, caps)
}

/// Copy-vs-re-encode decision for ONE audio track: copy when its codec is a set
/// the client advertised AND (for AAC) within the appendable channel count;
/// otherwise re-encode to stereo AAC. Extracted so every muxed track (primary
/// and each `extra_audio` rendition) is gated identically.
fn audio_op_for(track: &AudioTrack, caps: &ClientCaps) -> AudioOp {
    let codec = track
        .codec
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let codec_accepted = caps
        .audio_codecs
        .iter()
        .any(|c| c.eq_ignore_ascii_case(&codec));
    let channels_safe = if codec == "aac" {
        track
            .channels
            .is_some_and(|c| c <= caps.aac_max_channels.max(2))
    } else {
        // Non-AAC codecs only reach copy when the client explicitly probed
        // them; those are native system decoders, not MSE transmux paths, so
        // the AAC append hazard does not apply.
        true
    };
    if codec_accepted && channels_safe {
        AudioOp::Copy
    } else {
        let is_downmix = track.channels.is_none_or(|c| c > 2);
        AudioOp::EncodeAac {
            bitrate_kbps: if is_downmix {
                DOWNMIX_AAC_BITRATE_KBPS
            } else {
                DEFAULT_AAC_BITRATE_KBPS
            },
        }
    }
}

/// The ADDITIONAL audio tracks to mux after the primary (English-preferred) one,
/// as `(audio-relative index, per-track op)` in menu order. Empty unless the
/// client is a `native_hls` player (AVPlayer exposes in-band alt-audio) AND the
/// file actually has a second track — so browser/MSE and single-track titles are
/// unchanged. The primary index is skipped (it's mapped first, as the default).
pub fn plan_extra_audio(file: &MediaFileRow, caps: &ClientCaps) -> Vec<(usize, AudioOp)> {
    if !caps.native_hls {
        return Vec::new();
    }
    let tracks = file.audio_tracks();
    if tracks.len() < 2 {
        return Vec::new();
    }
    let primary = preferred_audio_index(file);
    tracks
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != primary)
        .map(|(i, t)| (i, audio_op_for(t, caps)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use media_core::models::{AudioTrack, SubtitleTrack};

    fn caps_h264_1080_sdr() -> ClientCaps {
        ClientCaps {
            containers: vec!["mp4".into()],
            video_codecs: vec!["h264".into()],
            max_height: Some(1080),
            ..ClientCaps::default()
        }
    }

    fn file(
        container: Option<&str>,
        video_codec: Option<&str>,
        video_height: Option<i64>,
        hdr_format: Option<&str>,
        audio: Vec<AudioTrack>,
        subs: Vec<SubtitleTrack>,
    ) -> MediaFileRow {
        MediaFileRow {
            id: 1,
            path: "/library/movie.mkv".into(),
            size_bytes: 1_000_000,
            mtime: "0".into(),
            container: container.map(str::to_string),
            duration_secs: Some(7200),
            video_codec: video_codec.map(str::to_string),
            video_height,
            video_profile: Some("main".into()),
            hdr_format: hdr_format.map(str::to_string),
            audio_tracks_json: serde_json::to_string(&audio).unwrap(),
            subtitle_tracks_json: serde_json::to_string(&subs).unwrap(),
            scanned_at: "0".into(),
        }
    }

    /// An audio track with an explicit language tag (for audio-selection tests).
    fn audio_lang(index: i64, lang: Option<&str>) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("aac".into()),
            channels: Some(2),
            language: lang.map(str::to_string),
            title: None,
        }
    }

    #[test]
    fn preferred_audio_index_lands_on_english_over_a_defaulted_foreign_track() {
        // "Hoppers": track 0 is Italian (flagged DEFAULT upstream), track 1 is
        // English. Mapping 0:a:0 blindly played Italian; we must select English
        // (audio-relative index 1), matching Plex/Jellyfin.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![audio_lang(0, Some("ita")), audio_lang(1, Some("eng"))],
            vec![],
        );
        assert_eq!(preferred_audio_index(&f), 1);
    }

    #[test]
    fn preferred_audio_index_matches_regional_and_named_english_but_not_bengali() {
        let regional = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![audio_lang(0, Some("fra")), audio_lang(1, Some("en-US"))],
            vec![],
        );
        assert_eq!(preferred_audio_index(&regional), 1);
        // No English → leave the file's first track. "bn" must not read as English.
        let none = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![audio_lang(0, Some("ita")), audio_lang(1, Some("bn"))],
            vec![],
        );
        assert_eq!(preferred_audio_index(&none), 0);
    }

    #[test]
    fn native_client_muxes_all_audio_english_first() {
        // native_hls: primary = English (idx 1); extras = the others in order.
        let mut caps = caps_h264_1080_sdr();
        caps.native_hls = true;
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![
                audio_lang(0, Some("ita")),
                audio_lang(1, Some("eng")),
                audio_lang(2, Some("fra")),
            ],
            vec![],
        );
        match plan_transcode(&f, &caps) {
            TranscodePlan::Transcode {
                audio_index,
                extra_audio,
                ..
            } => {
                assert_eq!(audio_index, 1, "English is the default/primary");
                assert_eq!(
                    extra_audio.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
                    vec![0, 2],
                    "the other tracks are muxed in, primary excluded"
                );
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn browser_client_stays_single_english_track() {
        // Default caps (native_hls false): no extra tracks — the web path is
        // unchanged, so a capable browser can't regress to the foreign default.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![audio_lang(0, Some("ita")), audio_lang(1, Some("eng"))],
            vec![],
        );
        match plan_transcode(&f, &caps_h264_1080_sdr()) {
            TranscodePlan::Transcode {
                audio_index,
                extra_audio,
                ..
            } => {
                assert_eq!(audio_index, 1);
                assert!(extra_audio.is_empty(), "browser gets English only");
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn transcode_plan_maps_the_english_audio_track() {
        // The plan carries the English index and the ffmpeg args map 0:a:1.
        let f = file(
            Some("mkv"),
            Some("av1"),
            Some(1080),
            None,
            vec![audio_lang(0, Some("ita")), audio_lang(1, Some("eng"))],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match &plan {
            TranscodePlan::Transcode { audio_index, .. } => assert_eq!(*audio_index, 1),
            other => panic!("expected transcode, got {other:?}"),
        }
        let args =
            crate::args::ffmpeg_args(&plan, "/in.mkv", "/tmp/s", 0, crate::args::HwEncoder::Cpu)
                .join(" ");
        assert!(
            args.contains("-map 0:a:1?"),
            "english track not mapped; args: {args}"
        );
    }

    /// Stereo AAC — the browser-safe, copyable baseline.
    fn aac(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("aac".into()),
            channels: Some(2),
            language: Some("eng".into()),
            title: None,
        }
    }
    /// Multichannel (5.1) AAC — accepted codec but must be downmixed, not copied.
    fn aac_51(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("aac".into()),
            channels: Some(6),
            language: Some("eng".into()),
            title: None,
        }
    }
    /// AAC with unknown channel count — re-encode conservatively.
    fn aac_unknown_channels(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("aac".into()),
            channels: None,
            language: Some("eng".into()),
            title: None,
        }
    }
    fn eac3(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("eac3".into()),
            channels: Some(6),
            language: Some("eng".into()),
            title: None,
        }
    }
    fn dts(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("dts".into()),
            channels: Some(8),
            language: Some("eng".into()),
            title: None,
        }
    }
    fn sub(index: i64, codec: &str, forced: bool) -> SubtitleTrack {
        SubtitleTrack {
            index,
            codec: Some(codec.into()),
            language: Some("eng".into()),
            title: None,
            forced,
        }
    }

    #[test]
    fn reencodes_video_only_for_encode_plans() {
        let direct = TranscodePlan::DirectPlay { reason: "x".into() };
        assert!(!direct.reencodes_video());
        let remux = TranscodePlan::Transcode {
            video: VideoOp::Copy,
            audio: AudioOp::EncodeAac { bitrate_kbps: 192 },
            subtitle: SubtitleOp::None,
            segment_format: SegmentFormat::MpegTs,
            audio_index: 0,
            extra_audio: Vec::new(),
            reason: "container".into(),
        };
        assert!(
            !remux.reencodes_video(),
            "copy-remux must not count as a video re-encode"
        );
        let encode = TranscodePlan::Transcode {
            video: VideoOp::EncodeH264 {
                scale_to_height: None,
                tone_map: false,
                burn_subtitle_index: None,
                source_height: Some(1080),
            },
            audio: AudioOp::Copy,
            subtitle: SubtitleOp::None,
            segment_format: SegmentFormat::MpegTs,
            audio_index: 0,
            extra_audio: Vec::new(),
            reason: "hevc".into(),
        };
        assert!(encode.reencodes_video());
    }

    #[test]
    fn h264_aac_mp4_1080p_sdr_is_direct_play() {
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        assert!(plan.is_direct_play(), "got {plan:?}");
    }

    fn caps_apple_hevc_hdr() -> ClientCaps {
        ClientCaps {
            containers: vec!["mp4".into()],
            video_codecs: vec!["h264".into(), "hevc".into()],
            max_height: Some(2160),
            hdr: true,
            hls_fmp4_hevc: true,
            ..ClientCaps::default()
        }
    }

    #[test]
    fn is_dolby_vision_matches_label() {
        assert!(is_dolby_vision(Some("Dolby Vision")));
        assert!(is_dolby_vision(Some("dolby vision")));
        assert!(is_dolby_vision(Some("DOVI")));
        assert!(!is_dolby_vision(Some("HDR10")));
        assert!(!is_dolby_vision(Some("")));
        assert!(!is_dolby_vision(None));
    }

    #[test]
    fn dolby_vision_reencodes_via_libplacebo_even_for_hdr_client() {
        // A DV source must NOT be stream-copied even when the client advertises
        // HEVC+HDR+fMP4 (which otherwise copies): copied DV P5 fails AVPlayer
        // (-4). It routes to the libplacebo RPU re-encode (EncodeDolbyVision).
        let f = file(
            Some("matroska"),
            Some("hevc"),
            Some(1080),
            Some("Dolby Vision"),
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode_ops(&f, &caps_apple_hevc_hdr(), "test".into());
        match &plan {
            TranscodePlan::Transcode {
                video,
                segment_format,
                ..
            } => {
                assert!(
                    matches!(video, VideoOp::EncodeDolbyVision { .. }),
                    "DV must use the libplacebo encode path, got {video:?}"
                );
                assert_eq!(*segment_format, SegmentFormat::MpegTs);
            }
            other => panic!("expected Transcode, got {other:?}"),
        }
        // Re-encode → forced keyframes → uniform segments → CPU-charged AND the
        // native VOD manifest may be synthesized.
        assert!(plan.reencodes_video());
    }

    #[test]
    fn dolby_vision_4k_capped_to_target_height() {
        let f = file(
            Some("matroska"),
            Some("hevc"),
            Some(2160),
            Some("Dolby Vision"),
            vec![aac(1)],
            vec![],
        );
        match plan_transcode_ops(&f, &caps_apple_hevc_hdr(), "t".into()) {
            TranscodePlan::Transcode {
                video:
                    VideoOp::EncodeDolbyVision {
                        scale_to_height,
                        source_height,
                    },
                ..
            } => {
                assert_eq!(scale_to_height, Some(DEFAULT_TARGET_HEIGHT));
                assert_eq!(source_height, Some(2160));
            }
            other => panic!("expected EncodeDolbyVision, got {other:?}"),
        }
    }

    #[test]
    fn dolby_vision_profile_parses_label() {
        assert_eq!(dolby_vision_profile(Some("Dolby Vision P5")), Some(5));
        assert_eq!(dolby_vision_profile(Some("dolby vision p8")), Some(8));
        assert_eq!(dolby_vision_profile(Some("Dolby Vision")), None);
        assert_eq!(dolby_vision_profile(Some("HDR10")), None);
        assert_eq!(dolby_vision_profile(None), None);
    }

    fn caps_dv() -> ClientCaps {
        ClientCaps {
            dolby_vision: true,
            ..caps_apple_hevc_hdr()
        }
    }

    #[test]
    fn dv_passthrough_copies_for_dv_capable_client() {
        // Flag on + dolby_vision cap + fMP4 HEVC + known single-layer profile
        // + no scale → the stream copies with DV intact, in fMP4, uncharged
        // against the CPU-transcode cap.
        let f = file(
            Some("matroska"),
            Some("hevc"),
            Some(2160),
            Some("Dolby Vision P5"),
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode_ops_with(&f, &caps_dv(), "t".into(), true);
        match &plan {
            TranscodePlan::Transcode {
                video,
                segment_format,
                reason,
                ..
            } => {
                assert_eq!(*video, VideoOp::CopyDolbyVision { dv_profile: 5 });
                assert_eq!(*segment_format, SegmentFormat::Fmp4);
                assert!(reason.contains("passthrough"), "reason: {reason}");
            }
            other => panic!("expected Transcode, got {other:?}"),
        }
        assert!(!plan.reencodes_video());
    }

    #[test]
    fn dv_passthrough_gates_fail_closed_to_rpu_reencode() {
        let dv_file = |label: &str, height: i64| {
            file(
                Some("matroska"),
                Some("hevc"),
                Some(height),
                Some(label),
                vec![aac(1)],
                vec![],
            )
        };
        let is_rpu_reencode = |plan: &TranscodePlan| {
            matches!(
                plan,
                TranscodePlan::Transcode {
                    video: VideoOp::EncodeDolbyVision { .. },
                    ..
                }
            )
        };

        // Flag off (the shipped default) — even a fully capable client re-encodes.
        let p = plan_transcode_ops_with(
            &dv_file("Dolby Vision P5", 2160),
            &caps_dv(),
            "t".into(),
            false,
        );
        assert!(is_rpu_reencode(&p), "flag off must re-encode");

        // Client lacks the dolby_vision cap.
        let p = plan_transcode_ops_with(
            &dv_file("Dolby Vision P5", 2160),
            &caps_apple_hevc_hdr(),
            "t".into(),
            true,
        );
        assert!(is_rpu_reencode(&p), "no dv cap must re-encode");

        // Unknown profile (bare label — pre-profile scans, in-band-RPU backfill).
        let p =
            plan_transcode_ops_with(&dv_file("Dolby Vision", 2160), &caps_dv(), "t".into(), true);
        assert!(is_rpu_reencode(&p), "unknown profile must re-encode");

        // P7 dual-layer can never ride HLS.
        let p = plan_transcode_ops_with(
            &dv_file("Dolby Vision P7", 2160),
            &caps_dv(),
            "t".into(),
            true,
        );
        assert!(is_rpu_reencode(&p), "P7 must re-encode");

        // Down-scale needed (client max below source) — copy can't scale.
        let mut caps = caps_dv();
        caps.max_height = Some(1080);
        let p = plan_transcode_ops_with(&dv_file("Dolby Vision P5", 2160), &caps, "t".into(), true);
        assert!(is_rpu_reencode(&p), "scale must re-encode");

        // No fMP4-HEVC delivery path.
        let mut caps = caps_dv();
        caps.hls_fmp4_hevc = false;
        let p = plan_transcode_ops_with(&dv_file("Dolby Vision P5", 2160), &caps, "t".into(), true);
        assert!(is_rpu_reencode(&p), "no fmp4 must re-encode");
    }

    #[test]
    fn hevc_forces_h264_reencode_audio_copy() {
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode {
                video,
                audio,
                subtitle,
                ..
            } => {
                assert_eq!(
                    video,
                    VideoOp::EncodeH264 {
                        scale_to_height: None,
                        tone_map: false,
                        burn_subtitle_index: None,
                        source_height: Some(1080),
                    }
                );
                assert_eq!(audio, AudioOp::Copy, "aac is accepted, must copy");
                assert_eq!(subtitle, SubtitleOp::None);
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn four_k_h264_scales_to_1080p() {
        // 4K h264 to a 1080p-max client: codec is fine, but height forces a
        // scaling re-encode.
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(2160),
            None,
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { video, .. } => assert_eq!(
                video,
                VideoOp::EncodeH264 {
                    scale_to_height: Some(1080),
                    tone_map: false,
                    burn_subtitle_index: None,
                    source_height: Some(2160),
                }
            ),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn unscaled_4k_reencode_carries_source_height() {
        // 4K HEVC to a client with NO height cap: the codec forces a re-encode
        // but nothing scales, so the OUTPUT stays 2160p. The plan must carry
        // the source height for the bitrate ladder — keyed on scale_to_height
        // alone the >1080p arm was unreachable and 4K got the 1080p rate.
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(2160),
            None,
            vec![aac(1)],
            vec![],
        );
        let caps = ClientCaps {
            max_height: None,
            ..caps_h264_1080_sdr()
        };
        let plan = plan_transcode(&f, &caps);
        match plan {
            TranscodePlan::Transcode { video, .. } => assert_eq!(
                video,
                VideoOp::EncodeH264 {
                    scale_to_height: None,
                    tone_map: false,
                    burn_subtitle_index: None,
                    source_height: Some(2160),
                }
            ),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn hdr_to_sdr_client_sets_tone_map() {
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            Some("HDR10"),
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { video, .. } => assert_eq!(
                video,
                VideoOp::EncodeH264 {
                    scale_to_height: None,
                    tone_map: true,
                    burn_subtitle_index: None,
                    source_height: Some(1080),
                }
            ),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn non_aac_audio_transcodes_to_aac() {
        // DTS is not browser-decodable → must re-encode to AAC. (Codec mismatch
        // on video forces the transcode gate regardless.)
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(1080),
            None,
            vec![dts(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { audio, .. } => {
                // 8-channel DTS folds down to stereo → the downmix bitrate.
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 256 });
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn eac3_audio_is_reencoded_to_aac_for_browsers() {
        // E-AC-3 (Dolby Digital Plus) is NOT decodable by Chrome/Firefox MSE, so
        // it must be re-encoded to AAC rather than copied — copying it played
        // video with dead audio (or a grey 0:00). Regression for the American
        // Dad! S01E07 (EAC3 5.1) grey-screen report.
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(1080),
            None,
            vec![eac3(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { audio, .. } => {
                // 5.1 E-AC-3 → stereo AAC downmix at the higher bitrate.
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 256 })
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn multichannel_aac_is_downmixed_not_copied() {
        // AAC is an accepted codec, but 5.1 (6ch) must be RE-ENCODED so the args
        // builder downmixes it to stereo. Copying it hands hls.js a multichannel
        // AAC that Chrome/Firefox MSE refuses to append → grey 0:00. Regression
        // for American Dad! S02E03 (10-bit HEVC + EAC3→AAC 5.1). Use mkv (wrong
        // container) so video just remuxes (Copy) and the audio op is isolated.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac_51(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { video, audio, .. } => {
                assert_eq!(
                    video,
                    VideoOp::Copy,
                    "container-only mismatch remuxes video"
                );
                assert_eq!(
                    audio,
                    AudioOp::EncodeAac { bitrate_kbps: 256 },
                    "5.1 AAC must re-encode (downmix at 256k), not copy"
                );
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn unknown_channel_aac_is_reencoded() {
        // Channel count unknown → re-encode (conservative). A wrongly-copied 5.1
        // track is a silent total failure; a needless stereo re-encode is cheap.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac_unknown_channels(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { audio, .. } => {
                // Unknown channel count → conservative downmix path (256k).
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 256 });
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn multichannel_aac_mp4_still_direct_plays() {
        // Scope boundary: the channel gate is a TRANSCODE-path concern only.
        // Direct-play serves the original file to the native <video> element,
        // which decodes 5.1 fine — so an h264 + AAC 5.1 + mp4 file (everything
        // else accepted) still direct-plays. decide() does not gate on channels.
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac_51(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        assert!(
            plan.is_direct_play(),
            "5.1 AAC mp4 must still direct-play: {plan:?}"
        );
    }

    #[test]
    fn text_subtitle_not_inline_extracted_on_live_stream() {
        // Inline WebVTT extraction is disabled: under -re it delays the first
        // video segment ~9s (grey 0:00) AND was orphaned (no master playlist),
        // so a text sub yields SubtitleOp::None. The video op is still driven by
        // the codec mismatch (hevc). Subs will return via a sidecar (see
        // plan_subtitle TODO). Regression for American Dad! S01E07.
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(2, "ass", false)],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode {
                video, subtitle, ..
            } => {
                assert_eq!(
                    subtitle,
                    SubtitleOp::None,
                    "text sub must not inline-extract"
                );
                assert_eq!(
                    video,
                    VideoOp::EncodeH264 {
                        scale_to_height: None,
                        tone_map: false,
                        burn_subtitle_index: None,
                        source_height: Some(1080),
                    }
                );
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn pgs_subtitle_is_dropped_not_burned() {
        // PGS is image-based. The libass `subtitles` filter cannot render bitmap
        // subs (it crashes the ffmpeg session), so the planner DROPS them rather
        // than emitting a burn-in. Because the burn no longer forces a re-encode,
        // an otherwise-copyable h264 stream now just remuxes (video Copy) — the
        // container change to HLS is what the transcode is for.
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(3, "hdmv_pgs_subtitle", false)],
        );
        // Force the transcode gate via an unsupported container so decide()
        // denies; otherwise an all-accepted file direct-plays and the subtitle
        // disposition is moot. Use mkv the client doesn't list.
        let mut f = f;
        f.container = Some("mkv".into());
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode {
                video, subtitle, ..
            } => {
                assert_eq!(subtitle, SubtitleOp::None);
                assert_eq!(video, VideoOp::Copy);
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn text_subtitles_yield_none_regardless_of_forced_flag() {
        // With inline extraction disabled, neither a forced nor a plain text
        // track is selected onto the live stream — both yield None (sidecar TODO).
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(2, "subrip", false), sub(3, "subrip", true)],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { subtitle, .. } => {
                assert_eq!(subtitle, SubtitleOp::None);
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn sidecar_subtitle_prefers_forced_text_track() {
        // A forced text track wins over an earlier non-forced one — it carries
        // the foreign-dialogue lines the viewer almost always wants shown.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(2, "subrip", false), sub(3, "ass", true)],
        );
        let pick = plan_sidecar_subtitle(&f).expect("a text track must be chosen");
        assert_eq!(pick.source_index, 3, "forced track wins");
        assert!(pick.forced);
        assert_eq!(pick.language.as_deref(), Some("eng"));
    }

    #[test]
    fn sidecar_subtitle_falls_back_to_first_text_track() {
        // No forced track → the first text track in probe order is extracted.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(4, "mov_text", false), sub(5, "subrip", false)],
        );
        let pick = plan_sidecar_subtitle(&f).expect("a text track must be chosen");
        assert_eq!(
            pick.source_index, 4,
            "first text track wins absent a forced one"
        );
        assert!(!pick.forced);
    }

    #[test]
    fn sidecar_subtitle_skips_image_only_tracks() {
        // WebVTT is text-only: a file whose ONLY subtitle is bitmap (PGS) has no
        // sidecar candidate (it would need burn-in, which is dropped).
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(2, "hdmv_pgs_subtitle", false)],
        );
        assert_eq!(plan_sidecar_subtitle(&f), None);
    }

    #[test]
    fn sidecar_subtitle_none_when_no_subtitles() {
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        assert_eq!(plan_sidecar_subtitle(&f), None);
    }

    #[test]
    fn sidecar_subtitle_picks_text_over_image_when_both_present() {
        // A bitmap track present alongside a text track must not shadow it: the
        // text track is the sidecar candidate, image tracks are simply ignored.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![sub(2, "hdmv_pgs_subtitle", false), sub(3, "subrip", false)],
        );
        let pick = plan_sidecar_subtitle(&f).expect("the text track must be chosen");
        assert_eq!(pick.source_index, 3);
    }

    #[test]
    fn hi10p_h264_is_reencoded_not_copied() {
        // Failure class: 10-bit H.264 ("High 10" / Hi10P) is still codec
        // string "h264", so a codec-only copy gate video-copied it to browsers
        // that can only decode 8-bit profiles → grey box with a "healthy"
        // session. The profile gate must force a re-encode. (mkv container so
        // decide() denies and the planner — not direct-play — is exercised.)
        let mut f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        f.video_profile = Some("High 10".into());
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { video, .. } => assert_eq!(
                video,
                VideoOp::EncodeH264 {
                    scale_to_height: None,
                    tone_map: false,
                    burn_subtitle_index: None,
                    source_height: Some(1080),
                },
                "Hi10P must re-encode, never copy"
            ),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn non_browser_h264_profiles_all_reencode() {
        // Every non-8-bit-4:2:0 h264 profile ffprobe can report must fall to
        // the re-encode branch — the allowlist, not a '10'-substring check, is
        // the gate (High 4:2:2 / High 4:4:4 contain no "10" but are equally
        // undecodable in browsers).
        for profile in [
            "High 10",
            "High 10 Intra",
            "High 4:2:2",
            "High 4:4:4 Predictive",
        ] {
            let mut f = file(
                Some("mkv"),
                Some("h264"),
                Some(1080),
                None,
                vec![aac(1)],
                vec![],
            );
            f.video_profile = Some(profile.into());
            let plan = plan_transcode(&f, &caps_h264_1080_sdr());
            match plan {
                TranscodePlan::Transcode { video, .. } => assert!(
                    matches!(video, VideoOp::EncodeH264 { .. }),
                    "profile {profile:?} must re-encode, got {video:?}"
                ),
                other => panic!("expected transcode, got {other:?}"),
            }
        }
    }

    #[test]
    fn browser_safe_h264_profiles_still_copy() {
        // The conservative gate must NOT regress the common case: the 8-bit
        // 4:2:0 profiles keep the copy-remux fast path.
        for profile in ["Baseline", "Constrained Baseline", "Main", "High"] {
            let mut f = file(
                Some("mkv"),
                Some("h264"),
                Some(1080),
                None,
                vec![aac(1)],
                vec![],
            );
            f.video_profile = Some(profile.into());
            let plan = plan_transcode(&f, &caps_h264_1080_sdr());
            match plan {
                TranscodePlan::Transcode { video, .. } => assert_eq!(
                    video,
                    VideoOp::Copy,
                    "browser-safe profile {profile:?} must copy"
                ),
                other => panic!("expected transcode, got {other:?}"),
            }
        }
    }

    #[test]
    fn hevc_never_copies_without_fmp4_capability() {
        // THE latent grey-box bug: an hevc-advertising client without the
        // `hls_fmp4_hevc` bit must get a RE-ENCODE, never a copy — hls.js's
        // TS transmuxer demuxes only H.264, so an HEVC elementary stream in
        // .ts segments is rejected at the MSE append (grey 0:00 with a
        // "healthy" session). Both Main and Main 10 must re-encode.
        for profile in ["Main", "Main 10"] {
            let mut f = file(
                Some("mkv"),
                Some("hevc"),
                Some(1080),
                None,
                vec![aac(1)],
                vec![],
            );
            f.video_profile = Some(profile.into());
            let caps = ClientCaps {
                video_codecs: vec!["h264".into(), "hevc".into()],
                hls_fmp4_hevc: false,
                ..caps_h264_1080_sdr()
            };
            let plan = plan_transcode(&f, &caps);
            match plan {
                TranscodePlan::Transcode {
                    video,
                    segment_format,
                    ..
                } => {
                    assert!(
                        matches!(video, VideoOp::EncodeH264 { .. }),
                        "hevc {profile} without fmp4 caps must re-encode, got {video:?}"
                    );
                    assert_eq!(segment_format, SegmentFormat::MpegTs);
                }
                other => panic!("expected transcode, got {other:?}"),
            }
        }
    }

    #[test]
    fn hevc_copies_into_fmp4_for_fmp4_capable_client() {
        // The zero-loss path this work exists for: MKV + HEVC (Main or
        // Main 10) to a client that probed HEVC hardware decode and an
        // fMP4-capable player → video COPY, fMP4 segments.
        for profile in ["Main", "Main 10"] {
            let mut f = file(
                Some("mkv"),
                Some("hevc"),
                Some(1080),
                None,
                vec![aac(1)],
                vec![],
            );
            f.video_profile = Some(profile.into());
            let caps = ClientCaps {
                video_codecs: vec!["h264".into(), "hevc".into()],
                hls_fmp4_hevc: true,
                ..caps_h264_1080_sdr()
            };
            let plan = plan_transcode(&f, &caps);
            match plan {
                TranscodePlan::Transcode {
                    video,
                    segment_format,
                    ..
                } => {
                    assert_eq!(video, VideoOp::Copy, "hevc {profile} must copy");
                    assert_eq!(
                        segment_format,
                        SegmentFormat::Fmp4,
                        "hevc copy must ride fMP4 segments"
                    );
                }
                other => panic!("expected transcode, got {other:?}"),
            }
        }
    }

    #[test]
    fn hevc_reencode_keeps_mpegts_even_with_fmp4_caps() {
        // fMP4 is selected by the COPY, not by the caps bit alone: an HEVC
        // source that still needs a re-encode (tone-map for an SDR client)
        // outputs H.264 and stays on the proven MPEG-TS path.
        let mut f = file(
            Some("mkv"),
            Some("hevc"),
            Some(1080),
            Some("HDR10"),
            vec![aac(1)],
            vec![],
        );
        f.video_profile = Some("Main 10".into());
        let caps = ClientCaps {
            video_codecs: vec!["h264".into(), "hevc".into()],
            hls_fmp4_hevc: true,
            hdr: false,
            ..caps_h264_1080_sdr()
        };
        match plan_transcode(&f, &caps) {
            TranscodePlan::Transcode {
                video,
                segment_format,
                ..
            } => {
                assert!(matches!(video, VideoOp::EncodeH264 { tone_map: true, .. }));
                assert_eq!(segment_format, SegmentFormat::MpegTs);
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn vp9_never_copies_even_when_advertised() {
        // No HLS segment container in the shipped player stack demuxes VP9;
        // an advertised vp9 cap affects direct-play only — the transcode
        // path must re-encode.
        let f = file(
            Some("mkv"),
            Some("vp9"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let caps = ClientCaps {
            video_codecs: vec!["h264".into(), "vp9".into()],
            hls_fmp4_hevc: true,
            ..caps_h264_1080_sdr()
        };
        match plan_transcode(&f, &caps) {
            TranscodePlan::Transcode { video, .. } => assert!(
                matches!(video, VideoOp::EncodeH264 { .. }),
                "vp9 must re-encode on the HLS path, got {video:?}"
            ),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn aac_51_copies_when_client_raised_channel_cap() {
        // A client whose decodingInfo probe proved a 6-channel AAC append
        // (Safari/Edge/Firefox) advertises aac_max_channels: 6 and keeps the
        // surround track via copy instead of a stereo downmix.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac_51(1)],
            vec![],
        );
        let caps = ClientCaps {
            aac_max_channels: 6,
            ..caps_h264_1080_sdr()
        };
        match plan_transcode(&f, &caps) {
            TranscodePlan::Transcode { audio, .. } => {
                assert_eq!(audio, AudioOp::Copy, "5.1 AAC must copy at cap 6");
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn advertised_eac3_copies_instead_of_reencoding() {
        // Safari/Edge probe real system E-AC-3 decode and advertise it; the
        // track passes through untouched instead of a lossy AAC re-encode.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![eac3(1)],
            vec![],
        );
        let caps = ClientCaps {
            audio_codecs: vec!["aac".into(), "eac3".into()],
            ..caps_h264_1080_sdr()
        };
        match plan_transcode(&f, &caps) {
            TranscodePlan::Transcode { audio, .. } => {
                assert_eq!(audio, AudioOp::Copy, "advertised eac3 must copy");
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn unknown_h264_profile_reencodes_conservatively() {
        // Unknown profile → we cannot prove the copy is browser-safe, so
        // re-encode (mirrors the unknown-channel-count audio rule).
        for profile in [None, Some("")] {
            let mut f = file(
                Some("mkv"),
                Some("h264"),
                Some(1080),
                None,
                vec![aac(1)],
                vec![],
            );
            f.video_profile = profile.map(str::to_string);
            let plan = plan_transcode(&f, &caps_h264_1080_sdr());
            match plan {
                TranscodePlan::Transcode { video, .. } => assert!(
                    matches!(video, VideoOp::EncodeH264 { .. }),
                    "unknown profile must re-encode, got {video:?}"
                ),
                other => panic!("expected transcode, got {other:?}"),
            }
        }
    }

    #[test]
    fn container_only_mismatch_copies_both_streams() {
        // mkv h264/aac to an mp4-only client: only the container is wrong, so
        // remux (copy video + copy audio) is the smallest fix.
        let f = file(
            Some("mkv"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let plan = plan_transcode(&f, &caps_h264_1080_sdr());
        match plan {
            TranscodePlan::Transcode { video, audio, .. } => {
                assert_eq!(video, VideoOp::Copy);
                assert_eq!(audio, AudioOp::Copy);
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn forced_direct_play_eligible_resolves_to_lossless_copy_remux() {
        // The stall-escalation contract: a file decide() would direct-play
        // must, under force_transcode, become a pure container change —
        // copy/copy into MPEG-TS — never a re-encode and never DirectPlay.
        let f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let caps = caps_h264_1080_sdr();
        assert!(plan_transcode(&f, &caps).is_direct_play(), "precondition");
        match plan_transcode_forced(&f, &caps) {
            TranscodePlan::Transcode {
                video,
                audio,
                segment_format,
                reason,
                ..
            } => {
                assert_eq!(video, VideoOp::Copy);
                assert_eq!(audio, AudioOp::Copy);
                assert_eq!(segment_format, SegmentFormat::MpegTs);
                assert_eq!(reason, "forced buffered delivery");
            }
            other => panic!("expected forced copy-remux, got {other:?}"),
        }
    }

    #[test]
    fn forced_hevc_with_fmp4_caps_copies_into_fmp4() {
        let f = file(
            Some("mp4"),
            Some("hevc"),
            Some(1080),
            None,
            vec![aac(1)],
            vec![],
        );
        let caps = ClientCaps {
            video_codecs: vec!["h264".into(), "hevc".into()],
            hls_fmp4_hevc: true,
            ..caps_h264_1080_sdr()
        };
        match plan_transcode_forced(&f, &caps) {
            TranscodePlan::Transcode {
                video,
                audio,
                segment_format,
                ..
            } => {
                assert_eq!(video, VideoOp::Copy);
                assert_eq!(audio, AudioOp::Copy);
                assert_eq!(segment_format, SegmentFormat::Fmp4);
            }
            other => panic!("expected forced hevc fmp4 copy, got {other:?}"),
        }
    }

    #[test]
    fn forced_still_reencodes_when_copy_is_unsafe() {
        // Forcing buffered delivery must NOT bypass per-stream safety gates:
        // Hi10P (undecodable profile) still re-encodes video, and 5.1 AAC on
        // a 2ch client still downmixes.
        let mut f = file(
            Some("mp4"),
            Some("h264"),
            Some(1080),
            None,
            vec![aac_51(1)],
            vec![],
        );
        f.video_profile = Some("high 10".into());
        match plan_transcode_forced(&f, &caps_h264_1080_sdr()) {
            TranscodePlan::Transcode { video, audio, .. } => {
                assert!(
                    matches!(video, VideoOp::EncodeH264 { .. }),
                    "Hi10P must re-encode even when forced, got {video:?}"
                );
                assert!(
                    matches!(audio, AudioOp::EncodeAac { .. }),
                    "5.1 AAC on a 2ch client must re-encode even when forced, got {audio:?}"
                );
            }
            other => panic!("expected transcode, got {other:?}"),
        }
    }
}
