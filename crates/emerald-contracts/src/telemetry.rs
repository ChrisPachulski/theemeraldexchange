//! Telemetry PII scrubber per §15.3.
//!
//! Mirrors `server/services/telemetryPiiScrub.ts`. The denylist must be
//! kept in sync across TS/Python/Swift/Rust — divergence means crash
//! data with PII reaches Glitchtip.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// Denylist of key substrings (case-insensitive) whose values are
/// always redacted to `"[Filtered]"`. Order is documented but not
/// semantically meaningful — match is `contains` so the longest match
/// wins implicitly. EEX-specific keys come first, then the standard
/// Sentry Python `DEFAULT_DENYLIST`.
pub const PII_KEYS: &[&str] = &[
    // EEX-specific.
    "plex_token",
    "plex_auth",
    "plex_auth_token",
    "eex_session",
    "stream_token",
    "session_secret",
    "stream_token_secret",
    "device_token_secret",
    // Sentry Python DEFAULT_DENYLIST equivalents.
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "auth",
    "credentials",
    "private_key",
    "privatekey",
    "token",
    "session",
    "csrf",
    "x-csrf-token",
    "x-auth-token",
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-real-ip",
    "x-forwarded-for",
    "ip_address",
    "remote_addr",
];

/// Value regexes — these match across keys/freeform-text, redacting any
/// matched substring inline.
fn token_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        // Stream-grant token in URL: ?t=<base64url>.<base64url>
        // Plus generic JWE compact: <b64>.<b64>.<b64>.<b64>.<b64>
        Regex::new(
            r"(?x)
            (?:\?t=|&t=) [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+   # stream-grant token in URL
            | (?:eyJ[A-Za-z0-9_-]+\.){2,4} [A-Za-z0-9_-]+ # JWE/JWT compact
            ",
        )
        .expect("static regex")
    })
}

fn bearer_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._-]+").expect("static regex"))
}

fn cookie_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"eex\.session=[^;]+").expect("static regex"))
}

/// Recursively scrub `value` in-place. Object keys matching any
/// `PII_KEYS` substring (case-insensitive) have their values replaced
/// with `"[Filtered]"`. String values have token/bearer/cookie patterns
/// redacted inline.
pub fn scrub_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if matches_pii_key(k) {
                    *v = Value::String("[Filtered]".to_string());
                } else {
                    scrub_value(v);
                }
            }
        }
        Value::Array(arr) => {
            for item in arr.iter_mut() {
                scrub_value(item);
            }
        }
        Value::String(s) => {
            let redacted = redact_string(s);
            *s = redacted;
        }
        _ => {}
    }
}

/// True if `key` contains any denylist substring (case-insensitive).
pub fn matches_pii_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    PII_KEYS.iter().any(|deny| lower.contains(deny))
}

/// Apply value-regex redactions to a string.
fn redact_string(s: &str) -> String {
    let mut out = s.to_string();
    out = token_regex()
        .replace_all(&out, "[Filtered:token]")
        .into_owned();
    out = bearer_regex()
        .replace_all(&out, "[Filtered:bearer]")
        .into_owned();
    out = cookie_regex()
        .replace_all(&out, "[Filtered:cookie]")
        .into_owned();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scrubs_plex_token_key() {
        let mut v = json!({"plex_auth_token": "abcdef", "username": "alice"});
        scrub_value(&mut v);
        assert_eq!(v["plex_auth_token"], "[Filtered]");
        assert_eq!(v["username"], "alice");
    }

    #[test]
    fn scrubs_case_insensitive() {
        let mut v = json!({"Authorization": "Bearer abc"});
        scrub_value(&mut v);
        assert_eq!(v["Authorization"], "[Filtered]");
    }

    #[test]
    fn scrubs_nested_object() {
        let mut v = json!({"headers": {"cookie": "eex.session=xyz"}});
        scrub_value(&mut v);
        assert_eq!(v["headers"]["cookie"], "[Filtered]");
    }

    #[test]
    fn scrubs_bearer_in_string_value() {
        let mut v = json!({"url": "GET /api with Bearer tok123"});
        scrub_value(&mut v);
        assert!(v["url"].as_str().unwrap().contains("[Filtered:bearer]"));
    }

    #[test]
    fn matches_pii_key_substring() {
        assert!(matches_pii_key("plex_token"));
        assert!(matches_pii_key("X-AUTH-TOKEN"));
        assert!(matches_pii_key("my_secret_field"));
        assert!(!matches_pii_key("title"));
    }
}
