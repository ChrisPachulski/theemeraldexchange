//! Web-client player fetching for the signature-cipher path.
//!
//! Two jobs:
//!   1. Find + fetch + cache YouTube's player `base.js` (the obfuscated JS whose
//!      sig/nsig functions `cipher.rs` extracts).
//!   2. Get the web player response (`streamingData` with `signatureCipher`
//!      formats) for a video the iOS client wouldn't serve directly.
//!
//! We use a real desktop browser User-Agent for both, because the web player JS
//! and the `WEB` Innertube client are what carry `signatureCipher` formats (the
//! iOS client deliberately returns pre-signed URLs, which is the fast path).

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::cipher::CipherError;

const WATCH_BASE: &str = "https://www.youtube.com/watch?v=";
const YT_HOST: &str = "https://www.youtube.com";
const WEB_PLAYER_ENDPOINT: &str =
    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

/// A desktop UA so the web page/JS is served (not the mobile/app variants).
const WEB_UA: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SIGNATURES_JSON: &str = include_str!("../signatures.json");

fn patterns() -> &'static Value {
    static P: OnceLock<Value> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(SIGNATURES_JSON).expect("signatures.json is valid JSON"))
}

/// base.js, its absolute URL, and the player revision id.
#[derive(Debug, Clone)]
pub struct PlayerJs {
    pub player_id: String,
    pub url: String,
    pub code: String,
}

/// Extract the `/s/player/.../base.js` path from a watch-page HTML body.
pub fn extract_player_url(watch_html: &str) -> Option<String> {
    for pat in patterns()["player_js_url"]["patterns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Ok(re) = Regex::new(pat) else { continue };
        if let Some(caps) = re.captures(watch_html)
            && let Some(m) = caps.name("url") {
                let path = m.as_str();
                return Some(if path.starts_with("http") {
                    path.to_string()
                } else {
                    format!("{YT_HOST}{path}")
                });
            }
    }
    None
}

/// Extract the player revision id from a player URL (the cache key).
pub fn extract_player_id(player_url: &str) -> Option<String> {
    let pat = patterns()["player_id"]["patterns"][0].as_str()?;
    let re = Regex::new(pat).ok()?;
    re.captures(player_url)
        .and_then(|c| c.name("id"))
        .map(|m| m.as_str().to_string())
}

/// Fetch the watch page, locate base.js, and fetch it. (No on-disk cache here —
/// the caller is expected to hold a `PlayerJs` for the process lifetime; per-id
/// disk caching is a canary/runtime concern, not this module's.)
pub async fn fetch_player_js(
    video_id: &str,
    client: &reqwest::Client,
) -> Result<PlayerJs, PlayerError> {
    let watch_url = format!("{WATCH_BASE}{video_id}");
    let html = client
        .get(&watch_url)
        .header("User-Agent", WEB_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await?
        .text()
        .await?;

    let url = extract_player_url(&html).ok_or(PlayerError::NoPlayerUrl)?;
    let player_id = extract_player_id(&url).unwrap_or_else(|| "unknown".to_string());

    let code = client
        .get(&url)
        .header("User-Agent", WEB_UA)
        .send()
        .await?
        .text()
        .await?;

    Ok(PlayerJs {
        player_id,
        url,
        code,
    })
}

/// Call the WEB Innertube client for a video's player response. Unlike the iOS
/// client this returns `signatureCipher` formats (and `n`-throttled URLs), which
/// is exactly the input the cipher path needs.
pub async fn fetch_web_player_response(
    video_id: &str,
    client: &reqwest::Client,
    sts: Option<i64>,
) -> Result<Value, PlayerError> {
    // The WEB client identity. clientVersion drifts; it lives here (small, web-
    // only) rather than clients.json which is the iOS fast-path identity.
    let ctx = json!({
        "client": {
            "clientName": "WEB",
            "clientVersion": "2.20240726.00.00",
            "hl": "en",
            "gl": "US",
        }
    });
    // signatureTimestamp ties the response's sig formats to the player build we
    // fetched; without it YouTube may hand back formats a different player signs.
    let mut playback_ctx = json!({});
    if let Some(sts) = sts {
        playback_ctx["contentPlaybackContext"] = json!({ "signatureTimestamp": sts });
    }

    let body = json!({
        "context": ctx,
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": playback_ctx,
    });

    let v: Value = client
        .post(WEB_PLAYER_ENDPOINT)
        .header("User-Agent", WEB_UA)
        .header("X-YouTube-Client-Name", "1")
        .header("X-YouTube-Client-Version", "2.20240726.00.00")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?
        .json()
        .await?;

    Ok(v)
}

/// Extract the signatureTimestamp (`sts`) from base.js — required by the WEB
/// player call so it signs formats for the player build we'll run.
pub fn extract_signature_timestamp(jscode: &str) -> Option<i64> {
    // yt-dlp: `signatureTimestamp:NNNNN` or `sts:NNNNN` in the player JS.
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?:signatureTimestamp|sts)\s*[:=]\s*(?P<sts>[0-9]{5})").unwrap()
    });
    re.captures(jscode)
        .and_then(|c| c.name("sts"))
        .and_then(|m| m.as_str().parse().ok())
}

#[derive(Debug)]
pub enum PlayerError {
    NoPlayerUrl,
    Http(reqwest::Error),
    Cipher(CipherError),
}

impl std::fmt::Display for PlayerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlayerError::NoPlayerUrl => write!(f, "could not find base.js URL on watch page"),
            PlayerError::Http(e) => write!(f, "http: {e}"),
            PlayerError::Cipher(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for PlayerError {}
impl From<reqwest::Error> for PlayerError {
    fn from(e: reqwest::Error) -> Self {
        PlayerError::Http(e)
    }
}
impl From<CipherError> for PlayerError {
    fn from(e: CipherError) -> Self {
        PlayerError::Cipher(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_player_url_from_jsurl() {
        let html = r#"...,"jsUrl":"/s/player/ac678d18/player_ias.vflset/en_US/base.js","#;
        let got = extract_player_url(html).unwrap();
        assert_eq!(
            got,
            "https://www.youtube.com/s/player/ac678d18/player_ias.vflset/en_US/base.js"
        );
    }

    #[test]
    fn extracts_player_url_bare_path() {
        let html =
            r#"<script src="/s/player/deadbeef/player_ias.vflset/en_US/base.js"></script>"#;
        let got = extract_player_url(html).unwrap();
        assert!(got.ends_with("/s/player/deadbeef/player_ias.vflset/en_US/base.js"));
    }

    #[test]
    fn extracts_player_id() {
        let url = "https://www.youtube.com/s/player/ac678d18/player_ias.vflset/en_US/base.js";
        assert_eq!(extract_player_id(url).as_deref(), Some("ac678d18"));
    }

    #[test]
    fn extracts_sts() {
        let js = r#"a.b={signatureTimestamp:19834,foo:1};"#;
        assert_eq!(extract_signature_timestamp(js), Some(19834));
    }
}
