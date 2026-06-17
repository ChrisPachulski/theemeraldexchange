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
    let remaining = total_duration_secs - start_secs as f64;
    if remaining <= 0.0 {
        return None;
    }
    let count = (remaining / seg).ceil() as u64;
    if count == 0 {
        return None;
    }

    let ext = if fmp4 { "m4s" } else { "ts" };
    // fMP4 needs `#EXT-X-MAP`, which requires HLS v7; plain TS rides v3.
    let version = if fmp4 { 7 } else { 3 };

    let mut m = String::with_capacity(96 + count as usize * 28);
    m.push_str("#EXTM3U\n");
    m.push_str(&format!("#EXT-X-VERSION:{version}\n"));
    m.push_str(&format!("#EXT-X-TARGETDURATION:{HLS_SEGMENT_SECS}\n"));
    m.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
    m.push_str("#EXT-X-PLAYLIST-TYPE:VOD\n");
    if fmp4 {
        m.push_str("#EXT-X-MAP:URI=\"init.mp4\"\n");
    }
    for i in 0..count {
        // Every segment is HLS_SEGMENT_SECS long except the last, which carries
        // the remainder. The encoder's forced keyframes anchor each cut to an
        // absolute multiple of HLS_SEGMENT_SECS, so on-disk segments line up
        // with this list one-for-one.
        let dur = if i + 1 == count {
            remaining - seg * (count - 1) as f64
        } else {
            seg
        };
        m.push_str(&format!("#EXTINF:{dur:.6},\n"));
        m.push_str(&format!("seg_{i:05}.{ext}\n"));
    }
    m.push_str("#EXT-X-ENDLIST\n");
    Some(m)
}

/// Compute the copy-remux segment CUT POINTS (presentation times, in the output
/// timeline) from the source video keyframe PTS list, reproducing ffmpeg's HLS
/// stream-copy segmenter exactly.
///
/// ffmpeg with `-c copy -hls_time T` cannot insert keyframes, so it cuts a new
/// segment at the first KEYFRAME whose pts has reached the running target. The
/// target starts at `T` and, after each cut at `p`, jumps to the next multiple
/// of `T` strictly past `p` (`(floor(p/T)+1)*T`) — so segments are ~`T` but snap
/// to the source's (irregular, scene-cut) keyframes and the boundaries never
/// drift off the absolute `T` grid. Verified to match ffmpeg byte-for-byte on a
/// real HEVC BluRay rip (see `golden_boundaries_match_real_ffmpeg`).
///
/// `keyframes` are absolute source PTS (seconds); `base` is where copy begins
/// (the keyframe `-ss` seeks to — 0 for a fresh start); `total_abs` is the full
/// source duration. Returned cut points are ABSOLUTE source PTS, in
/// `(base, total_abs)`.
///
/// IMPORTANT: the `target` grid is on the ABSOLUTE source timeline (multiples of
/// `hls_time`), NOT rebased to `base`. ffmpeg keeps the original packet PTS when
/// segmenting a `-ss`-seeked copy, so a rebased grid picks the wrong keyframes
/// once `base` is not a multiple of `hls_time` (verified against `ffmpeg -ss 600
/// -c copy` on the NAS: a rebased grid diverged after ~5 segments). For a fresh
/// start (`base == 0`) the two grids coincide.
fn copy_cut_points(keyframes: &[f64], base: f64, total_abs: f64, hls_time: f64) -> Vec<f64> {
    let mut cuts = Vec::new();
    // First boundary target: the first multiple of hls_time strictly past base.
    let mut target = ((base / hls_time).floor() + 1.0) * hls_time;
    for &p in keyframes {
        if p <= base {
            continue; // the seek keyframe itself starts segment 0, never a cut
        }
        if p >= total_abs {
            break; // a keyframe at/after EOF never opens another segment
        }
        if p >= target {
            cuts.push(p);
            target = ((p / hls_time).floor() + 1.0) * hls_time;
        }
    }
    cuts
}

/// Build a complete VOD playlist for a COPY-remux session from the source's
/// keyframe list — the analogue of [`synthesize`] for sessions that do NOT
/// re-encode (HEVC→fMP4 / H264→TS), whose segments are cut at the source's own
/// ragged keyframes and so cannot be derived from the duration alone.
///
/// `keyframes` is the full source video keyframe PTS list (absolute seconds,
/// ascending). Only a FRESH start is synthesized (`start_secs` at/before the
/// first keyframe → output begins at 0); a real resume returns `None` (see the
/// `base > 0` guard below) so the caller serves the on-disk playlist, because
/// ffmpeg's `-ss` stream-copy segmentation is not reliably predictable.
///
/// Returns `None` (→ caller falls back to the on-disk playlist) when the
/// duration is unusable, the keyframe list is empty, the resume offset is past
/// the first keyframe, or the span is empty. Unlike [`synthesize`],
/// `#EXT-X-TARGETDURATION` is computed from the LONGEST segment (copy segments
/// can be ~5× `HLS_SEGMENT_SECS` between sparse keyframes), since a too-small
/// TARGETDURATION makes AVPlayer reject the VOD.
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
    let start = start_secs as f64;
    // -ss before -i seeks to the keyframe AT OR BEFORE the offset; the output
    // re-bases time so that keyframe is t=0. (Fresh start → base 0.)
    let base = keyframes
        .iter()
        .copied()
        .filter(|&k| k <= start)
        .fold(0.0, f64::max);
    // Resume past the first keyframe (`base > 0`): ffmpeg's `-ss` stream-copy
    // rebases output timestamps in a way that does NOT follow the simple
    // absolute/relative `hls_time` grid (verified on the NAS: synthesis diverged
    // from real `-ss 600`/`-ss 1234` output after a few segments). A mismatched
    // manifest is a `CoreMediaErrorDomain -4`, so we DECLINE to synthesize for a
    // real resume and let the caller serve the on-disk playlist instead — no
    // worse than today, and never a crash. A fresh play (`base == 0`, including a
    // seek that lands within the first GOP) is exact and gets the scrubber.
    if base > 0.0 {
        return None;
    }
    if total_duration_secs - base <= 0.0 {
        return None;
    }

    let cuts = copy_cut_points(keyframes, base, total_duration_secs, hls);

    // Absolute cut PTS → per-segment durations, the first measured from `base`:
    // [base,c0),[c0,c1),…,[c_last,total_duration).
    let mut durs = Vec::with_capacity(cuts.len() + 1);
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
    if fmp4 {
        m.push_str("#EXT-X-MAP:URI=\"init.mp4\"\n");
    }
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
    fn start_at_or_past_end_yields_none() {
        assert!(synthesize(100.0, 100, false).is_none());
        assert!(synthesize(100.0, 200, false).is_none());
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
    fn resume_offset_shortens_the_timeline() {
        // duration 20s, resume at 10s -> 10s remaining -> 5 segments from 0.
        let m = synthesize(20.0, 10, false).unwrap();
        assert_eq!(m.matches("#EXTINF:").count(), 5);
        assert!(m.contains("seg_00000.ts\n"));
        assert!(!m.contains("seg_00005"));
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
        0.000, 1.084, 11.511, 13.347, 23.774, 25.943, 36.370, 46.797, 55.722,
        59.601, 69.361, 74.157, 77.911, 79.830,
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
    fn copy_resume_past_first_keyframe_declines_to_synthesize() {
        // A real resume (-ss 30 → seek keyframe 25.943, base>0) is NOT reliably
        // predictable for stream-copy, so synthesis DECLINES (caller serves the
        // on-disk playlist) rather than risk a CoreMediaErrorDomain -4.
        assert!(synthesize_copy(GOOFY_KF, 79.830, 30, true).is_none());
    }

    #[test]
    fn copy_seek_within_first_gop_is_still_a_fresh_synthesis() {
        // A tiny offset that lands at/before the first keyframe (base==0) is
        // output-equivalent to a fresh start, so it still synthesizes.
        let m = synthesize_copy(GOOFY_KF, 79.830, 1, true).unwrap();
        assert!(m.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert!(m.contains("#EXTINF:11.511000,\n"), "{m}");
    }

    #[test]
    fn copy_empty_keyframes_or_bad_duration_yields_none() {
        assert!(synthesize_copy(&[], 100.0, 0, true).is_none());
        assert!(synthesize_copy(GOOFY_KF, 0.0, 0, true).is_none());
        assert!(synthesize_copy(GOOFY_KF, -1.0, 0, true).is_none());
        // Resume at/after the end → nothing to play.
        assert!(synthesize_copy(GOOFY_KF, 79.830, 80, true).is_none());
    }
}
