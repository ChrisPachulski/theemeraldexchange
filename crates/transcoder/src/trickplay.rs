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
//! synthesized single MEDIA playlist. COPY-remux is deliberately NOT covered by
//! the trick-play I-frame rendition — a copy session runs no encoder, so a
//! thumbnail rendition would need a fresh decode+scale+encode pass regardless,
//! i.e. exactly the CPU the copy path exists to avoid.
//!
//! [`master`] is also the shared MASTER builder for the two OTHER native-only
//! rendition groups, each independently gated: the sidecar-subtitle
//! `TYPE=SUBTITLES` group (see [`crate::subs_manifest`]) and — behind
//! [`alt_audio_enabled`] (`TRANSCODER_ALT_AUDIO`, default OFF) — the alternate
//! **audio** `TYPE=AUDIO` group (Spec S4). The latter surfaces multiple audio
//! tracks to AVPlayer on the fMP4/HEVC-copy path, where in-band multiplexing
//! alone does not: the primary stays muxed in-band (`DEFAULT=YES`, no URI) while
//! each EXTRA track is segmented into its own `audio_{n}.m3u8` rendition by a
//! detached [`audio_rendition_args`] pass (mirroring the sidecar/thumbnail
//! passes). Like trick-play it is default-OFF pending on-device validation of
//! the mixed in-band-default + separate-URI group on a real Apple TV.

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

/// `GROUP-ID` binding the video variant to its alternate-audio renditions. A
/// single group holds every audio track for the title; the variant references
/// it with `AUDIO="aud"` and each rendition advertises `GROUP-ID="aud"`.
pub(crate) const AUDIO_GROUP_ID: &str = "aud";

/// Whether trick-play is enabled. Reads `TRANSCODER_TRICKPLAY`; truthy values
/// (`1`/`true`/`yes`/`on`, case-insensitive) turn it on. Default OFF, so an
/// unconfigured deploy is byte-for-byte the proven serving path.
pub(crate) fn enabled() -> bool {
    is_truthy(&std::env::var("TRANSCODER_TRICKPLAY").unwrap_or_default())
}

/// Whether ALTERNATE-AUDIO renditions are advertised. Reads
/// `TRANSCODER_ALT_AUDIO`; truthy values turn it on. Default OFF for the same
/// reason as trick-play: it adds a SECOND ffmpeg pass per extra audio track and
/// changes the native master's shape (a mixed in-band-default + separate-URI
/// audio group), which must be validated on a real Apple TV before default-on.
/// With the flag OFF the native serving path is byte-for-byte the proven one —
/// no audio group is emitted and no extra ffmpeg pass is spawned.
pub(crate) fn alt_audio_enabled() -> bool {
    is_truthy(&std::env::var("TRANSCODER_ALT_AUDIO").unwrap_or_default())
}

/// The `URI` (and on-disk playlist filename) for the alternate-audio rendition
/// carrying the `n`-th (audio-relative) source track — resolves, relative to the
/// master's `…/session/{id}/index.m3u8` URL, to `…/session/{id}/audio_{n}.m3u8`,
/// the media playlist the detached audio pass ([`audio_rendition_args`]) writes.
/// Passes `routes`' safe-name whitelist (alnum + `_` + `.`).
pub(crate) fn audio_playlist_name(audio_index: usize) -> String {
    format!("audio_{audio_index}.m3u8")
}

/// One alternate-audio rendition advertised by [`master`] as an
/// `#EXT-X-MEDIA:TYPE=AUDIO` in the [`AUDIO_GROUP_ID`] group.
///
/// `uri` is `Some(audio_{n}.m3u8)` for a track delivered as its OWN media
/// playlist (a separate segmented rendition produced by [`audio_rendition_args`])
/// and `None` for the track already muxed IN-BAND into the video variant (the
/// primary, `DEFAULT=YES`) — RFC 8216 §4.3.4.2.1 lets a rendition omit `URI` to
/// mean "present in the referencing variant's Media Playlist", so keeping the
/// primary in-band leaves the main transcode pipeline byte-for-byte unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AudioRendition {
    /// Display name for the picker; the language tag when known, else the track
    /// title, else a positional `Audio N` (never empty — `NAME` is required).
    pub name: String,
    /// ISO language tag from the probe, when known.
    pub language: Option<String>,
    /// `DEFAULT=YES` for the primary (English-preferred) track; the player
    /// starts on it. Exactly one rendition in the group should carry this.
    pub is_default: bool,
    /// `Some(audio_{n}.m3u8)` for a separate rendition playlist; `None` for the
    /// in-band primary (no `URI` attribute is emitted).
    pub uri: Option<String>,
}

/// The `#EXT-X-MEDIA:TYPE=AUDIO` line advertising one [`AudioRendition`] in the
/// [`AUDIO_GROUP_ID`] group. Mirrors [`crate::subs_manifest::media_tag`]'s shape:
/// `NAME` is required; `LANGUAGE` is emitted only when known; `AUTOSELECT=YES`
/// lets AVPlayer pick it by system-language preference; `DEFAULT` marks the
/// primary; `URI` is present only for a separately-segmented rendition.
pub(crate) fn audio_media_tag(rendition: &AudioRendition) -> String {
    let language_attr = match rendition.language.as_deref().map(str::trim) {
        Some(l) if !l.is_empty() => format!("LANGUAGE=\"{l}\","),
        _ => String::new(),
    };
    let default = if rendition.is_default { "YES" } else { "NO" };
    let uri_attr = match &rendition.uri {
        Some(uri) => format!(",URI=\"{uri}\""),
        None => String::new(),
    };
    format!(
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"{AUDIO_GROUP_ID}\",NAME=\"{name}\",{language_attr}AUTOSELECT=YES,DEFAULT={default}{uri_attr}\n",
        name = rendition.name,
    )
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
/// * `include_iframe` — emit the `#EXT-X-I-FRAME-STREAM-INF` thumbnail rendition.
///   TRUE only for a RE-ENCODE session with the trick-play thumbnail pass
///   running; FALSE for a copy-remux (no thumbnails exist) so the master never
///   advertises an I-frame playlist that would 404.
/// * `subs` — the session's sidecar subtitle, when one is being extracted;
///   advertised as the same `subs` group the subtitle rendition
///   ([`crate::subs_manifest::media_tag`]) uses, so native pickers see it here.
/// * `audio` — alternate-audio renditions (see [`AudioRendition`]). When
///   non-empty the variant gains `AUDIO="aud"` and each rendition is emitted as
///   an `#EXT-X-MEDIA:TYPE=AUDIO` line; empty leaves the variant's audio in-band
///   exactly as before, so a single-audio title's master is unchanged.
pub(crate) fn master(
    variant_bandwidth_bps: u32,
    resolution: Option<(u32, u32)>,
    include_iframe: bool,
    subs: Option<&crate::plan::SidecarSubtitle>,
    audio: &[AudioRendition],
) -> String {
    let mut m = String::with_capacity(256);
    m.push_str("#EXTM3U\n");
    // v4 is the floor for EXT-X-I-FRAME-STREAM-INF / EXT-X-I-FRAMES-ONLY.
    m.push_str("#EXT-X-VERSION:4\n");

    // I-frame rendition FIRST so a client that only reads the first I-frame line
    // still finds it; order is not significant to AVPlayer.
    if include_iframe {
        m.push_str(&format!(
            "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH={IFRAME_BANDWIDTH_BPS},URI=\"{IFRAME_PLAYLIST_NAME}\"\n"
        ));
    }

    // Alternate-audio group: one #EXT-X-MEDIA per track (primary in-band w/o URI,
    // extras as separate rendition playlists). Emitted before the variant so the
    // variant's AUDIO="aud" reference resolves.
    for rendition in audio {
        m.push_str(&audio_media_tag(rendition));
    }

    if let Some(s) = subs {
        m.push_str(&crate::subs_manifest::media_tag(s));
    }

    // Variant attributes, in a stable order: RESOLUTION, AUDIO, SUBTITLES.
    let mut attrs = String::new();
    if let Some((w, h)) = resolution {
        attrs.push_str(&format!(",RESOLUTION={w}x{h}"));
    }
    if !audio.is_empty() {
        attrs.push_str(&format!(",AUDIO=\"{AUDIO_GROUP_ID}\""));
    }
    if subs.is_some() {
        attrs.push_str(",SUBTITLES=\"subs\"");
    }

    // The one video variant → the synthesized VOD media playlist.
    m.push_str(&format!(
        "#EXT-X-STREAM-INF:BANDWIDTH={variant_bandwidth_bps}{attrs}\n"
    ));
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

/// ffmpeg argument vector for ONE alternate-audio rendition — a detached,
/// one-shot pass that maps a single source audio track and segments it into its
/// OWN HLS media playlist (`audio_{n}.m3u8` + `audio_{n}_%05d.ts`), the URI the
/// [`master`] advertises for that rendition.
///
/// Mirrors the decoupled sidecar-subtitle / thumbnail passes: no `-re` (it
/// finishes faster than realtime), video/subtitles stripped (`-vn -sn`), and NO
/// `-ss` — the rendition covers the WHOLE title from 0 so its timeline aligns
/// with the synthesized VOD video variant regardless of resume offset. A failure
/// just means that one language is absent from the picker; it never blocks or
/// couples the live video stream (the primary audio is still muxed in-band).
///
/// `op` gates copy-vs-encode identically to the in-band path
/// ([`crate::plan::plan_extra_audio`]): a client-decodable track is copied,
/// otherwise it is re-encoded to stereo AAC — so the rendition is always
/// playable and the language menu never has a dead entry. MPEG-TS audio-only
/// segments are the broadest-compatible container for an alternate rendition
/// (the video variant's own segment type is independent of the audio group).
pub(crate) fn audio_rendition_args(
    input: &str,
    session_dir: &str,
    audio_index: usize,
    op: &crate::plan::AudioOp,
) -> Vec<String> {
    let mut a: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-nostdin".into(),
        "-fflags".into(),
        "+genpts".into(),
        "-i".into(),
        input.into(),
        "-map".into(),
        format!("0:a:{audio_index}?"),
        "-vn".into(),
        "-sn".into(),
    ];
    match op {
        crate::plan::AudioOp::Copy => {
            a.push("-c:a".into());
            a.push("copy".into());
        }
        crate::plan::AudioOp::EncodeAac { bitrate_kbps } => {
            a.push("-c:a".into());
            a.push("aac".into());
            a.push("-ac".into());
            a.push("2".into());
            a.push("-b:a".into());
            a.push(format!("{bitrate_kbps}k"));
        }
    }
    a.extend([
        "-f".into(),
        "hls".into(),
        "-hls_time".into(),
        crate::args::HLS_SEGMENT_SECS.to_string(),
        "-hls_list_size".into(),
        "0".into(),
        "-hls_flags".into(),
        "append_list".into(),
        "-hls_playlist_type".into(),
        "vod".into(),
        "-hls_segment_type".into(),
        "mpegts".into(),
        "-hls_segment_filename".into(),
        format!("{session_dir}/audio_{audio_index}_%05d.ts"),
        format!("{session_dir}/{}", audio_playlist_name(audio_index)),
    ]);
    a
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

    // ── master() ────────────────────────────────────────────────────────────

    fn rendition(name: &str, lang: Option<&str>, default: bool, index: Option<usize>) -> AudioRendition {
        AudioRendition {
            name: name.into(),
            language: lang.map(str::to_string),
            is_default: default,
            uri: index.map(audio_playlist_name),
        }
    }

    #[test]
    fn master_lists_video_variant_and_iframe_rendition() {
        let m = master(6_000_000, Some((1920, 1080)), true, None, &[]);
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
        let m = master(3_000_000, None, true, None, &[]);
        assert!(m.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000\n"), "{m}");
        assert!(!m.contains("RESOLUTION="), "{m}");
        assert!(m.trim_end().ends_with("media.m3u8"), "{m}");
    }

    #[test]
    fn master_omits_iframe_rendition_when_not_requested() {
        // A copy-remux session has no thumbnail pass; the master must not
        // advertise an I-frame playlist that would 404.
        let m = master(3_000_000, None, false, None, &[]);
        assert!(!m.contains("#EXT-X-I-FRAME-STREAM-INF"), "{m}");
        assert!(m.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000\n"), "{m}");
    }

    #[test]
    fn master_advertises_subs_group_when_sidecar_present() {
        let subs = crate::plan::SidecarSubtitle {
            source_index: 2,
            language: Some("eng".into()),
            forced: false,
        };
        let m = master(3_000_000, None, true, Some(&subs), &[]);
        assert!(
            m.contains("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\""),
            "{m}"
        );
        assert!(
            m.contains("#EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES=\"subs\"\n"),
            "{m}"
        );
    }

    // ── master() alternate audio (Spec S4) ───────────────────────────────────

    #[test]
    fn master_advertises_audio_group_for_multiple_tracks() {
        // The S4 gate: a dual-audio title on the fMP4/HEVC-copy path (no I-frame
        // rendition) — the primary muxed in-band (no URI, DEFAULT=YES) and the
        // second track as a separate rendition playlist.
        let audio = [
            rendition("eng", Some("eng"), true, None),
            rendition("spa", Some("spa"), false, Some(1)),
        ];
        let m = master(6_000_000, None, false, None, &audio);
        // The group itself and the variant's reference to it.
        assert!(
            m.contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\""),
            "{m}"
        );
        assert!(
            m.contains("#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO=\"aud\"\n"),
            "{m}"
        );
        // Primary: in-band (no URI), DEFAULT=YES.
        assert!(
            m.contains(
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"eng\",LANGUAGE=\"eng\",AUTOSELECT=YES,DEFAULT=YES\n"
            ),
            "{m}"
        );
        // Alternate: a separate rendition playlist, DEFAULT=NO.
        assert!(
            m.contains(
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"spa\",LANGUAGE=\"spa\",AUTOSELECT=YES,DEFAULT=NO,URI=\"audio_1.m3u8\"\n"
            ),
            "{m}"
        );
        assert!(m.trim_end().ends_with("media.m3u8"), "{m}");
    }

    #[test]
    fn master_audio_group_composes_with_iframe_and_subs() {
        // A re-encode session can carry ALL THREE rendition groups at once.
        let subs = crate::plan::SidecarSubtitle {
            source_index: 3,
            language: Some("eng".into()),
            forced: false,
        };
        let audio = [
            rendition("eng", Some("eng"), true, None),
            rendition("fra", Some("fra"), false, Some(2)),
        ];
        let m = master(5_000_000, Some((1920, 1080)), true, Some(&subs), &audio);
        assert!(m.contains("#EXT-X-I-FRAME-STREAM-INF"), "{m}");
        assert!(m.contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\""), "{m}");
        assert!(m.contains("#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\""), "{m}");
        // Variant references both groups, attributes in a stable order.
        assert!(
            m.contains(
                "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aud\",SUBTITLES=\"subs\"\n"
            ),
            "{m}"
        );
    }

    #[test]
    fn master_without_audio_is_unchanged() {
        // Empty renditions ⇒ no audio group, no AUDIO attribute — a single-audio
        // title's master is byte-for-byte what it was before Spec S4.
        let m = master(3_000_000, None, false, None, &[]);
        assert!(!m.contains("TYPE=AUDIO"), "{m}");
        assert!(!m.contains("AUDIO=\"aud\""), "{m}");
    }

    #[test]
    fn audio_media_tag_omits_language_when_unknown() {
        let tag = audio_media_tag(&rendition("Audio 2", None, false, Some(3)));
        assert!(tag.contains("NAME=\"Audio 2\""), "{tag}");
        assert!(!tag.contains("LANGUAGE="), "{tag}");
        assert!(tag.contains("DEFAULT=NO"), "{tag}");
        assert!(tag.contains("URI=\"audio_3.m3u8\""), "{tag}");
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

    // ── audio_rendition_args() ───────────────────────────────────────────────

    #[test]
    fn audio_rendition_args_copies_a_client_decodable_track() {
        let a = audio_rendition_args(
            "/media/movie.mkv",
            "/scratch/sess",
            2,
            &crate::plan::AudioOp::Copy,
        );
        let j = a.join(" ");
        // Maps exactly the one (audio-relative) track, video/subs stripped.
        assert!(j.contains("-map 0:a:2?"), "{j}");
        assert!(j.contains("-vn -sn"), "{j}");
        // A decodable track passes through untouched (no re-encode).
        assert!(j.contains("-c:a copy"), "{j}");
        assert!(!j.contains("aac"), "{j}");
        // Never seek — the rendition covers the whole title from 0.
        assert!(!j.contains("-ss"), "audio rendition must not seek: {j}");
        // A finite VOD media playlist at the shared segment cadence.
        assert!(j.contains("-hls_playlist_type vod"), "{j}");
        assert!(
            j.contains(&format!("-hls_time {}", crate::args::HLS_SEGMENT_SECS)),
            "{j}"
        );
        // Writes its own rendition playlist + segments, named for the URI the
        // master advertises.
        assert!(j.contains("/scratch/sess/audio_2_%05d.ts"), "{j}");
        assert!(j.trim_end().ends_with("/scratch/sess/audio_2.m3u8"), "{j}");
    }

    #[test]
    fn audio_rendition_args_reencodes_an_undecodable_track_to_stereo_aac() {
        let a = audio_rendition_args(
            "/media/movie.mkv",
            "/scratch/sess",
            1,
            &crate::plan::AudioOp::EncodeAac { bitrate_kbps: 192 },
        );
        let j = a.join(" ");
        // An undecodable track (e.g. DTS) becomes stereo AAC so the menu entry
        // is never dead — mirrors the in-band per-track op.
        assert!(j.contains("-c:a aac -ac 2 -b:a 192k"), "{j}");
        assert!(j.contains("/scratch/sess/audio_1_%05d.ts"), "{j}");
        assert!(j.trim_end().ends_with("/scratch/sess/audio_1.m3u8"), "{j}");
    }
}
