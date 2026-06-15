//! Synthetic VOD playlist for native HLS clients (AVPlayer / AVKit).
//!
//! AVKit renders a "LIVE" badge, a wall-clock readout, and a live-edge scrubber
//! whenever the HLS playlist has no `#EXT-X-ENDLIST` — i.e. an indefinite
//! duration. That is exactly how the on-demand transcoder's growing `EVENT`
//! playlist looks until encoding finishes, so a movie plays as if it were live
//! and cannot be scrubbed. hls.js (the web player) handles `EVENT` fine, but a
//! native player needs a finite VOD timeline up front.
//!
//! The source duration is known at grant time and the encoder forces a keyframe
//! on every `HLS_SEGMENT_SECS` boundary, so the segment count is deterministic:
//! `ceil(remaining / HLS_SEGMENT_SECS)`. That lets us emit a COMPLETE VOD
//! playlist — full segment list + `#EXT-X-ENDLIST` — before a single segment
//! exists. The native player gets a real scrubber immediately; segments are
//! served on demand as the (faster-than-realtime) encoder produces them, with a
//! short wait-for-segment in `routes::session_segment` covering the frontier.
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
}
