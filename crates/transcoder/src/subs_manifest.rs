//! Subtitle rendition for NATIVE HLS clients (AVPlayer / AVKit).
//!
//! The web player attaches the pre-extracted sidecar `subtitles.vtt` as a
//! `<track>` element, but AVPlayer only renders subtitles it discovers INSIDE
//! the HLS manifest — a sidecar URL in the grant JSON is invisible to it, so
//! Apple clients never had a legible track to offer (the tvOS/iOS subtitle
//! pickers stayed empty). The fix: when a session has a sidecar subtitle and a
//! finite VOD media playlist, serve native clients a MASTER playlist that
//! advertises the SAME extracted WebVTT as a `TYPE=SUBTITLES` rendition:
//!
//! ```text
//! index.m3u8  → master: #EXT-X-MEDIA subs group + variant → media.m3u8
//! media.m3u8  → the synthesized VOD media playlist (crate::vod_manifest)
//! subs.m3u8   → single-entry VOD playlist → subtitles.vtt (whole file)
//! ```
//!
//! Both timelines cover the FULL title from 0 (the media playlist declares the
//! whole duration even on resume; the sidecar extraction never `-ss`-seeks), so
//! cue times align without an `X-TIMESTAMP-MAP`.
//!
//! Web (hls.js) never sees any of this — it keeps the proven EVENT playlist and
//! `<track>` sidecar byte-for-byte.

use crate::plan::SidecarSubtitle;

/// Filename the master gives the subtitle media playlist (synthesized by
/// [`subs_playlist`], served by `routes::session_segment`).
pub(crate) const SUBS_PLAYLIST_NAME: &str = "subs.m3u8";

/// The `#EXT-X-MEDIA` line advertising the sidecar as a subtitle rendition.
///
/// `NAME` is required; the probe's language tag doubles as the display name
/// when present (AVPlayer localizes from `LANGUAGE` anyway). `DEFAULT=NO` —
/// the app's own track-startup rules decide whether subtitles come on, not the
/// manifest. `FORCED` mirrors the chosen track so AVPlayer can auto-apply
/// forced narrative subs.
pub(crate) fn media_tag(subs: &SidecarSubtitle) -> String {
    let lang = subs.language.as_deref().unwrap_or("").trim();
    let name = if lang.is_empty() { "Subtitles" } else { lang };
    let language_attr = if lang.is_empty() {
        String::new()
    } else {
        format!("LANGUAGE=\"{lang}\",")
    };
    let forced = if subs.forced { "YES" } else { "NO" };
    format!(
        "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"{name}\",{language_attr}AUTOSELECT=YES,DEFAULT=NO,FORCED={forced},URI=\"{SUBS_PLAYLIST_NAME}\"\n"
    )
}

/// The subtitle MEDIA playlist: one segment — the whole sidecar VTT — spanning
/// the full title. AVPlayer fetches the file once and windows cues itself.
/// `None` mirrors `vod_manifest::synthesize` on an unusable duration.
pub(crate) fn subs_playlist(total_duration_secs: f64) -> Option<String> {
    if !total_duration_secs.is_finite() || total_duration_secs <= 0.0 {
        return None;
    }
    let target = total_duration_secs.ceil() as u64;
    Some(format!(
        "#EXTM3U\n\
         #EXT-X-VERSION:3\n\
         #EXT-X-TARGETDURATION:{target}\n\
         #EXT-X-MEDIA-SEQUENCE:0\n\
         #EXT-X-PLAYLIST-TYPE:VOD\n\
         #EXTINF:{total_duration_secs:.6},\n\
         {sidecar}\n\
         #EXT-X-ENDLIST\n",
        sidecar = crate::session::SIDECAR_SUBTITLE_NAME,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subs(lang: Option<&str>, forced: bool) -> SidecarSubtitle {
        SidecarSubtitle {
            source_index: 2,
            language: lang.map(str::to_string),
            forced,
        }
    }

    #[test]
    fn media_tag_carries_language_and_forced() {
        let tag = media_tag(&subs(Some("eng"), false));
        assert!(tag.contains("TYPE=SUBTITLES"));
        assert!(tag.contains("GROUP-ID=\"subs\""));
        assert!(tag.contains("NAME=\"eng\""));
        assert!(tag.contains("LANGUAGE=\"eng\""));
        assert!(tag.contains("FORCED=NO"));
        assert!(tag.contains(&format!("URI=\"{SUBS_PLAYLIST_NAME}\"")));
    }

    #[test]
    fn media_tag_unknown_language_still_named() {
        let tag = media_tag(&subs(None, true));
        assert!(tag.contains("NAME=\"Subtitles\""));
        assert!(!tag.contains("LANGUAGE="));
        assert!(tag.contains("FORCED=YES"));
    }

    #[test]
    fn subs_playlist_is_a_single_whole_file_vod_entry() {
        let p = subs_playlist(5401.5).expect("finite duration");
        assert!(p.contains("#EXT-X-TARGETDURATION:5402\n"));
        assert!(p.contains("#EXTINF:5401.500000,\n"));
        assert!(p.contains("subtitles.vtt\n"));
        assert!(p.ends_with("#EXT-X-ENDLIST\n"));
    }

    #[test]
    fn subs_playlist_rejects_unusable_durations() {
        assert!(subs_playlist(0.0).is_none());
        assert!(subs_playlist(-3.0).is_none());
        assert!(subs_playlist(f64::NAN).is_none());
    }
}
