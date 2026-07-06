//! Native HLS trick-play (AVPlayer scrubbing thumbnails) — experimental, gated.
//!
//! `AVPlayerViewController` on tvOS/iOS renders scrubbing-preview thumbnails
//! ONLY when the HLS asset it loads is a MASTER (multivariant) playlist that
//! advertises an I-frame-only rendition via `#EXT-X-I-FRAME-STREAM-INF`, whose
//! target is an `#EXT-X-I-FRAMES-ONLY` playlist of decodable I-frames. The
//! transcoder's default output is a single MEDIA playlist (no master, no I-frame
//! rendition — see [`crate::vod_manifest`]), so there is nothing for AVPlayer to
//! scrub with; the timeline shows no thumbnails.
//!
//! This module adds, for the RE-ENCODE VOD path served to a NATIVE client and
//! ONLY when `TRANSCODER_TRICKPLAY` is enabled:
//!   * [`master`] — a MASTER playlist (served in place of the grant's
//!     `index.m3u8`) that lists the existing synthesized VOD media playlist as
//!     its one video variant plus an I-frame-only thumbnail rendition;
//!   * [`iframe_playlist`] — a hand-built `#EXT-X-I-FRAMES-ONLY` playlist
//!     (`iframe.m3u8`), one entry per thumbnail, each entry a whole `thumb_*.ts`
//!     file that is a single decodable I-frame;
//!   * [`thumb_args`] — a detached, one-shot ffmpeg pass (mirroring the
//!     sidecar-subtitle pass in [`crate::session`]) that samples the source at a
//!     fixed cadence into tiny all-keyframe `thumb_%05d.ts` segments.
//!
//! Why default OFF (see also `docs/trickplay-iframe-spec.md`):
//!   1. Producing thumbnails is a SECOND ffmpeg process per session. It decodes
//!      the source (the fps sampler still walks every frame) on a box that also
//!      runs Plex on a weak CPU — the repo's most-warned-about failure mode.
//!   2. Apple's on-device acceptance of whole-file (no-`EXT-X-BYTERANGE`)
//!      single-I-frame TS segments in an I-FRAMES-ONLY playlist can only be
//!      verified on a real Apple TV / device, which this environment lacks. The
//!      form is spec-legal (RFC 8216 §4.3.3.6: "each Media Segment in the
//!      Playlist describes a single I-frame"), but byte-range mode is what
//!      Apple's own `mediafilesegmenter` emits. If whole-file segments do not
//!      render on-device, the fallback is byte-range mode (documented in the
//!      spec) — hence: ship behind a flag, validate, then consider default-on.
//!
//! With the flag OFF the serving path is byte-for-byte what it was: the master
//! is never built and `is_native_hls_client` clients keep receiving the
//! synthesized single MEDIA playlist. COPY-remux is deliberately NOT covered —
//! a copy session runs no encoder, so a thumbnail rendition would need a fresh
//! decode+scale+encode pass regardless, i.e. exactly the CPU the copy path
//! exists to avoid.

/// Thumbnail cadence (seconds): one preview frame every this many seconds of
/// source. 10s is a coarse-but-useful scrub granularity that keeps the segment
/// count (and the sampling ffmpeg's output) small; a 2h film yields ~720 tiny
/// frames. Trick-play thumbnails are intentionally sparse — AVPlayer interpolates
/// the scrubber position between them.
pub(crate) const TRICKPLAY_INTERVAL_SECS: u32 = 10;

/// Thumbnail width (px); height is derived to preserve aspect (`scale=W:-2`).
/// 320px is Apple's rough guidance for a trick-play rendition — large enough to
/// recognize a scene, small enough that decode+encode of one frame is trivial.
pub(crate) const THUMB_WIDTH: u32 = 320;

/// Filename the MASTER playlist gives the video variant. Resolves, relative to
/// the master's own `…/session/{id}/index.m3u8` URL, to `…/session/{id}/media.m3u8`
/// — intercepted in `routes::session_segment` and served as the same synthesized
/// VOD media playlist a native client gets today.
pub(crate) const MEDIA_PLAYLIST_NAME: &str = "media.m3u8";

/// Filename the MASTER playlist gives the I-frame rendition (served by
/// `routes::session_segment`).
pub(crate) const IFRAME_PLAYLIST_NAME: &str = "iframe.m3u8";

/// Nominal bitrate (bits/s) advertised for the tiny thumbnail rendition. Purely
/// informational for the client's rendition selection; kept small and constant.
const IFRAME_BANDWIDTH_BPS: u32 = 120_000;

/// Whether trick-play is enabled. Reads `TRANSCODER_TRICKPLAY`. **Default ON**
/// (S5): the I-frame rendition has been validated on-device, so an unconfigured
/// deploy now ships scrubbing thumbnails. An explicit falsy value
/// (`0`/`false`/`no`/`off`, case-insensitive — anything non-truthy) still turns
/// it OFF, so a deploy can opt back out without a code change.
pub(crate) fn enabled() -> bool {
    enabled_from(std::env::var("TRANSCODER_TRICKPLAY").ok().as_deref())
}

/// Pure resolution of the flag with a **default-ON** policy: an unset or blank
/// value enables trick-play; a present, non-blank value is honored via
/// [`is_truthy`] (so `0`/`false`/`off`/`no` disable it). Factored out of
/// [`enabled`] so the default can be unit-tested WITHOUT mutating the
/// process-global env — the same reason [`is_truthy`] is separate (a mid-test
/// env flip would race concurrent session tests into spawning a stray thumbnail
/// ffmpeg).
fn enabled_from(v: Option<&str>) -> bool {
    match v {
        Some(s) if !s.trim().is_empty() => is_truthy(s),
        _ => true,
    }
}

/// Pure truthiness test for the flag value, factored out so it can be unit-tested
/// WITHOUT mutating the process-global env (which would race concurrent session
/// tests that call [`enabled`] and, if it flipped on mid-test, spawn a stray
/// thumbnail ffmpeg).
fn is_truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Build the MASTER (multivariant) playlist that turns a plain media stream into
/// a trick-play-capable asset: one video variant pointing at the existing
/// synthesized VOD media playlist ([`MEDIA_PLAYLIST_NAME`]) plus an
/// I-frame-only rendition ([`IFRAME_PLAYLIST_NAME`]) that AVPlayer uses for
/// scrubbing thumbnails.
///
/// * `variant_bandwidth_bps` — the video variant's advertised bitrate. Both a
///   `BANDWIDTH` on `EXT-X-STREAM-INF` and on `EXT-X-I-FRAME-STREAM-INF` are
///   REQUIRED by the spec; we derive the video one from the source's average
///   bitrate (falling back to a sane default) and use a small constant for the
///   I-frame rendition.
/// * `resolution` — `Some((w, h))` adds a `RESOLUTION` attribute (recommended
///   but optional); `None` omits it (AVPlayer plays a `RESOLUTION`-less variant
///   fine — it just can't pre-annotate the rendition).
/// * `subs` — the session's sidecar subtitle, when one is being extracted;
///   advertised as the same `subs` group the subtitle-only master
///   (`crate::subs_manifest::master`) uses, so native pickers see it here too.
pub(crate) fn master(
    variant_bandwidth_bps: u32,
    resolution: Option<(u32, u32)>,
    subs: Option<&crate::plan::SidecarSubtitle>,
) -> String {
    let mut m = String::with_capacity(256);
    m.push_str("#EXTM3U\n");
    // v4 is the floor for EXT-X-I-FRAME-STREAM-INF / EXT-X-I-FRAMES-ONLY.
    m.push_str("#EXT-X-VERSION:4\n");

    // I-frame rendition FIRST so a client that only reads the first I-frame line
    // still finds it; order is not significant to AVPlayer.
    m.push_str(&format!(
        "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH={IFRAME_BANDWIDTH_BPS},URI=\"{IFRAME_PLAYLIST_NAME}\"\n"
    ));

    let subs_attr = match subs {
        Some(s) => {
            m.push_str(&crate::subs_manifest::media_tag(s));
            ",SUBTITLES=\"subs\""
        }
        None => "",
    };

    // The one video variant → the synthesized VOD media playlist.
    match resolution {
        Some((w, h)) => m.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={variant_bandwidth_bps},RESOLUTION={w}x{h}{subs_attr}\n"
        )),
        None => m.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={variant_bandwidth_bps}{subs_attr}\n"
        )),
    }
    m.push_str(MEDIA_PLAYLIST_NAME);
    m.push('\n');
    m
}

/// Build the `#EXT-X-I-FRAMES-ONLY` playlist covering `[0, total_duration_secs)`
/// at [`TRICKPLAY_INTERVAL_SECS`] cadence: one entry per thumbnail, each a WHOLE
/// `thumb_%05d.ts` file (produced by [`thumb_args`]) that is a single decodable
/// I-frame — so no `EXT-X-BYTERANGE` is needed.
///
/// Like [`crate::vod_manifest::synthesize`], this is a PURE function of the
/// duration: the count is `ceil(total / interval)`, and it is served up front
/// while the sampling ffmpeg is still producing the tiny segments. A thumbnail
/// the sampler has not written yet simply 404s (its `#EXTINF` position shows a
/// blank preview for a moment), which AVPlayer tolerates on an I-frame rendition
/// — trick-play is a progressive enhancement, never a playback dependency. A
/// tail off-by-one between this `ceil` count and the sampler's exact frame count
/// is therefore harmless (an extra listed thumbnail 404s; an extra produced one
/// is unused).
///
/// Returns `None` for an unusable duration (non-finite / non-positive), mirroring
/// `synthesize`, so the caller can omit the trick-play rendition entirely.
pub(crate) fn iframe_playlist(total_duration_secs: f64) -> Option<String> {
    if !total_duration_secs.is_finite() || total_duration_secs <= 0.0 {
        return None;
    }
    let interval = f64::from(TRICKPLAY_INTERVAL_SECS);
    let count = (total_duration_secs / interval).ceil() as u64;
    if count == 0 {
        return None;
    }

    let mut m = String::with_capacity(96 + count as usize * 32);
    m.push_str("#EXTM3U\n");
    m.push_str("#EXT-X-VERSION:4\n");
    m.push_str(&format!(
        "#EXT-X-TARGETDURATION:{TRICKPLAY_INTERVAL_SECS}\n"
    ));
    m.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    m.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    m.push_str("#EXT-X-I-FRAMES-ONLY\n");
    for i in 0..count {
        // Each I-frame's display span is one interval, except the last, which
        // carries the remainder up to the true duration.
        let dur = if i + 1 == count {
            total_duration_secs - interval * (count - 1) as f64
        } else {
            interval
        };
        m.push_str(&format!("#EXTINF:{dur:.6},\n"));
        m.push_str(&format!("thumb_{i:05}.ts\n"));
    }
    m.push_str("#EXT-X-ENDLIST\n");
    Some(m)
}

/// ffmpeg argument vector for the detached, one-shot THUMBNAIL sampling pass.
///
/// Samples the source at `1/interval` fps into a tiny, all-keyframe H.264 stream
/// and segments it so each HLS segment holds exactly ONE frame (`thumb_%05d.ts`):
///   * `-an -sn` — video only; thumbnails carry no audio/subtitles.
///   * `-vf fps=1/interval,scale=W:-2` — one frame every `interval` seconds,
///     scaled to `width` (even height preserved).
///   * `-g 1` — every frame a keyframe (so every 1-frame segment is a clean
///     I-frame the I-FRAMES-ONLY playlist can point at whole).
///   * `-hls_time interval` + the fps above ⇒ exactly one frame per segment.
///
/// Uses `libx264` explicitly: the sampler is trivial CPU (320px, 0.1 fps) and a
/// software encode avoids per-family HW device setup; the re-encode path proves
/// SOME H.264 encoder exists but not specifically libx264, so on an HW-only
/// ffmpeg this pass fails cleanly → no thumbnails (graceful; see module docs).
///
/// Deliberately NO `-ss`: thumbnails always cover the whole title from 0 so the
/// scrubber has previews across the entire timeline regardless of resume offset.
/// This writes its OWN throwaway `thumb_index.m3u8` (ffmpeg requires an output
/// playlist path); the served I-frame playlist is [`iframe_playlist`], not this.
pub(crate) fn thumb_args(input: &str, session_dir: &str, interval: u32, width: u32) -> Vec<String> {
    vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-nostdin".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input.into(),
        "-map".into(),
        "0:v:0".into(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        format!("fps=1/{interval},scale={width}:-2"),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-g".into(),
        "1".into(),
        "-f".into(),
        "hls".into(),
        "-hls_time".into(),
        interval.to_string(),
        "-hls_list_size".into(),
        "0".into(),
        "-hls_flags".into(),
        "append_list".into(),
        "-hls_playlist_type".into(),
        "vod".into(),
        "-hls_segment_type".into(),
        "mpegts".into(),
        "-hls_segment_filename".into(),
        format!("{session_dir}/thumb_%05d.ts"),
        format!("{session_dir}/thumb_index.m3u8"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── flag truthiness (pure; no env mutation → no cross-test race) ─────────

    #[test]
    fn is_truthy_accepts_only_on_values() {
        for v in ["1", "true", "TRUE", "YES", " On ", "yes"] {
            assert!(is_truthy(v), "value {v:?} should enable");
        }
        for v in ["0", "false", "", "nope", "off", "no"] {
            assert!(!is_truthy(v), "value {v:?} should NOT enable");
        }
    }

    #[test]
    fn enabled_defaults_on_when_unset_or_blank() {
        // S5 flip: an unconfigured deploy (env absent) now ships trick-play,
        // and a blank value is treated the same as absent.
        assert!(enabled_from(None), "unset must default ON");
        assert!(enabled_from(Some("")), "blank must default ON");
        assert!(enabled_from(Some("   ")), "whitespace-only must default ON");
    }

    #[test]
    fn enabled_honors_an_explicit_value() {
        // A present, non-blank value is authoritative: truthy on, everything
        // else off — so a deploy can opt back out without a code change.
        for v in ["1", "true", "YES", " On "] {
            assert!(enabled_from(Some(v)), "explicit {v:?} should stay ON");
        }
        for v in ["0", "false", "off", "no", "nope"] {
            assert!(!enabled_from(Some(v)), "explicit {v:?} must turn it OFF");
        }
    }

    // ── master() ────────────────────────────────────────────────────────────

    #[test]
    fn master_lists_video_variant_and_iframe_rendition() {
        let m = master(6_000_000, Some((1920, 1080)), None);
        assert!(m.starts_with("#EXTM3U\n"));
        assert!(m.contains("#EXT-X-VERSION:4\n"));
        // The I-frame rendition drives AVPlayer's scrubbing thumbnails.
        assert!(
            m.contains(&format!(
                "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH={IFRAME_BANDWIDTH_BPS},URI=\"iframe.m3u8\"\n"
            )),
            "{m}"
        );
        // The one video variant points at the synthesized VOD media playlist.
        assert!(
            m.contains("#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\n"),
            "{m}"
        );
        assert!(m.trim_end().ends_with("media.m3u8"), "{m}");
    }

    #[test]
    fn master_omits_resolution_when_unknown() {
        let m = master(3_000_000, None, None);
        assert!(m.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000\n"), "{m}");
        assert!(!m.contains("RESOLUTION="), "{m}");
        assert!(m.trim_end().ends_with("media.m3u8"), "{m}");
    }

    #[test]
    fn master_advertises_subs_group_when_sidecar_present() {
        let subs = crate::plan::SidecarSubtitle {
            source_index: 2,
            language: Some("eng".into()),
            forced: false,
        };
        let m = master(3_000_000, None, Some(&subs));
        assert!(
            m.contains("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\""),
            "{m}"
        );
        assert!(
            m.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES=\"subs\"\n"),
            "{m}"
        );
    }

    // ── iframe_playlist() ───────────────────────────────────────────────────

    #[test]
    fn iframe_unusable_duration_yields_none() {
        assert!(iframe_playlist(0.0).is_none());
        assert!(iframe_playlist(-5.0).is_none());
        assert!(iframe_playlist(f64::NAN).is_none());
        assert!(iframe_playlist(f64::INFINITY).is_none());
    }

    #[test]
    fn iframe_is_a_finite_iframes_only_vod_playlist() {
        let m = iframe_playlist(100.0).unwrap();
        assert!(m.starts_with("#EXTM3U\n"));
        assert!(m.contains("#EXT-X-VERSION:4\n"));
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD\n"));
        // The tag that tells AVPlayer every segment is a single I-frame.
        assert!(m.contains("#EXT-X-I-FRAMES-ONLY\n"), "{m}");
        assert!(m.contains(&format!(
            "#EXT-X-TARGETDURATION:{TRICKPLAY_INTERVAL_SECS}\n"
        )));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(!m.contains("EVENT"));
    }

    #[test]
    fn iframe_count_is_ceil_duration_over_interval() {
        // 100 / 10 = exactly 10 thumbnails.
        let m = iframe_playlist(100.0).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 10);
        assert_eq!(m.matches("thumb_").count(), 10);
        assert!(m.contains("thumb_00000.ts\n"));
        assert!(m.contains("thumb_00009.ts\n"));
        assert!(!m.contains("thumb_00010"));
    }

    #[test]
    fn iframe_remainder_lands_in_a_short_final_entry() {
        // 105 / 10 -> 11 entries: ten 10.0s + a 5.0s tail.
        let m = iframe_playlist(105.0).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 11);
        assert!(m.contains("#EXTINF:10.000000,\n"));
        assert!(m.contains("#EXTINF:5.000000,\n"));
        assert!(m.contains("thumb_00010.ts\n"));
    }

    #[test]
    fn iframe_entries_carry_no_byterange() {
        // Whole-file single-I-frame segments: no EXT-X-BYTERANGE (see module doc).
        let m = iframe_playlist(50.0).unwrap();
        assert!(!m.contains("#EXT-X-BYTERANGE"), "{m}");
    }

    #[test]
    fn iframe_extinf_sum_matches_duration() {
        let m = iframe_playlist(137.0).unwrap();
        let sum: f64 = m
            .lines()
            .filter_map(|l| l.strip_prefix("#EXTINF:"))
            .filter_map(|s| s.strip_suffix(",").unwrap_or(s).parse::<f64>().ok())
            .sum();
        assert!((sum - 137.0).abs() < 1e-6, "sum {sum} != 137.0\n{m}");
    }

    // ── thumb_args() ────────────────────────────────────────────────────────

    #[test]
    fn thumb_args_sample_one_keyframe_per_segment() {
        let a = thumb_args(
            "/media/movie.mkv",
            "/scratch/sess",
            TRICKPLAY_INTERVAL_SECS,
            THUMB_WIDTH,
        );
        let j = a.join(" ");
        // One frame per interval, scaled to the thumbnail width (even height).
        assert!(j.contains("-vf fps=1/10,scale=320:-2"), "{j}");
        // Every frame a keyframe → each 1-frame segment is a clean I-frame.
        assert!(j.contains("-g 1"), "{j}");
        // Segment cadence == sample cadence ⇒ exactly one frame per segment.
        assert!(j.contains("-hls_time 10"), "{j}");
        // Video-only, no audio/subs.
        assert!(j.contains("-an -sn"), "{j}");
        assert!(j.contains("-c:v libx264"), "{j}");
        // Thumbnails cover the WHOLE title: never seek.
        assert!(!j.contains("-ss"), "thumbnails must not seek: {j}");
        assert!(j.contains("/scratch/sess/thumb_%05d.ts"), "{j}");
        assert!(
            j.trim_end().ends_with("/scratch/sess/thumb_index.m3u8"),
            "{j}"
        );
    }
}
