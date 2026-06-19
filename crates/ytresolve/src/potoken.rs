//! PoToken (Proof-of-Origin / BotGuard) provider abstraction.
//!
//! YouTube's BotGuard attestation VM produces an opaque `pot` token that must
//! accompany adaptive stream requests and (in the Player context) the
//! InnerTube player request body. The VM is proprietary JavaScript that cannot
//! be reimplemented in Rust — the token **must** be minted by running
//! BotGuard's own code.
//!
//! This module provides:
//!
//! - [`PoTokenContext`] — distinguishes where the token will be used.
//! - [`PoTokenProvider`] — async trait for token minting backends.
//! - [`NullProvider`] — no-op stub (returns `None`; useful for testing and
//!   for clients on non-throttled IPs that do not yet require PoToken).
//! - [`HttpMinterProvider`] — delegates to an external
//!   `bgutil-ytdlp-pot-provider` HTTP service.  Reads `EEX_POT_PROVIDER_URL`
//!   from the environment; if the variable is absent it degrades gracefully to
//!   `Ok(None)`.
//! - [`attach_to_player_body`] — sets the correct InnerTube JSON key for the
//!   Player context.
//! - [`attach_to_stream_url`] — appends `&pot=<token>` to a GVS stream URL.

use serde::Deserialize;

// ── Context ──────────────────────────────────────────────────────────────────

/// Identifies where the PoToken will be consumed by YouTube's backend.
///
/// YouTube issues **separate** tokens for each context; the same token cannot
/// be reused across both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PoTokenContext {
    /// **GVS (Google Video Service)** — appended as `&pot=<token>` on each
    /// adaptive stream URL returned by the InnerTube player response.
    Gvs,
    /// **Player** — embedded inside the InnerTube `/youtubei/v1/player` POST
    /// body under `serviceIntegrityDimensions.poToken`.
    Player,
}

impl std::fmt::Display for PoTokenContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PoTokenContext::Gvs => write!(f, "GVS"),
            PoTokenContext::Player => write!(f, "Player"),
        }
    }
}

// ── Error ─────────────────────────────────────────────────────────────────────

/// Errors that can be returned by a [`PoTokenProvider`].
#[derive(Debug)]
pub enum PoTokenError {
    /// The external minter returned an HTTP error status.
    HttpStatus { status: u16, body: String },
    /// The minter response body could not be deserialized.
    InvalidResponse(String),
    /// A network-level error occurred while contacting the minter.
    Network(reqwest::Error),
}

impl std::fmt::Display for PoTokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PoTokenError::HttpStatus { status, body } => {
                write!(f, "PoToken minter returned HTTP {status}: {body}")
            }
            PoTokenError::InvalidResponse(s) => {
                write!(f, "PoToken minter returned unexpected JSON: {s}")
            }
            PoTokenError::Network(e) => write!(f, "PoToken minter network error: {e}"),
        }
    }
}
impl std::error::Error for PoTokenError {}
impl From<reqwest::Error> for PoTokenError {
    fn from(e: reqwest::Error) -> Self {
        PoTokenError::Network(e)
    }
}

// ── Trait ─────────────────────────────────────────────────────────────────────

/// Async trait for PoToken minting backends.
///
/// Implementations MUST be `Send + Sync` so they can be stored behind an
/// `Arc` and shared across Tokio tasks.
///
/// Returning `Ok(None)` is the correct response when:
/// - The provider is not configured (e.g. env var absent).
/// - The calling video does not require a PoToken.
///
/// Callers treat `None` as "proceed without token" rather than a hard error.
pub trait PoTokenProvider: Send + Sync {
    /// Mint (or retrieve from cache) a PoToken for `identifier` in the given
    /// `context`.
    ///
    /// `identifier` is the YouTube video ID for video-specific tokens, or an
    /// empty string / visitor-data blob depending on the minter's contract.
    fn fetch(
        &self,
        ctx: PoTokenContext,
        identifier: &str,
    ) -> impl std::future::Future<Output = Result<Option<String>, PoTokenError>> + Send;
}

// ── NullProvider ──────────────────────────────────────────────────────────────

/// A no-op [`PoTokenProvider`] that always returns `Ok(None)`.
///
/// Used in tests and in configurations where the deployment IP is not yet
/// subject to BotGuard throttling.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullProvider;

impl PoTokenProvider for NullProvider {
    async fn fetch(
        &self,
        _ctx: PoTokenContext,
        _identifier: &str,
    ) -> Result<Option<String>, PoTokenError> {
        Ok(None)
    }
}

// ── HttpMinterProvider ────────────────────────────────────────────────────────

/// Shape of the successful JSON response from `bgutil-ytdlp-pot-provider`.
#[derive(Debug, Deserialize)]
struct MinterResponse {
    #[serde(rename = "poToken")]
    po_token: Option<String>,
    // The minter may also return an updated visitorData; we capture it for
    // future caching but do not use it yet.
    #[allow(dead_code)]
    #[serde(rename = "visitorData")]
    visitor_data: Option<String>,
}

/// Shape of the request body sent to `/get_pot`.
#[derive(Debug, serde::Serialize)]
struct MinterRequest<'a> {
    #[serde(rename = "videoId")]
    video_id: &'a str,
    visitor_data: &'a str,
}

/// A [`PoTokenProvider`] that delegates to an external HTTP minter.
///
/// The minter is expected to implement the `bgutil-ytdlp-pot-provider`
/// contract:
///
/// ```text
/// POST {EEX_POT_PROVIDER_URL}/get_pot
/// Content-Type: application/json
///
/// {"videoId": "<id>", "visitor_data": ""}
///
/// → {"poToken": "<token>", "visitorData": "<updated>"}
/// ```
///
/// **Configuration:** set `EEX_POT_PROVIDER_URL` to the base URL of the
/// running minter service (e.g. `http://localhost:4416`).  When the variable
/// is absent, all calls return `Ok(None)` without making any network request.
///
/// # Example
///
/// ```rust,no_run
/// use ytresolve::potoken::{HttpMinterProvider, PoTokenContext, PoTokenProvider};
///
/// #[tokio::main]
/// async fn main() {
///     let provider = HttpMinterProvider::default();
///     let token = provider.fetch(PoTokenContext::Gvs, "dQw4w9WgXcQ").await.unwrap();
///     println!("{token:?}");
/// }
/// ```
#[derive(Debug, Clone)]
pub struct HttpMinterProvider {
    client: reqwest::Client,
}

impl Default for HttpMinterProvider {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl HttpMinterProvider {
    /// Build with an explicit [`reqwest::Client`] (useful for testing with a
    /// mock server).
    pub fn with_client(client: reqwest::Client) -> Self {
        Self { client }
    }

    fn base_url() -> Option<String> {
        std::env::var("EEX_POT_PROVIDER_URL").ok()
    }
}

impl PoTokenProvider for HttpMinterProvider {
    async fn fetch(
        &self,
        _ctx: PoTokenContext,
        identifier: &str,
    ) -> Result<Option<String>, PoTokenError> {
        let Some(base) = Self::base_url() else {
            // No external minter configured — proceed tokenless (the iOS path
            // needs no PoToken for public videos).
            return Ok(None);
        };

        let url = format!("{base}/get_pot");
        let body = MinterRequest {
            video_id: identifier,
            visitor_data: "",
        };

        let resp = self.client.post(&url).json(&body).send().await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(PoTokenError::HttpStatus {
                status: status.as_u16(),
                body: text,
            });
        }

        let minted: MinterResponse = resp.json().await.map_err(|e| {
            PoTokenError::InvalidResponse(e.to_string())
        })?;

        Ok(minted.po_token)
    }
}

// ── Attach helpers ────────────────────────────────────────────────────────────

/// Attach a PoToken to an InnerTube **player request body** (Player context).
///
/// Sets `body["serviceIntegrityDimensions"]["poToken"] = token`.
///
/// The `serviceIntegrityDimensions` key is created if absent; any existing
/// value under that key is preserved except for `poToken`.
///
/// # Panics
///
/// Does not panic.  If `body` is not a JSON object the function is a no-op
/// (the InnerTube request would be malformed for other reasons).
pub fn attach_to_player_body(body: &mut serde_json::Value, token: &str) {
    if let Some(obj) = body.as_object_mut() {
        let sid = obj
            .entry("serviceIntegrityDimensions")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(sid_obj) = sid.as_object_mut() {
            sid_obj.insert(
                "poToken".to_string(),
                serde_json::Value::String(token.to_string()),
            );
        }
    }
}

/// Append `&pot=<token>` to a YouTube stream URL (GVS context).
///
/// If the URL already contains a `pot=` parameter the function adds a second
/// one (the last value wins in YouTube's URL parsing, so this is safe for
/// token rotation but callers should avoid appending twice when possible).
pub fn attach_to_stream_url(url: &str, token: &str) -> String {
    // Fast path: avoid pulling in a full URL parser just for a query append.
    let sep = if url.contains('?') { '&' } else { '?' };
    // Percent-encode the token so it is URL-safe (tokens are base64url and
    // contain only [A-Za-z0-9_-=], so no encoding is strictly required, but
    // we use a manual safe check to be defensive).
    let encoded = percent_encode_pot(token);
    format!("{url}{sep}pot={encoded}")
}

/// Minimal percent-encoder for the PoToken value.
///
/// YouTube PoTokens are base64url-encoded and only contain `[A-Za-z0-9_\-=]`,
/// which are all URL-safe.  This helper exists so we have an explicit encoding
/// layer for future token formats that might include non-URL-safe characters.
fn percent_encode_pot(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    for b in token.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'=' | b'.' | b'~' => {
                out.push(b as char);
            }
            other => {
                out.push('%');
                out.push(char::from_digit((other >> 4) as u32, 16).unwrap_or('0'));
                out.push(char::from_digit((other & 0xf) as u32, 16).unwrap_or('0'));
            }
        }
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── NullProvider ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn null_provider_gvs_returns_none() {
        let p = NullProvider;
        let result = p.fetch(PoTokenContext::Gvs, "dQw4w9WgXcQ").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    #[tokio::test]
    async fn null_provider_player_returns_none() {
        let p = NullProvider;
        let result = p.fetch(PoTokenContext::Player, "dQw4w9WgXcQ").await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    // ── HttpMinterProvider (no env var) ───────────────────────────────────────

    #[tokio::test]
    async fn http_minter_no_env_returns_none() {
        // Guard: remove env var for this test's duration.
        // Using std::env directly so we don't need `temp_env` crate.
        let key = "EEX_POT_PROVIDER_URL";
        let prior = std::env::var(key).ok();
        unsafe {
            std::env::remove_var(key);
        }

        let p = HttpMinterProvider::default();
        let result = p.fetch(PoTokenContext::Gvs, "dQw4w9WgXcQ").await;

        // Restore env var so we don't pollute other parallel tests.
        if let Some(v) = prior {
            unsafe { std::env::set_var(key, v) };
        }

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }

    // ── attach_to_player_body ─────────────────────────────────────────────────

    #[test]
    fn attach_to_player_body_sets_correct_path() {
        let mut body = serde_json::json!({
            "context": {
                "client": {
                    "clientName": "WEB",
                    "clientVersion": "2.20240101"
                }
            },
            "videoId": "dQw4w9WgXcQ"
        });

        attach_to_player_body(&mut body, "EXAMPLE_POT_TOKEN_abc123");

        assert_eq!(
            body["serviceIntegrityDimensions"]["poToken"],
            serde_json::json!("EXAMPLE_POT_TOKEN_abc123")
        );
    }

    #[test]
    fn attach_to_player_body_creates_key_when_absent() {
        let mut body = serde_json::json!({});
        attach_to_player_body(&mut body, "tok");
        assert_eq!(body["serviceIntegrityDimensions"]["poToken"], "tok");
    }

    #[test]
    fn attach_to_player_body_preserves_other_sid_keys() {
        let mut body = serde_json::json!({
            "serviceIntegrityDimensions": {
                "existingKey": "existingValue"
            }
        });
        attach_to_player_body(&mut body, "newtok");
        assert_eq!(body["serviceIntegrityDimensions"]["existingKey"], "existingValue");
        assert_eq!(body["serviceIntegrityDimensions"]["poToken"], "newtok");
    }

    // ── attach_to_stream_url ──────────────────────────────────────────────────

    #[test]
    fn attach_to_stream_url_appends_pot_with_ampersand() {
        let url = "https://rr1---sn-foo.googlevideo.com/videoplayback?expire=9999&id=abc";
        let result = attach_to_stream_url(url, "TOK123");
        assert_eq!(
            result,
            "https://rr1---sn-foo.googlevideo.com/videoplayback?expire=9999&id=abc&pot=TOK123"
        );
    }

    #[test]
    fn attach_to_stream_url_uses_question_mark_when_no_existing_params() {
        let url = "https://rr1---sn-foo.googlevideo.com/videoplayback";
        let result = attach_to_stream_url(url, "TOK456");
        assert_eq!(result, "https://rr1---sn-foo.googlevideo.com/videoplayback?pot=TOK456");
    }

    #[test]
    fn attach_to_stream_url_is_idempotent_token_value() {
        // Token value is passed through as-is for URL-safe chars.
        let url = "https://example.com/stream?v=1";
        let token = "abc123_ABC-XYZ=";
        let result = attach_to_stream_url(url, token);
        assert!(result.ends_with(&format!("&pot={token}")));
    }

    // ── percent_encode_pot ────────────────────────────────────────────────────

    #[test]
    fn percent_encode_pot_leaves_safe_chars_unchanged() {
        let token = "ABCabc123-_=.~";
        assert_eq!(super::percent_encode_pot(token), token);
    }

    #[test]
    fn percent_encode_pot_encodes_unsafe_chars() {
        let token = "tok+en";
        let encoded = super::percent_encode_pot(token);
        assert_eq!(encoded, "tok%2ben");
    }

    // ── PoTokenContext Display ─────────────────────────────────────────────────

    #[test]
    fn context_display_strings() {
        assert_eq!(PoTokenContext::Gvs.to_string(), "GVS");
        assert_eq!(PoTokenContext::Player.to_string(), "Player");
    }
}
