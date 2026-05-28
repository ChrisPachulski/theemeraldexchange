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
    /// Decode the audio track manifest, tolerating malformed JSON (empty).
    pub fn audio_tracks(&self) -> Vec<AudioTrack> {
        serde_json::from_str(&self.audio_tracks_json).unwrap_or_default()
    }

    /// Decode the subtitle track manifest, tolerating malformed JSON (empty).
    pub fn subtitle_tracks(&self) -> Vec<SubtitleTrack> {
        serde_json::from_str(&self.subtitle_tracks_json).unwrap_or_default()
    }
}
