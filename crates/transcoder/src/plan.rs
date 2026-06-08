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
//! * audio — copy when the codec is accepted; otherwise transcode to AAC.
//! * subtitles — text formats (subrip/srt/webvtt/ass/ssa/mov_text) are
//!   extracted to a selectable WebVTT track. Image formats
//!   (pgs/hdmv_pgs/dvd_subtitle/vobsub) are DROPPED, not burned: the libass
//!   `subtitles` filter cannot render bitmap subtitles and aborts the ffmpeg
//!   session, so a correct burn would need an `overlay`-based filtergraph.
//!   Until that lands, a title with only image subs plays without subs rather
//!   than failing outright. See [`plan_subtitle`].
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

/// Pick the subtitle disposition for the OUTPUT. Only TEXT subtitles are
/// carried, repackaged as a single selectable WebVTT track (the right model for
/// both hls.js and AVPlayer). A forced text track wins; otherwise the first
/// text track present. Returns `(op, burn_index)`; `burn_index` is always `None`
/// now — image burn-in is not emitted (see below).
///
/// Image subtitles (PGS/VOBSUB/DVD) are intentionally DROPPED. Rendering them
/// means compositing the bitmap onto the video, but the libass `subtitles`
/// filter cannot decode image formats — it aborts the whole ffmpeg session with
/// "Only text based subtitles are currently supported". A correct burn needs an
/// `overlay`-based filtergraph fed by the decoded subtitle stream; until that
/// lands, dropping image subs lets the title play (without those subs) instead
/// of failing to play at all.
fn plan_subtitle(file: &MediaFileRow) -> (SubtitleOp, Option<i64>) {
    let tracks = file.subtitle_tracks();
    let is_text = |t: &&SubtitleTrack| is_text_subtitle(t.codec.as_deref().unwrap_or("").trim());
    let chosen = tracks
        .iter()
        .find(|t| t.forced && is_text(t))
        .or_else(|| tracks.iter().find(is_text));
    if let Some(track) = chosen {
        return (
            SubtitleOp::ExtractWebVtt {
                source_index: track.index,
            },
            None,
        );
    }
    // No usable text track. Log when we drop image-only subs so the gap is
    // observable rather than silent (and to keep is_image_subtitle in use until
    // the overlay burn path lands).
    if tracks
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

/// Audio op: copy when at least one track's codec is accepted, else AAC 192k.
fn plan_audio(file: &MediaFileRow, caps: &ClientCaps) -> AudioOp {
    // media-core's ClientCaps has no audio_codecs field yet; the contract uses
    // a conventional set carried in video_codecs is NOT correct, so we accept
    // a small built-in set of universally-direct-play audio codecs plus AAC.
    // When the file's primary audio codec is in that set, copy; else AAC.
    let tracks = file.audio_tracks();
    let primary = tracks.first();
    let Some(track) = primary else {
        // No audio at all: nothing to encode, emit AAC op is meaningless, but
        // ffmpeg_args guards on -map; treat as copy (no-op).
        return AudioOp::Copy;
    };
    let codec = track
        .codec
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if accepted_audio_codecs(caps).contains(&codec) {
        AudioOp::Copy
    } else {
        AudioOp::EncodeAac {
            bitrate_kbps: DEFAULT_AAC_BITRATE_KBPS,
        }
    }
}

/// Audio codecs we let through as direct-play. `caps.audio_codecs` does not
/// exist in the M3 contract yet, so we use the Apple-safe baseline (AAC always,
/// plus AC-3/E-AC-3 which AVPlayer can pass to an AVReceiver). Anything else
/// (DTS, TrueHD, FLAC, Opus in an unsupported container) → AAC.
///
/// TODO(M4+): when `media_core::capability::ClientCaps` grows an
/// `audio_codecs` field, key this off the client's actual advertised set
/// instead of the hardcoded baseline — a client that cannot decode E-AC-3
/// currently gets a copy it cannot play, and only the first audio track is
/// mapped (see `-map 0:a:0?` in `args::ffmpeg_args`).
fn accepted_audio_codecs(_caps: &ClientCaps) -> Vec<String> {
    vec!["aac".to_string(), "ac3".to_string(), "eac3".to_string()]
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

    fn aac(index: i64) -> AudioTrack {
        AudioTrack {
            index,
            codec: Some("aac".into()),
            channels: Some(6),
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
        assert!(!remux.reencodes_video(), "copy-remux must not count as a video re-encode");
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
    fn eac3_not_in_caps_transcodes_audio_to_aac() {
        // eac3 IS in our Apple-safe baseline, so to prove the AAC path we use
        // DTS, which is not. Codec mismatch on video forces the transcode gate.
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
    fn eac3_audio_is_copied_when_present() {
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
            TranscodePlan::Transcode { audio, .. } => assert_eq!(audio, AudioOp::Copy),
            other => panic!("expected transcode, got {other:?}"),
        }
    }

    #[test]
    fn ass_subtitle_extracts_to_webvtt_when_transcoding() {
        // ASS is a text format → WebVTT extract, NOT burn-in. The video op is
        // driven only by the codec mismatch (hevc), so no burn index.
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
                assert_eq!(subtitle, SubtitleOp::ExtractWebVtt { source_index: 2 });
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
    fn forced_subtitle_is_preferred_over_first() {
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
                assert_eq!(subtitle, SubtitleOp::ExtractWebVtt { source_index: 3 });
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
