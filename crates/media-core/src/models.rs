//! Shared data types: ffprobe results, track manifests, and `media.db`
//! row structs. These are the contract every module codes against — do
//! not change shapes without updating the schema + all consumers.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioTrack {
    pub index: i64,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub channels: Option<i64>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SubtitleTrack {
    pub index: i64,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub forced: bool,
}

/// Result of probing a single file with ffprobe. Serialized into the
/// `*_tracks_json` columns and the cached codec fields on `media_files`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileProbe {
    pub container: Option<String>,
    pub duration_secs: Option<i64>,
    pub video_codec: Option<String>,
    pub video_height: Option<i64>,
    pub video_profile: Option<String>,
    pub hdr_format: Option<String>,
    pub audio_tracks: Vec<AudioTrack>,
    pub subtitle_tracks: Vec<SubtitleTrack>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MediaFileRow {
    pub id: i64,
    pub path: String,
    pub size_bytes: i64,
    pub mtime: String,
    pub container: Option<String>,
    pub duration_secs: Option<i64>,
    pub video_codec: Option<String>,
    pub video_height: Option<i64>,
    pub video_profile: Option<String>,
    pub hdr_format: Option<String>,
    pub audio_tracks_json: String,
    pub subtitle_tracks_json: String,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct MovieRow {
    pub id: i64,
    pub tmdb_id: Option<i64>,
    pub imdb_id: Option<String>,
    pub title: String,
    pub year: Option<i64>,
    pub added_at: String,
    pub file_id: i64,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ShowRow {
    pub id: i64,
    pub tmdb_id: Option<i64>,
    pub tvdb_id: Option<i64>,
    pub title: String,
    pub year: Option<i64>,
    pub added_at: String,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct EpisodeRow {
    pub id: i64,
    pub show_id: i64,
    pub season: i64,
    pub episode: i64,
    pub title: Option<String>,
    pub air_date: Option<String>,
    pub file_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct WatchStateRow {
    pub sub: String,
    pub media_kind: String,
    pub media_id: i64,
    pub position_secs: i64,
    pub duration_secs: Option<i64>,
    pub watched_at: String,
    pub completed: i64,
}

impl MediaFileRow {
    /// Decode the audio track manifest.
    ///
    /// On malformed JSON this returns an empty `Vec` so a single corrupt row
    /// never aborts a request, but the corruption is logged via
    /// `tracing::warn!` (with the offending `media_files.id` and the parse
    /// error) so it is observable rather than silently swallowed. Empty audio
    /// tracks can flip the capability/transcode decision in `play_grant`, so
    /// a corrupt manifest must never look identical to a genuinely
    /// track-less file. Use [`MediaFileRow::audio_tracks_checked`] when the
    /// caller needs to distinguish corruption from a real empty manifest.
    pub fn audio_tracks(&self) -> Vec<AudioTrack> {
        self.audio_tracks_checked().0
    }

    /// Decode the subtitle track manifest.
    ///
    /// Same corruption-logging contract as [`MediaFileRow::audio_tracks`]:
    /// malformed JSON yields an empty `Vec` plus a `tracing::warn!` carrying
    /// the `media_files.id` and parse error. Use
    /// [`MediaFileRow::subtitle_tracks_checked`] to detect corruption.
    pub fn subtitle_tracks(&self) -> Vec<SubtitleTrack> {
        self.subtitle_tracks_checked().0
    }

    /// Decode the audio track manifest, surfacing whether the stored JSON was
    /// corrupt. Returns `(tracks, metadata_corrupt)` where `metadata_corrupt`
    /// is `true` iff the JSON failed to parse (in which case `tracks` is
    /// empty and a `tracing::warn!` has already been emitted).
    pub fn audio_tracks_checked(&self) -> (Vec<AudioTrack>, bool) {
        match serde_json::from_str(&self.audio_tracks_json) {
            Ok(tracks) => (tracks, false),
            Err(e) => {
                tracing::warn!(
                    media_file_id = %self.id,
                    error = %e,
                    "corrupt audio_tracks_json; serving empty audio track list"
                );
                (Vec::new(), true)
            }
        }
    }

    /// Decode the subtitle track manifest, surfacing whether the stored JSON
    /// was corrupt. Returns `(tracks, metadata_corrupt)`; see
    /// [`MediaFileRow::audio_tracks_checked`] for the contract.
    pub fn subtitle_tracks_checked(&self) -> (Vec<SubtitleTrack>, bool) {
        match serde_json::from_str(&self.subtitle_tracks_json) {
            Ok(tracks) => (tracks, false),
            Err(e) => {
                tracing::warn!(
                    media_file_id = %self.id,
                    error = %e,
                    "corrupt subtitle_tracks_json; serving empty subtitle track list"
                );
                (Vec::new(), true)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_with(audio_json: &str, subtitle_json: &str) -> MediaFileRow {
        MediaFileRow {
            id: 42,
            path: "/library/movie.mkv".to_string(),
            size_bytes: 1,
            mtime: "0".to_string(),
            container: None,
            duration_secs: None,
            video_codec: None,
            video_height: None,
            video_profile: None,
            hdr_format: None,
            audio_tracks_json: audio_json.to_string(),
            subtitle_tracks_json: subtitle_json.to_string(),
            scanned_at: "0".to_string(),
        }
    }

    #[test]
    fn valid_audio_json_round_trips() {
        let json = r#"[{"index":0,"codec":"aac","channels":6,"language":"eng","title":null}]"#;
        let row = row_with(json, "[]");
        let (tracks, corrupt) = row.audio_tracks_checked();
        assert!(!corrupt, "valid JSON must not be flagged corrupt");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].index, 0);
        assert_eq!(tracks[0].codec.as_deref(), Some("aac"));
        assert_eq!(tracks[0].channels, Some(6));
        // The convenience accessor must agree with the checked variant.
        assert_eq!(row.audio_tracks(), tracks);
    }

    #[test]
    fn valid_subtitle_json_round_trips() {
        let json = r#"[{"index":2,"codec":"subrip","language":"eng","title":null,"forced":true}]"#;
        let row = row_with("[]", json);
        let (tracks, corrupt) = row.subtitle_tracks_checked();
        assert!(!corrupt);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].index, 2);
        assert!(tracks[0].forced);
        assert_eq!(row.subtitle_tracks(), tracks);
    }

    #[test]
    fn empty_array_is_not_corrupt() {
        // A genuinely track-less file stores "[]" and must NOT be flagged as
        // corrupt — only a parse failure sets metadata_corrupt.
        let row = row_with("[]", "[]");
        let (audio, audio_corrupt) = row.audio_tracks_checked();
        let (subs, subs_corrupt) = row.subtitle_tracks_checked();
        assert!(audio.is_empty());
        assert!(subs.is_empty());
        assert!(!audio_corrupt);
        assert!(!subs_corrupt);
    }

    #[test]
    fn corrupt_audio_json_is_flagged_and_defaults_empty() {
        // Truncated / malformed JSON must not panic, must return empty, and
        // must set metadata_corrupt = true (warn is emitted as a side effect).
        let row = row_with("{not valid json", "[]");
        let (tracks, corrupt) = row.audio_tracks_checked();
        assert!(tracks.is_empty());
        assert!(corrupt, "malformed audio JSON must flag corruption");
        // Convenience accessor still defaults to empty without panicking.
        assert!(row.audio_tracks().is_empty());
    }

    #[test]
    fn corrupt_subtitle_json_is_flagged_and_defaults_empty() {
        let row = row_with("[]", "[[[broken");
        let (tracks, corrupt) = row.subtitle_tracks_checked();
        assert!(tracks.is_empty());
        assert!(corrupt, "malformed subtitle JSON must flag corruption");
        assert!(row.subtitle_tracks().is_empty());
    }

    #[test]
    fn wrong_shape_json_is_flagged_corrupt() {
        // Well-formed JSON of the wrong shape (object instead of array) also
        // fails to deserialize into Vec<AudioTrack> and must be flagged.
        let row = row_with(r#"{"index":0}"#, r#"{"index":0}"#);
        assert!(row.audio_tracks_checked().1);
        assert!(row.subtitle_tracks_checked().1);
    }
}
