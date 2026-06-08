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
use media_core::models::{MediaFileRow, SubtitleTrack};
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
    /// Re-encode to H.264. `scale_to_height` is `Some` when we down-scale,
    /// `tone_map` is set when collapsing HDR → SDR, and `burn_subtitle_index`
    /// carries the absolute stream index of an image subtitle to burn in.
    EncodeH264 {
        scale_to_height: Option<i64>,
        tone_map: bool,
        burn_subtitle_index: Option<i64>,
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

/// Default AAC bitrate when we have to re-encode audio (§4.3).
pub const DEFAULT_AAC_BITRATE_KBPS: u32 = 192;

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
                video: VideoOp::EncodeH264 { .. },
                ..
            }
        )
    }
}

fn contains_ci(haystack: &[String], needle: &str) -> bool {
    haystack.iter().any(|c| c.eq_ignore_ascii_case(needle))
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
/// Subtitles will return as a pre-extracted **sidecar WebVTT** (`<track>`,
/// decoupled from the live stream) — see TODO below. Until then a transcoded
/// title plays WITHOUT in-player subtitles rather than not playing at all.
///
/// Returns `(op, burn_index)`; both are `None`. Detection is still run for the
/// log trail (and to keep the text/image classifiers + the `ExtractWebVtt` op
/// live for the sidecar follow-up and the args-builder test).
///
/// Image subtitles (PGS/VOBSUB/DVD) were already dropped: the libass `subtitles`
/// filter cannot decode bitmaps and would abort the session ("Only text based
/// subtitles are currently supported"); a correct burn needs an `overlay`-based
/// filtergraph fed by the decoded subtitle stream.
///
/// TODO(M4+): pre-extract the chosen subtitle to a complete sidecar `.vtt`
/// (one-shot, no `-re`) served alongside the session and loaded by the SPA as a
/// `<track>`, restoring selectable subs without the live-stream coupling.
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

    // ── Subtitles. burn_index is always None now (image subs are dropped, not
    // burned), so subtitles no longer force a video re-encode on their own. ──
    let (subtitle, burn_index) = plan_subtitle(file);

    // ── Video ──────────────────────────────────────────────────────────────
    let video_codec = file.video_codec.as_deref().map(str::trim).unwrap_or("");
    let codec_ok = !video_codec.is_empty() && contains_ci(&caps.video_codecs, video_codec);

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

    // Copy the video only when the codec is accepted, no scale is needed, no
    // tone-map is needed, and there is no burn-in to composite. Otherwise
    // re-encode to H.264 — the smallest re-encode that satisfies the client.
    let video = if codec_ok && !needs_scale && !tone_map && burn_index.is_none() {
        VideoOp::Copy
    } else {
        VideoOp::EncodeH264 {
            scale_to_height,
            tone_map,
            burn_subtitle_index: burn_index,
        }
    };

    // ── Audio ────────────────────────────────────────────────────────────
    let audio = plan_audio(file, caps);

    TranscodePlan::Transcode {
        video,
        audio,
        subtitle,
        reason: decision.reason,
    }
}

/// Audio op: copy only when the primary track is an accepted codec AND stereo/
/// mono; otherwise re-encode to AAC (the args builder downmixes to stereo).
fn plan_audio(file: &MediaFileRow, caps: &ClientCaps) -> AudioOp {
    // media-core's ClientCaps has no audio_codecs field yet, so accepted is a
    // fixed browser-safe baseline (AAC only — see accepted_audio_codecs).
    //
    // Copy requires TWO conditions, not one:
    //   1. the codec is accepted (AAC), and
    //   2. the track is stereo or mono (≤ 2 channels).
    // A multichannel (5.1/7.1) AAC source must STILL be re-encoded. The HLS
    // output feeds hls.js, which transmuxes the TS audio to fMP4 for MSE; Chrome
    // and Firefox REJECT the SourceBuffer append of a >2-channel AAC track
    // ("audio SourceBuffer error. MediaSource readyState: ended"), which fails
    // the whole fragment and freezes the player grey at 0:00 — even though the
    // codec STRING (mp4a.40.2) reports as supported. Re-encoding forces the
    // stereo downmix (args adds `-ac 2`). When channel count is unknown we
    // re-encode: a wrongly-copied 5.1 track is a silent total playback failure,
    // whereas a needless stereo re-encode merely costs a little CPU.
    let tracks = file.audio_tracks();
    let Some(track) = tracks.first() else {
        // No audio at all: nothing to encode; ffmpeg_args guards on -map, so a
        // copy op is a harmless no-op.
        return AudioOp::Copy;
    };
    let codec = track
        .codec
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let browser_safe_channels = track.channels.is_some_and(|c| c <= 2);
    if accepted_audio_codecs(caps).contains(&codec) && browser_safe_channels {
        AudioOp::Copy
    } else {
        AudioOp::EncodeAac {
            bitrate_kbps: DEFAULT_AAC_BITRATE_KBPS,
        }
    }
}

/// Audio codecs we copy through instead of re-encoding. The shipped delivery
/// path is HLS into a browser `<video>` — hls.js/MSE on Chrome & Firefox, native
/// HLS on Safari — and **AAC is the only audio codec all three can decode**.
/// Chrome's and Firefox's MSE reject AC-3/E-AC-3, so a passthrough copy of those
/// hands the player a stream it renders with dead audio (or fails outright — a
/// grey 0:00). So only AAC copies; everything else (AC-3, E-AC-3, DTS, TrueHD,
/// FLAC, …) is re-encoded to AAC.
///
/// This is a CODEC test only. [`plan_audio`] adds a second, independent gate on
/// channel count: even an accepted AAC track is re-encoded (downmixed) when it
/// carries >2 channels, because MSE also rejects a multichannel AAC append.
///
/// `caps.audio_codecs` does not exist in the M3 `ClientCaps` contract yet, so
/// this is a fixed browser-safe baseline rather than the client's advertised set.
/// TODO(M4+): when `ClientCaps` grows an `audio_codecs` field, key off the
/// client's real set so a native Apple client (AVPlayer can pass AC-3/E-AC-3 to a
/// receiver) gets passthrough while browsers keep AAC. Note also that only the
/// first audio track is mapped (`-map 0:a:0?` in `args::ffmpeg_args`).
fn accepted_audio_codecs(_caps: &ClientCaps) -> Vec<String> {
    vec!["aac".to_string()]
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
            hdr: false,
            max_bitrate: None,
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
            },
            audio: AudioOp::Copy,
            subtitle: SubtitleOp::None,
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
                        burn_subtitle_index: None
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
                    burn_subtitle_index: None
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
                    burn_subtitle_index: None
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
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 192 });
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
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 192 })
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
                    AudioOp::EncodeAac { bitrate_kbps: 192 },
                    "5.1 AAC must re-encode (downmix), not copy"
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
                assert_eq!(audio, AudioOp::EncodeAac { bitrate_kbps: 192 });
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
                        burn_subtitle_index: None
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
}
