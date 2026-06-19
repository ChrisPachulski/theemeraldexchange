//! Native YouTube stream resolver for trailer/extras playback.
//!
//! tvOS has no WebKit, so it can't embed the YouTube player — it needs a
//! directly-playable URL. yt-dlp does this by shelling out to a Python process
//! that, in the general case, executes YouTube's obfuscated player JS to solve
//! the signature cipher + `n` throttle param. We don't need any of that for our
//! use case: the **iOS Innertube `player` client** returns stream URLs that are
//! already signed (no cipher, no nsig) and, for public videos, needs no PoToken.
//! That is the entire reason this can be ~200 lines of Rust instead of a JS
//! engine — and it's the same client yt-dlp itself defaults to.
//!
//! We extract structured stream refs; *delivery* (HLS passthrough vs. a
//! synthesized multi-rendition manifest) is the caller's job. The yt-dlp
//! subprocess stays wired as the long-tail fallback for the cases the iOS client
//! can't serve (age-gated, region-locked, login-required).
//!
//! ponytail: serde_json::Value over hand-modeling YouTube's enormous player
//! response — we read five fields out of it, defining structs for the rest is
//! pure liability against a schema we don't control.

pub mod manifest;
pub use manifest::{build_hls, HlsBundle};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const PLAYER_ENDPOINT: &str =
    "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false";

/// Embedded at compile time; the weekly canary edits the file, not this source.
const CLIENTS_JSON: &str = include_str!("../clients.json");

/// A YouTube video id is exactly 11 chars of the URL-safe base64 alphabet. This
/// is the injection guard: every value that reaches the network or a manifest
/// must pass this first.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Rot-prone Innertube client identity, loaded from `clients.json`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub client_name: String,
    pub client_version: String,
    pub device_make: String,
    pub device_model: String,
    pub os_name: String,
    pub os_version: String,
    pub user_agent: String,
    pub client_name_id: String,
}

/// The iOS client config from the embedded `clients.json`. Sibling keys (e.g. a
/// leading `_comment`) are ignored — we pull just the `ios` object.
pub fn ios_client() -> ClientConfig {
    let root: Value =
        serde_json::from_str(CLIENTS_JSON).expect("clients.json is valid JSON");
    serde_json::from_value(root["ios"].clone()).expect("clients.json has a valid `ios` entry")
}

/// One direct (already-signed) stream URL plus the bits the caller needs to rank
/// or build a manifest line.
#[derive(Debug, Clone, Serialize)]
pub struct StreamRef {
    pub url: String,
    pub mime: String,
    pub height: Option<u64>,
    pub bitrate: Option<u64>,
}

/// Everything the delivery layer might use, in preference order: an HLS master
/// (AVPlayer plays it as-is) is best when present; a progressive muxed file is
/// next; otherwise the caller muxes/wraps `video` + `audio` (both direct URLs).
#[derive(Debug, Clone, Serialize)]
pub struct Resolved {
    pub video_id: String,
    pub hls: Option<String>,
    pub progressive: Option<String>,
    pub video: Option<StreamRef>,
    pub audio: Option<StreamRef>,
    pub duration_secs: Option<u64>,
}

#[derive(Debug)]
pub enum ResolveError {
    InvalidId,
    /// playabilityStatus.status != OK (e.g. LOGIN_REQUIRED, UNPLAYABLE, ERROR).
    NotPlayable(String),
    /// OK but no usable stream we can deliver (no hls / progressive / direct
    /// adaptive pair) — hand off to the yt-dlp fallback.
    NoStream,
    Http(reqwest::Error),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::InvalidId => write!(f, "invalid video id"),
            ResolveError::NotPlayable(s) => write!(f, "not playable: {s}"),
            ResolveError::NoStream => write!(f, "no deliverable stream"),
            ResolveError::Http(e) => write!(f, "http: {e}"),
        }
    }
}
impl std::error::Error for ResolveError {}
impl From<reqwest::Error> for ResolveError {
    fn from(e: reqwest::Error) -> Self {
        ResolveError::Http(e)
    }
}

/// Resolve a video id to deliverable stream refs via the iOS Innertube client.
pub async fn resolve(
    id: &str,
    client: &reqwest::Client,
    cfg: &ClientConfig,
) -> Result<Resolved, ResolveError> {
    if !is_valid_id(id) {
        return Err(ResolveError::InvalidId);
    }

    let body = json!({
        "context": { "client": {
            "clientName": cfg.client_name,
            "clientVersion": cfg.client_version,
            "deviceMake": cfg.device_make,
            "deviceModel": cfg.device_model,
            "osName": cfg.os_name,
            "osVersion": cfg.os_version,
            "hl": "en",
            "gl": "US",
        }},
        "videoId": id,
        // Don't get blocked on "are you sure" / mild-content interstitials.
        "contentCheckOk": true,
        "racyCheckOk": true,
    });

    let v: Value = client
        .post(PLAYER_ENDPOINT)
        .header("User-Agent", &cfg.user_agent)
        .header("X-YouTube-Client-Name", &cfg.client_name_id)
        .header("X-YouTube-Client-Version", &cfg.client_version)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?
        .json()
        .await?;

    parse_player_response(id, &v)
}

/// Pure extraction from a player response — split out so it's testable against a
/// captured fixture without a live network call.
pub fn parse_player_response(id: &str, v: &Value) -> Result<Resolved, ResolveError> {
    let status = v["playabilityStatus"]["status"].as_str().unwrap_or("");
    if status != "OK" {
        return Err(ResolveError::NotPlayable(status.to_string()));
    }

    let sd = &v["streamingData"];
    let hls = sd["hlsManifestUrl"].as_str().map(str::to_string);
    let duration_secs = v["videoDetails"]["lengthSeconds"]
        .as_str()
        .and_then(|s| s.parse().ok());

    let progressive = best_progressive(sd["formats"].as_array());
    let video = best_stream(sd["adaptiveFormats"].as_array(), "video/mp4", "avc1");
    let audio = best_stream(sd["adaptiveFormats"].as_array(), "audio/mp4", "mp4a");

    if hls.is_none() && progressive.is_none() && (video.is_none() || audio.is_none()) {
        return Err(ResolveError::NoStream);
    }

    Ok(Resolved {
        video_id: id.to_string(),
        hls,
        progressive,
        video,
        audio,
        duration_secs,
    })
}

fn as_stream(f: &Value) -> Option<StreamRef> {
    // Only direct (pre-signed) URLs — a `signatureCipher`-only format would need
    // the JS engine we deliberately don't have, so skip it (fallback territory).
    let url = f["url"].as_str()?.to_string();
    let mime = f["mimeType"].as_str().unwrap_or("").to_string();
    Some(StreamRef {
        url,
        mime,
        height: f["height"].as_u64(),
        bitrate: f["bitrate"].as_u64(),
    })
}

/// Best progressive (muxed) mp4 with a direct URL, by height. Rare on modern
/// YouTube but free to support and ideal (single file, AVPlayer-native).
fn best_progressive(formats: Option<&Vec<Value>>) -> Option<String> {
    formats?
        .iter()
        .filter(|f| {
            let m = f["mimeType"].as_str().unwrap_or("");
            f["url"].is_string() && m.contains("video/mp4") && m.contains("avc1") && m.contains("mp4a")
        })
        .max_by_key(|f| f["height"].as_u64().unwrap_or(0))
        .and_then(|f| f["url"].as_str().map(str::to_string))
}

/// Best adaptive stream whose mimeType contains both `mime` (container/type) and
/// `codec` (AVPlayer-safe: avc1 / mp4a), ranked by height then bitrate. Capped at
/// 1080p — a trailer doesn't need 4K and it keeps the manifest light.
fn best_stream(formats: Option<&Vec<Value>>, mime: &str, codec: &str) -> Option<StreamRef> {
    formats?
        .iter()
        .filter(|f| {
            let m = f["mimeType"].as_str().unwrap_or("");
            f["url"].is_string()
                && m.contains(mime)
                && m.contains(codec)
                && f["height"].as_u64().unwrap_or(0) <= 1080
        })
        .max_by_key(|f| (f["height"].as_u64().unwrap_or(0), f["bitrate"].as_u64().unwrap_or(0)))
        .and_then(as_stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_validation() {
        assert!(is_valid_id("dQw4w9WgXcQ"));
        assert!(is_valid_id("aqz-KE-bpKQ"));
        assert!(is_valid_id("_-_-_-_-_-_"));
        assert!(!is_valid_id("too-short"));
        assert!(!is_valid_id("waytoolongforanid"));
        assert!(!is_valid_id("has space!!!"));
        assert!(!is_valid_id("inject;rm -rf"));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn not_ok_status_is_error() {
        let v = json!({ "playabilityStatus": { "status": "LOGIN_REQUIRED" } });
        assert!(matches!(
            parse_player_response("dQw4w9WgXcQ", &v),
            Err(ResolveError::NotPlayable(s)) if s == "LOGIN_REQUIRED"
        ));
    }

    #[test]
    fn picks_hls_and_best_adaptive_pair() {
        // Mirrors the real iOS shape: no progressive, split adaptive, an HLS url.
        let v = json!({
            "playabilityStatus": { "status": "OK" },
            "videoDetails": { "lengthSeconds": "212" },
            "streamingData": {
                "hlsManifestUrl": "https://manifest.googlevideo.com/hls/x",
                "formats": [],
                "adaptiveFormats": [
                    { "mimeType": "video/mp4; codecs=\"avc1.640028\"", "url": "https://v/1080", "height": 1080, "bitrate": 4000000 },
                    { "mimeType": "video/mp4; codecs=\"avc1.4d401f\"", "url": "https://v/720", "height": 720, "bitrate": 2000000 },
                    { "mimeType": "video/webm; codecs=\"vp9\"", "url": "https://v/vp9", "height": 2160, "bitrate": 9000000 },
                    { "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "url": "https://a/128", "bitrate": 128000 },
                    { "mimeType": "audio/webm; codecs=\"opus\"", "url": "https://a/opus", "bitrate": 160000 }
                ]
            }
        });
        let r = parse_player_response("dQw4w9WgXcQ", &v).unwrap();
        assert_eq!(r.hls.as_deref(), Some("https://manifest.googlevideo.com/hls/x"));
        assert_eq!(r.duration_secs, Some(212));
        // 1080 avc1 over the 2160 vp9 (codec filter) and over 720.
        assert_eq!(r.video.unwrap().url, "https://v/1080");
        // mp4a over opus.
        assert_eq!(r.audio.unwrap().url, "https://a/128");
    }

    #[test]
    fn no_usable_stream_is_nostream() {
        let v = json!({
            "playabilityStatus": { "status": "OK" },
            "streamingData": {
                "formats": [],
                "adaptiveFormats": [
                    // cipher-only video (no direct url) + opus-only audio -> unusable
                    { "mimeType": "video/mp4; codecs=\"avc1\"", "signatureCipher": "s=..&url=.." },
                    { "mimeType": "audio/webm; codecs=\"opus\"", "url": "https://a/opus" }
                ]
            }
        });
        assert!(matches!(
            parse_player_response("dQw4w9WgXcQ", &v),
            Err(ResolveError::NoStream)
        ));
    }
}
