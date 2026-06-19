//! Synthesise an HLS master + two media playlists (video + audio) from the
//! adaptive `StreamRef` pair that `resolve()` returns when YouTube's iOS client
//! doesn't surface a ready-made HLS manifest.
//!
//! The output is a set of *string* manifests — no extra I/O, no async. The
//! caller is responsible for serving them (in-process or via a sidecar route).
//!
//! # Format choice
//! HLS version 3 is the lowest common denominator that AVPlayer + hls.js both
//! accept. The master carries a single video rendition plus an `EXT-X-MEDIA`
//! audio rendition with GROUP-ID "aud"; the video playlist is a single-segment
//! VOD where the "segment" is the full direct-download URL that YouTube already
//! gave us. This is technically correct HLS — the spec allows a segment to be
//! an https:// URL — and AVPlayer handles it natively.

use crate::{Resolved, StreamRef};

/// The three playlist strings that together form one complete HLS presentation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlsBundle {
    /// Master playlist (`master.m3u8`). References `video_pl_name` and
    /// `audio_pl_name` as given to [`build_hls`].
    pub master: String,
    /// Single-segment VOD playlist for the video stream (`video.m3u8`).
    pub video: String,
    /// Single-segment VOD playlist for the audio stream (`audio.m3u8`).
    pub audio: String,
}

/// Build a three-playlist HLS bundle from a resolved adaptive pair.
///
/// Returns `None` when either `resolved.video` or `resolved.audio` is absent
/// (the caller should fall back to `resolved.progressive` or the yt-dlp path).
///
/// `video_pl_name` and `audio_pl_name` are the URI strings embedded in the
/// master playlist (e.g. `"video.m3u8"` / `"audio.m3u8"` for local serving,
/// or full URLs for a redirect-to-googlevideo approach).
pub fn build_hls(
    resolved: &Resolved,
    video_pl_name: &str,
    audio_pl_name: &str,
) -> Option<HlsBundle> {
    let video_ref: &StreamRef = resolved.video.as_ref()?;
    let audio_ref: &StreamRef = resolved.audio.as_ref()?;

    // Duration in seconds for EXTINF / TARGETDURATION.  Fall back to a
    // conservative 600 s (10 min) so the playlist is structurally valid even
    // without `videoDetails.lengthSeconds`.
    let dur_secs = resolved.duration_secs.unwrap_or(600);
    // TARGETDURATION must be >= the actual segment duration (RFC 8216 §4.3.3.1).
    let target_dur = dur_secs;

    // BANDWIDTH is required in #EXT-X-STREAM-INF.  Use the stored bitrate when
    // available; otherwise fall back to a 2 Mbit/s default that brackets a
    // typical 720p stream without over-estimating 1080p.
    let bandwidth = video_ref.bitrate.unwrap_or(2_000_000);

    // RESOLUTION requires width × height. YouTube's StreamRef carries height
    // but not width; derive width from a 16:9 assumption (most trailers are
    // widescreen). Round to the nearest even pixel for codec alignment.
    let height = video_ref.height.unwrap_or(720);
    let width = (height * 16 / 9) & !1; // nearest even
    let resolution = format!("{width}x{height}");

    // ---- MASTER PLAYLIST ----
    // CODECS string targets the most common YouTube adaptive pair:
    //   avc1.64001f = H.264 High 3.1 (covers 480p–720p safely; 1080p is 4.0+
    //                  but this signals "I can do at least H.264" to the player,
    //                  which matters more than the exact profile level here)
    //   mp4a.40.2   = AAC-LC (the only audio codec YouTube reliably offers on
    //                  the iOS Innertube path we use)
    let master = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"{audio_pl_name}\"\n\
         #EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={resolution},CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"aud\"\n\
         {video_pl_name}\n"
    );

    // ---- VIDEO MEDIA PLAYLIST ----
    let video = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-PLAYLIST-TYPE:VOD\n\
         #EXT-X-TARGETDURATION:{target_dur}\n\
         #EXTINF:{dur_secs:.3},\n\
         {video_url}\n\
         #EXT-X-ENDLIST\n",
        video_url = video_ref.url,
    );

    // ---- AUDIO MEDIA PLAYLIST ----
    let audio = format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-PLAYLIST-TYPE:VOD\n\
         #EXT-X-TARGETDURATION:{target_dur}\n\
         #EXTINF:{dur_secs:.3},\n\
         {audio_url}\n\
         #EXT-X-ENDLIST\n",
        audio_url = audio_ref.url,
    );

    Some(HlsBundle { master, video, audio })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StreamRef;

    fn dummy_resolved(with_video: bool, with_audio: bool) -> Resolved {
        Resolved {
            video_id: "dQw4w9WgXcQ".to_string(),
            hls: None,
            progressive: None,
            video: with_video.then(|| StreamRef {
                url: "https://v.googlevideo.com/videofile".to_string(),
                mime: "video/mp4; codecs=\"avc1.640028\"".to_string(),
                height: Some(1080),
                bitrate: Some(4_500_000),
            }),
            audio: with_audio.then(|| StreamRef {
                url: "https://r4.googlevideo.com/audiofile".to_string(),
                mime: "audio/mp4; codecs=\"mp4a.40.2\"".to_string(),
                height: None,
                bitrate: Some(128_000),
            }),
            duration_secs: Some(212),
        }
    }

    #[test]
    fn returns_none_when_video_missing() {
        let r = dummy_resolved(false, true);
        assert!(build_hls(&r, "video.m3u8", "audio.m3u8").is_none());
    }

    #[test]
    fn returns_none_when_audio_missing() {
        let r = dummy_resolved(true, false);
        assert!(build_hls(&r, "video.m3u8", "audio.m3u8").is_none());
    }

    #[test]
    fn returns_none_when_both_missing() {
        let r = dummy_resolved(false, false);
        assert!(build_hls(&r, "video.m3u8", "audio.m3u8").is_none());
    }

    #[test]
    fn master_has_audio_media_tag_and_audio_group_reference() {
        let r = dummy_resolved(true, true);
        let bundle = build_hls(&r, "video.m3u8", "audio.m3u8").unwrap();

        // Required EXT-X-MEDIA line for the audio rendition group.
        assert!(
            bundle.master.contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\""),
            "master missing #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\"\n---\n{}", bundle.master
        );
        // STREAM-INF must reference the same group.
        assert!(
            bundle.master.contains("AUDIO=\"aud\""),
            "master STREAM-INF missing AUDIO=\"aud\"\n---\n{}", bundle.master
        );
    }

    #[test]
    fn master_contains_stream_inf_with_bandwidth_and_resolution() {
        let r = dummy_resolved(true, true);
        let bundle = build_hls(&r, "video.m3u8", "audio.m3u8").unwrap();

        assert!(bundle.master.contains("BANDWIDTH=4500000"), "expected BANDWIDTH=4500000\n---\n{}", bundle.master);
        // 1080p → 1920 (nearest even of 1080*16/9=1920) × 1080
        assert!(bundle.master.contains("RESOLUTION=1920x1080"), "expected RESOLUTION=1920x1080\n---\n{}", bundle.master);
        // Named playlist references in the master.
        assert!(bundle.master.contains("video.m3u8"), "master must reference video.m3u8");
        assert!(bundle.master.contains("audio.m3u8"), "master must reference audio.m3u8 (in EXT-X-MEDIA URI)");
    }

    #[test]
    fn video_playlist_contains_url_and_extinf_with_duration() {
        let r = dummy_resolved(true, true);
        let bundle = build_hls(&r, "video.m3u8", "audio.m3u8").unwrap();

        assert!(
            bundle.video.contains("https://v.googlevideo.com/videofile"),
            "video playlist missing video URL\n---\n{}", bundle.video
        );
        // EXTINF must carry the duration (212 s from the fixture).
        assert!(
            bundle.video.contains("#EXTINF:212"),
            "video playlist missing #EXTINF:212\n---\n{}", bundle.video
        );
        assert!(bundle.video.contains("#EXT-X-ENDLIST"), "video playlist missing #EXT-X-ENDLIST");
        assert!(bundle.video.contains("#EXT-X-PLAYLIST-TYPE:VOD"), "video playlist missing VOD type");
    }

    #[test]
    fn audio_playlist_contains_audio_url_and_extinf() {
        let r = dummy_resolved(true, true);
        let bundle = build_hls(&r, "video.m3u8", "audio.m3u8").unwrap();

        assert!(
            bundle.audio.contains("https://r4.googlevideo.com/audiofile"),
            "audio playlist missing audio URL\n---\n{}", bundle.audio
        );
        assert!(
            bundle.audio.contains("#EXTINF:212"),
            "audio playlist missing #EXTINF:212\n---\n{}", bundle.audio
        );
        assert!(bundle.audio.contains("#EXT-X-ENDLIST"), "audio playlist missing #EXT-X-ENDLIST");
    }

    #[test]
    fn falls_back_to_defaults_when_bitrate_height_duration_absent() {
        let r = Resolved {
            video_id: "test1234567".to_string(),
            hls: None,
            progressive: None,
            video: Some(StreamRef {
                url: "https://v/no-meta".to_string(),
                mime: "video/mp4".to_string(),
                height: None,
                bitrate: None,
            }),
            audio: Some(StreamRef {
                url: "https://a/no-meta".to_string(),
                mime: "audio/mp4".to_string(),
                height: None,
                bitrate: None,
            }),
            duration_secs: None,
        };
        let bundle = build_hls(&r, "v.m3u8", "a.m3u8").unwrap();

        // 720p default resolution: 1280×720
        assert!(bundle.master.contains("RESOLUTION=1280x720"), "expected default RESOLUTION=1280x720\n---\n{}", bundle.master);
        assert!(bundle.master.contains("BANDWIDTH=2000000"), "expected default BANDWIDTH=2000000\n---\n{}", bundle.master);
        // 600s fallback duration
        assert!(bundle.video.contains("#EXTINF:600"), "expected fallback #EXTINF:600\n---\n{}", bundle.video);
    }

    #[test]
    fn custom_playlist_names_appear_in_master() {
        let r = dummy_resolved(true, true);
        let bundle = build_hls(&r, "/trailer/dQw4w9WgXcQ/video.m3u8", "/trailer/dQw4w9WgXcQ/audio.m3u8").unwrap();

        assert!(bundle.master.contains("/trailer/dQw4w9WgXcQ/video.m3u8"));
        assert!(bundle.master.contains("/trailer/dQw4w9WgXcQ/audio.m3u8"));
    }
}
