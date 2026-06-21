//! Synthetic VOD playlist for native HLS clients (AVPlayer / AVKit).
//!
//! AVKit renders a "LIVE" badge, a wall-clock readout, and a live-edge scrubber
//! whenever the HLS playlist has no `#EXT-X-ENDLIST` — i.e. an indefinite
//! duration. That is exactly how the on-demand transcoder's growing `EVENT`
//! playlist looks until encoding finishes, so a movie plays as if it were live
//! and cannot be scrubbed. hls.js (the web player) handles `EVENT` fine, but a
//! native player needs a finite VOD timeline up front.
//!
//! This applies ONLY to RE-ENCODE sessions. There the encoder forces a keyframe
//! on every `HLS_SEGMENT_SECS` boundary (`-force_key_frames`), so the segment
//! count is deterministic — `ceil(remaining / HLS_SEGMENT_SECS)` — and every
//! segment is exactly `HLS_SEGMENT_SECS` long except a short final one. That
//! lets us emit a COMPLETE VOD playlist — full segment list + `#EXT-X-ENDLIST` —
//! before a single segment exists. The native player gets a real scrubber
//! immediately; segments are served on demand as the (faster-than-realtime)
//! encoder produces them, with a short wait-for-segment in
//! `routes::session_segment` covering the frontier.
//!
//! A COPY-remux (HEVC→fMP4 / H264→TS) does NOT force keyframes — ffmpeg cuts at
//! the source's own keyframes into ragged, variable-length segments whose count
//! and durations cannot be predicted up front. So `SessionManager::vod_manifest`
//! does NOT call this for copy sessions; they serve ffmpeg's real on-disk
//! playlist (correct segments; gains `#EXT-X-ENDLIST` when the remux finishes).
//!
//! This is served ONLY to native clients; web keeps the proven `EVENT` playlist.

use crate::args::HLS_SEGMENT_SECS;

/// Build a complete VOD playlist covering `[start_secs, total_duration_secs)`.
///
/// - `total_duration_secs` — full media duration (from the file probe).
/// - `start_secs` — server-side resume offset; the transcode (and therefore
///   this playlist) begins here, with segments numbered from 0.
/// - `fmp4` — true for HEVC-copy fMP4 sessions (`.m4s` segments + an `init.mp4`
///   map), false for MPEG-TS (`.ts`).
///
/// Returns `None` when the duration is unknown / non-positive or the remaining
/// span is empty — callers then fall back to the on-disk (`EVENT`) playlist.
pub(crate) fn synthesize(total_duration_secs: f64, start_secs: u64, fmp4: bool) -> Option<String> {
    let seg = f64::from(HLS_SEGMENT_SECS);
    if !total_duration_secs.is_finite() || total_duration_secs <= 0.0 {
        return None;
    }
    // FULL [0, total] timeline, numbered by ABSOLUTE index. The transcode is
    // still `-ss`-seeked (to a grid-quantized start) and writes its first segment
    // at absolute index ⌊start/seg⌋ via `-start_number`, but the playlist always
    // declares the WHOLE title so AVPlayer's native VOD scrubber reports the true
    // position and full duration (not 0:00 / remaining). `#EXT-X-START` positions
    // playback at the resume point; the segments before it are produced on demand
    // when the viewer scrubs back (see on-demand backfill in session_segment).
    let count = (total_duration_secs / seg).ceil() as u64;
    if count == 0 {
        return None;
    }

    let ext = if fmp4 { "m4s" } else { "ts" };
    // fMP4 needs `#EXT-X-MAP`, which requires HLS v7; plain TS rides v3.
    let version = if fmp4 { 7 } else { 3 };

    let mut m = String::with_capacity(112 + count as usize * 28);
    m.push_str("#EXTM3U\n");
    m.push_str(&format!("#EXT-X-VERSION:{version}\n"));
    m.push_str(&format!("#EXT-X-TARGETDURATION:{HLS_SEGMENT_SECS}\n"));
    m.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    m.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    // Resume point. Omitted at 0 so a fresh start keeps the proven manifest
    // byte-for-byte. Clamped just inside the timeline so a near-end offset stays
    // a legal TIME-OFFSET.
    if start_secs > 0 {
        let off = (start_secs as f64).min((total_duration_secs - 0.001).max(0.0));
        m.push_str(&format!("#EXT-X-START:TIME-OFFSET={off:.6}\n"));
    }
    if fmp4 {
        m.push_str("#EXT-X-MAP:URI=\"init.mp4\"\n");
    }
    for i in 0..count {
        // Every segment is HLS_SEGMENT_SECS long except the last, which carries
        // the remainder. The encoder's forced keyframes anchor each cut to an
        // absolute multiple of HLS_SEGMENT_SECS, so on-disk segments line up
        // with this absolute-indexed list one-for-one.
        let dur = if i + 1 == count {
            total_duration_secs - seg * (count - 1) as f64
        } else {
            seg
        };
        m.push_str(&format!("#EXTINF:{dur:.6},\n"));
        m.push_str(&format!("seg_{i:05}.{ext}\n"));
    }
    m.push_str("#EXT-X-ENDLIST\n");
    Some(m)
}

/// Compute the copy-remux segment CUT POINTS from the source video keyframe PTS
/// list, reproducing ffmpeg's `hlsenc` stream-copy segmenter EXACTLY.
///
/// ffmpeg with `-c copy -hls_time T` cannot insert keyframes, so it can only cut
/// at the source's own (irregular, scene-cut) keyframes. The running boundary
/// `end` starts at `base + T` and, after each cut, advances by `T` with NO
/// catch-up to the actual cut time (`hlsenc` compares `pkt.pts - start_pts`
/// against `end_pts`, with `end_pts += T` per segment and `start_pts` = the first
/// packet, i.e. `base`). Because `end` advances by only `T` while keyframes are
/// usually spaced several seconds apart, `end` quickly falls behind and then
/// EVERY keyframe becomes a segment boundary — yet a burst of keyframes closer
/// than `T` early on (before `end` falls behind) is still merged into one
/// segment. Verified to match real `ffmpeg -c copy` output EXACTLY for H.264→TS
/// and HEVC→fMP4 at `-ss` 0/37/600/1234 on the NAS; an earlier catch-up grid
/// (`(floor(p/T)+1)*T`) diverged in dense-keyframe regions and on resume.
///
/// `keyframes` are absolute source PTS (seconds); `base` is where copy begins
/// (the keyframe `-ss` seeks to — 0 for a fresh start); `total_abs` is the full
/// source duration. Returned cut points are ABSOLUTE source PTS, in
/// `(base, total_abs)`.
fn copy_cut_points(keyframes: &[f64], base: f64, total_abs: f64, hls_time: f64) -> Vec<f64> {
    let mut cuts = Vec::new();
    let mut end = base + hls_time;
    for &p in keyframes {
        if p <= base {
            continue; // the seek keyframe itself starts segment 0, never a cut
        }
        if p >= total_abs {
            break; // a keyframe at/after EOF never opens another segment
        }
        if p >= end {
            cuts.push(p);
            end += hls_time; // advance ONE step; no catch-up (matches hlsenc)
        }
    }
    cuts
}

/// Resume anchor for a COPY-remux session: the absolute segment grid of the
/// WHOLE title, indexed so the synthesized manifest and the `-ss`/`-start_number`
/// spawn agree on segment numbering.
///
/// `bounds` are the segment START points of the full `[0, total]` timeline —
/// `[0.0, ...copy_cut_points(keyframes, 0, total, hls)]` — so segment `i` covers
/// `[bounds[i], bounds[i+1])` (the last segment ends at `total`). The resume
/// `base` is `bounds[start_idx]` for the largest `start_idx` with
/// `bounds[start_idx] <= start_secs`; that is exactly the keyframe `-ss` seeks to
/// (the keyframe at/before the offset that ALSO opens a segment), so a resume
/// re-roots the suffix list at `base` and numbers it from `start_idx`.
///
/// This is the SINGLE source of truth shared by [`synthesize_copy`] and the
/// session spawn (`session::start`'s copy branch): both call it so the manifest's
/// `seg_NNNNN` numbering matches ffmpeg's `-start_number`. Callers guarantee
/// `keyframes` is non-empty and `total_duration_secs` is finite/positive.
pub(crate) fn copy_resume_base(
    keyframes: &[f64],
    total_duration_secs: f64,
    start_secs: u64,
) -> (u64, f64) {
    let hls = f64::from(HLS_SEGMENT_SECS);
    let full_cuts = copy_cut_points(keyframes, 0.0, total_duration_secs, hls);
    // Segment boundaries of the WHOLE title: bounds[0]=0, then each cut point.
    // Segment i = [bounds[i], bounds[i+1]); the final segment ends at total.
    let start = start_secs as f64;
    let mut start_idx = 0u64;
    let mut base = 0.0;
    // bounds = [0.0, ...full_cuts]; find the largest index whose bound <= start.
    for (offset, &cut) in full_cuts.iter().enumerate() {
        if cut <= start {
            // index in bounds is offset+1 (bounds[0] is the leading 0.0)
            start_idx = offset as u64 + 1;
            base = cut;
        } else {
            break;
        }
    }
    (start_idx, base)
}

/// Build a complete VOD playlist for a COPY-remux session from the source's
/// keyframe list — the analogue of [`synthesize`] for sessions that do NOT
/// re-encode (HEVC→fMP4 / H264→TS), whose segments are cut at the source's own
/// ragged keyframes and so cannot be derived from the duration alone.
///
/// `keyframes` is the full source video keyframe PTS list (absolute seconds,
/// ascending). `start_secs` is the resume offset. Like [`synthesize`], this
/// emits the FULL `[0, total]` timeline so AVPlayer's native VOD scrubber shows
/// the true position and full duration (not 0:00 / remaining):
///
/// - PREFIX segments `0..start_idx` cover `[0, base)` (durations = consecutive
///   diffs of the full-title boundaries). They are produced on demand if the
///   viewer scrubs back before the resume point (Phase 3); until then they 404,
///   which the native client tolerates as long as playback starts at/after
///   `#EXT-X-START`.
/// - SUFFIX segments `start_idx..` cover `[base, total)` — the exact ragged
///   segments ffmpeg's `-ss base` stream-copy writes (`copy_cut_points` rooted
///   at `base`), verified on the NAS at multiple offsets.
///
/// `(start_idx, base)` come from [`copy_resume_base`], the same helper the
/// session spawn uses, so `seg_NNNNN` numbering matches ffmpeg's `-start_number`.
/// `#EXT-X-START:TIME-OFFSET=base` is emitted ONLY on a resume (`start_idx > 0`);
/// a fresh start (`start_idx == 0`, `base == 0`) keeps the proven from-0 manifest
/// byte-for-byte.
///
/// Returns `None` (→ caller falls back to the on-disk playlist) when the
/// duration is unusable, the keyframe list is empty, or the span is empty.
/// Unlike [`synthesize`], `#EXT-X-TARGETDURATION` is computed from the LONGEST
/// segment over ALL prefix + suffix durations (copy segments can be ~5×
/// `HLS_SEGMENT_SECS` between sparse keyframes), since a too-small TARGETDURATION
/// makes AVPlayer reject the VOD.
pub(crate) fn synthesize_copy(
    keyframes: &[f64],
    total_duration_secs: f64,
    start_secs: u64,
    fmp4: bool,
) -> Option<String> {
    if !total_duration_secs.is_finite() || total_duration_secs <= 0.0 || keyframes.is_empty() {
        return None;
    }
    let hls = f64::from(HLS_SEGMENT_SECS);
    let (start_idx, base) = copy_resume_base(keyframes, total_duration_secs, start_secs);
    if total_duration_secs - base <= 0.0 {
        return None;
    }

    // PREFIX: segments [0, start_idx) covering [0, base). Their durations are the
    // consecutive diffs of the full-title boundaries up to `base`. Re-derive the
    // SAME boundary list `copy_resume_base` used so the prefix lines up exactly.
    let full_cuts = copy_cut_points(keyframes, 0.0, total_duration_secs, hls);
    let mut durs = Vec::with_capacity(full_cuts.len() + 1);
    {
        // bounds = [0.0, ...full_cuts]; emit diffs bounds[i+1]-bounds[i] for the
        // first `start_idx` segments (these all end at or before `base`).
        let mut prev = 0.0;
        for &c in full_cuts.iter().take(start_idx as usize) {
            durs.push(c - prev);
            prev = c;
        }
    }

    // SUFFIX: segments [start_idx, ..) covering [base, total). Computed EXACTLY as
    // before, just rooted at `base` — this is what the `-ss base` session writes.
    let cuts = copy_cut_points(keyframes, base, total_duration_secs, hls);
    let mut prev = base;
    for &c in &cuts {
        durs.push(c - prev);
        prev = c;
    }
    let tail = total_duration_secs - prev;
    // A keyframe landing within ~1ms of EOF leaves a degenerate final segment
    // ffmpeg would not write; drop it so the synthesized count matches disk.
    if tail > 1e-3 {
        durs.push(tail);
    }
    if durs.is_empty() {
        return None;
    }

    let ext = if fmp4 { "m4s" } else { "ts" };
    let version = if fmp4 { 7 } else { 3 };
    let target_dur = durs.iter().copied().fold(0.0, f64::max).ceil().max(1.0) as u64;

    let mut m = String::with_capacity(112 + durs.len() * 28);
    m.push_str("#EXTM3U\n");
    m.push_str(&format!("#EXT-X-VERSION:{version}\n"));
    m.push_str(&format!("#EXT-X-TARGETDURATION:{target_dur}\n"));
    m.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    m.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    // Resume point. Omitted at a fresh start (start_idx 0 / base 0) so a from-0
    // session keeps the proven manifest byte-for-byte.
    if start_idx > 0 {
        m.push_str(&format!("#EXT-X-START:TIME-OFFSET={base:.6}\n"));
    }
    if fmp4 {
        m.push_str("#EXT-X-MAP:URI=\"init.mp4\"\n");
    }
    // Segments are numbered contiguously from 0 over prefix THEN suffix, matching
    // the absolute grid `copy_resume_base` defines.
    for (i, dur) in durs.iter().enumerate() {
        m.push_str(&format!("#EXTINF:{dur:.6},\n"));
        m.push_str(&format!("seg_{i:05}.{ext}\n"));
    }
    m.push_str("#EXT-X-ENDLIST\n");
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_nonpositive_duration_yields_none() {
        assert!(synthesize(0.0, 0, false).is_none());
        assert!(synthesize(-5.0, 0, false).is_none());
        assert!(synthesize(f64::NAN, 0, false).is_none());
        assert!(synthesize(f64::INFINITY, 0, false).is_none());
    }

    #[test]
    fn start_at_or_past_end_still_lists_full_timeline_with_clamped_offset() {
        // A degenerate offset >= duration shouldn't happen (a completed title
        // resumes at 0), but if it does we still serve the full timeline with a
        // legal (clamped, just-inside) TIME-OFFSET rather than a dead manifest.
        let m = synthesize(100.0, 200, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 50); // 100 / 2
        assert!(m.contains("#EXT-X-START:TIME-OFFSET=99.999000\n"), "{m}");
    }

    #[test]
    fn is_a_finite_vod_playlist_with_endlist() {
        let m = synthesize(10.0, 0, false).unwrap();
        assert!(m.starts_with("#EXTM3U\n"));
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD\n"));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        // A finite VOD playlist is what stops AVKit showing the LIVE badge.
        assert!(!m.contains("EVENT"));
    }

    #[test]
    fn exact_multiple_lists_all_full_segments() {
        // 10s / 2s = exactly 5 segments, each 2.0s.
        let m = synthesize(10.0, 0, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 5);
        assert_eq!(m.matches("seg_").count(), 5);
        assert!(m.contains("seg_00000.ts\n"));
        assert!(m.contains("seg_00004.ts\n"));
        assert!(!m.contains("seg_00005"));
    }

    #[test]
    fn remainder_lands_in_a_short_final_segment() {
        // 5s / 2s -> 3 segments: 2.0, 2.0, 1.0.
        let m = synthesize(5.0, 0, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 3);
        assert!(m.contains("#EXTINF:2.000000,\n"));
        assert!(m.contains("#EXTINF:1.000000,\n"));
        assert!(m.contains("seg_00002.ts\n"));
    }

    #[test]
    fn resume_keeps_full_timeline_and_sets_ext_x_start() {
        // duration 20s, resume at 10s. The playlist still declares the WHOLE
        // title (20 / 2 = 10 absolute segments seg_00000..seg_00009) so the
        // native scrubber shows 0:10 / 0:20, with EXT-X-START at the resume point.
        let m = synthesize(20.0, 10, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 10);
        assert!(m.contains("seg_00000.ts\n"));
        assert!(m.contains("seg_00009.ts\n"));
        assert!(!m.contains("seg_00010"));
        assert!(m.contains("#EXT-X-START:TIME-OFFSET=10.000000\n"), "{m}");
    }

    #[test]
    fn fresh_start_omits_ext_x_start() {
        // A from-zero session keeps the proven manifest: no EXT-X-START line.
        let m = synthesize(20.0, 0, false).unwrap();
        assert!(!m.contains("#EXT-X-START"), "{m}");
        assert_eq!(m.matches("#EXTINF:").count(), 10);
    }

    #[test]
    fn fmp4_emits_map_and_m4s_segments() {
        let m = synthesize(4.0, 0, true).unwrap();
        assert!(m.contains("#EXT-X-VERSION:7\n"));
        assert!(m.contains("#EXT-X-MAP:URI=\"init.mp4\"\n"));
        assert!(m.contains("seg_00000.m4s\n"));
        assert!(!m.contains(".ts\n"));
    }

    #[test]
    fn mpegts_has_no_map_and_uses_v3() {
        let m = synthesize(4.0, 0, false).unwrap();
        assert!(m.contains("#EXT-X-VERSION:3\n"));
        assert!(!m.contains("#EXT-X-MAP"));
        assert!(m.contains("seg_00000.ts\n"));
    }

    // ── copy-remux (keyframe-derived) synthesis ─────────────────────────────

    /// The first 14 keyframe PTS of a real HEVC BluRay rip ("A Goofy Movie",
    /// `…H.265-EDGE2020.mkv`), captured from `ffprobe -show_entries packet`.
    const GOOFY_KF: &[f64] = &[
        0.000, 1.084, 11.511, 13.347, 23.774, 25.943, 36.370, 46.797, 55.722, 59.601, 69.361,
        74.157, 77.911, 79.830,
    ];

    #[test]
    fn golden_boundaries_match_real_ffmpeg() {
        // Truncating the source at the last listed keyframe (79.830) yields the
        // exact segment list `ffmpeg -c copy -hls_time 2 -hls_segment_type fmp4`
        // wrote on disk for the first ~80s (verified live on the NAS): 12
        // segments with these ragged EXTINFs, NOT uniform 2s.
        let m = synthesize_copy(GOOFY_KF, 79.830, 0, true).unwrap();
        for inf in [
            "#EXTINF:11.511000,",
            "#EXTINF:1.836000,",
            "#EXTINF:10.427000,",
            "#EXTINF:2.169000,",
            "#EXTINF:8.925000,",
            "#EXTINF:3.879000,",
            "#EXTINF:9.760000,",
            "#EXTINF:4.796000,",
            "#EXTINF:3.754000,",
            "#EXTINF:1.919000,",
        ] {
            assert!(m.contains(inf), "missing {inf}\n{m}");
        }
        assert_eq!(m.matches("#EXTINF:").count(), 12, "{m}");
        assert_eq!(m.matches("seg_").count(), 12, "{m}");
        assert!(m.contains("seg_00000.m4s\n"));
        assert!(m.contains("seg_00011.m4s\n"));
        assert!(!m.contains("seg_00012"));
    }

    #[test]
    fn copy_targetduration_covers_the_longest_segment() {
        // Copy segments span sparse keyframes (here up to 11.511s), so a
        // hardcoded TARGETDURATION:2 (the re-encode value) would be spec-illegal
        // and rejected by AVPlayer — it must round up the longest segment.
        let m = synthesize_copy(GOOFY_KF, 79.830, 0, true).unwrap();
        assert!(m.contains("#EXT-X-TARGETDURATION:12\n"), "{m}");
    }

    #[test]
    fn copy_is_a_finite_vod_playlist_never_live() {
        let m = synthesize_copy(GOOFY_KF, 79.830, 0, true).unwrap();
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD\n"));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(!m.contains("EVENT"));
        // fMP4 path carries the init map at v7.
        assert!(m.contains("#EXT-X-VERSION:7\n"));
        assert!(m.contains("#EXT-X-MAP:URI=\"init.mp4\"\n"));
    }

    #[test]
    fn copy_cuts_at_every_keyframe_once_end_falls_behind() {
        // Locks the no-catch-up rule: keyframes at 5,6,7 over a 2s grid. ffmpeg's
        // `end_pts` advances 2→4→6→… (one step per cut, never catching up to the
        // actual cut time), so once it lags it cuts at EVERY keyframe: segments
        // 5,1,1 + a 1s tail. A buggy absolute/catch-up grid would instead merge
        // 6→7 and yield 5,1,2. Real ffmpeg does the former.
        let m = synthesize_copy(&[0.0, 5.0, 6.0, 7.0], 8.0, 0, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 4, "{m}");
        for inf in ["#EXTINF:5.000000,", "#EXTINF:1.000000,"] {
            assert!(m.contains(inf), "missing {inf}\n{m}");
        }
        assert!(!m.contains("#EXTINF:2.000000,"), "must not merge 6→7: {m}");
    }

    #[test]
    fn copy_resume_serves_full_timeline_rebased_to_the_seek_keyframe() {
        // -ss 30 → copy_resume_base anchors at 25.943 (start_idx 4). The manifest
        // now declares the WHOLE title (4 prefix + 8 suffix = 12 segments) so the
        // native scrubber shows the absolute position / full duration, with the
        // SUFFIX still cut exactly as the -ss session writes: the segment at the
        // resume point runs to the next keyframe (36.370 → 10.427s).
        let m = synthesize_copy(GOOFY_KF, 79.830, 30, true).unwrap();
        assert!(m.contains("#EXT-X-PLAYLIST-TYPE:VOD\n"));
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(m.contains("#EXTINF:10.427000,\n"), "{m}"); // 36.370 - 25.943
        // EXT-X-START sits at the resume base (25.943), not the raw offset.
        assert!(m.contains("#EXT-X-START:TIME-OFFSET=25.943000\n"), "{m}");
        // Full timeline: 4 prefix + 8 suffix = 12 contiguous segments.
        assert_eq!(m.matches("#EXTINF:").count(), 12, "{m}");
        assert!(m.contains("seg_00000.m4s\n"));
        assert!(m.contains("seg_00011.m4s\n"));
        assert!(!m.contains("seg_00012"));
    }

    #[test]
    fn copy_seek_within_first_gop_is_still_a_fresh_synthesis() {
        // A tiny offset that lands at/before the first segment boundary (base==0,
        // start_idx==0) is output-equivalent to a fresh start: no EXT-X-START, the
        // first segment is the from-0 one (11.511s).
        let m = synthesize_copy(GOOFY_KF, 79.830, 1, true).unwrap();
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(!m.contains("#EXT-X-START"), "{m}");
        assert!(m.contains("#EXTINF:11.511000,\n"), "{m}");
    }

    #[test]
    fn copy_empty_keyframes_or_bad_duration_yields_none() {
        assert!(synthesize_copy(&[], 100.0, 0, true).is_none());
        assert!(synthesize_copy(GOOFY_KF, 0.0, 0, true).is_none());
        assert!(synthesize_copy(GOOFY_KF, -1.0, 0, true).is_none());
    }

    #[test]
    fn copy_resume_base_anchors_to_the_full_title_grid() {
        // The full-title boundaries for GOOFY_KF (from copy_cut_points(.,0,79.830,2)):
        // bounds = [0, 11.511, 13.347, 23.774, 25.943, 36.370, 46.797, 55.722,
        //           59.601, 69.361, 74.157, 77.911]. copy_resume_base picks the
        // largest bound <= offset, with its index.
        // offset 30 → bound 25.943 at index 4.
        assert_eq!(copy_resume_base(GOOFY_KF, 79.830, 30), (4, 25.943));
        // offset 50 → bound 46.797 at index 6.
        assert_eq!(copy_resume_base(GOOFY_KF, 79.830, 50), (6, 46.797));
        // offset 0 → fresh start: index 0, base 0.
        assert_eq!(copy_resume_base(GOOFY_KF, 79.830, 0), (0, 0.0));
        // offset below the first cut (1 < 11.511) is still the fresh grid.
        assert_eq!(copy_resume_base(GOOFY_KF, 79.830, 1), (0, 0.0));
    }

    #[test]
    fn copy_resume_full_timeline_numbering_and_suffix_match() {
        // Resume at offset 50 → base 46.797, start_idx 6. The manifest is the FULL
        // timeline: 6 prefix + the suffix from copy_cut_points rooted at base.
        const OFFSET: u64 = 50;
        let m = synthesize_copy(GOOFY_KF, 79.830, OFFSET, true).unwrap();

        let (start_idx, base) = copy_resume_base(GOOFY_KF, 79.830, OFFSET);
        assert_eq!((start_idx, base), (6, 46.797));

        // EXT-X-START carries the resume base.
        assert!(m.contains("#EXT-X-START:TIME-OFFSET=46.797000\n"), "{m}");

        // SUFFIX EXTINFs == those derived from copy_cut_points rooted at base.
        let cuts = copy_cut_points(GOOFY_KF, base, 79.830, f64::from(HLS_SEGMENT_SECS));
        let mut suffix = Vec::new();
        let mut prev = base;
        for &c in &cuts {
            suffix.push(c - prev);
            prev = c;
        }
        let tail = 79.830 - prev;
        if tail > 1e-3 {
            suffix.push(tail);
        }
        for d in &suffix {
            assert!(m.contains(&format!("#EXTINF:{d:.6},\n")), "missing suffix {d}\n{m}");
        }

        // Full count = prefix (start_idx) + suffix, contiguous seg_ numbering.
        let total_segs = start_idx as usize + suffix.len();
        assert_eq!(m.matches("#EXTINF:").count(), total_segs, "{m}");
        assert_eq!(m.matches("seg_").count(), total_segs, "{m}");
        for i in 0..total_segs {
            assert!(m.contains(&format!("seg_{i:05}.m4s\n")), "missing seg {i}\n{m}");
        }
        assert!(!m.contains(&format!("seg_{total_segs:05}")), "{m}");

        // Total EXTINF sum ≈ full duration (prefix + suffix span [0, total]).
        let sum: f64 = m
            .lines()
            .filter_map(|l| l.strip_prefix("#EXTINF:"))
            .filter_map(|s| s.strip_suffix(",").unwrap_or(s).parse::<f64>().ok())
            .sum();
        assert!((sum - 79.830).abs() < 1e-3, "sum {sum} != 79.830\n{m}");
    }

    #[test]
    fn copy_resume_targetduration_covers_longest_of_all_segments() {
        // At offset 50 the longest segment over ALL prefix+suffix is the from-0
        // prefix opener (11.511s), so TARGETDURATION must round up to 12 even
        // though the suffix's longest is only 9.760s. A TARGETDURATION below the
        // longest segment is spec-illegal and AVPlayer rejects the VOD.
        let m = synthesize_copy(GOOFY_KF, 79.830, 50, true).unwrap();
        assert!(m.contains("#EXT-X-TARGETDURATION:12\n"), "{m}");
    }

    #[test]
    fn copy_resume_past_last_boundary_clamps_to_full_timeline() {
        // An offset beyond the last segment boundary (80 > 77.911) anchors at the
        // LAST boundary (start_idx 11, base 77.911) rather than dying: the full
        // timeline still serves so the scrubber shows the whole title. base stays
        // strictly inside [0,total) so EXT-X-START is legal.
        let m = synthesize_copy(GOOFY_KF, 79.830, 80, true).unwrap();
        assert!(m.contains("#EXT-X-START:TIME-OFFSET=77.911000\n"), "{m}");
        // 11 prefix + 1 suffix (the [77.911, 79.830) tail) = 12 segments.
        assert_eq!(m.matches("#EXTINF:").count(), 12, "{m}");
    }
}
