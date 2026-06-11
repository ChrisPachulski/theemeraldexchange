//! Telemetry PII scrubber per §15.3.
//!
//! Canonical implementation: Hono consumes it via the N-API binding
//! (`piiScrubKeys` / `piiScrubValue` → `server/services/telemetryPiiScrub.ts`),
//! the recommender via PyO3. `tests/vectors/telemetry-pii-scrub.json` is the
//! behavioral oracle for every binding — divergence means crash data with
//! PII reaches Glitchtip.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// Replacement for values whose key matched the denylist. Frozen wire
/// value — the vector file pins it.
pub const REDACTED: &str = "REDACTED";

/// Denylist of key substrings whose values are always redacted to
/// `"REDACTED"`. Entries are stored lowercase; matching is
/// case-insensitive substring (`contains`), mirroring Sentry's own
/// EventScrubber. Union of:
///   a) §15.3 EEX-specific keys
///   b) Sentry Python EventScrubber DEFAULT_DENYLIST
///   c) network-identifier extras (IP-shaped headers/fields)
pub const PII_KEYS: &[&str] = &[
    // §15.3 EEX-specific (lowercased forms of plexAuthToken etc.).
    "plexauthtoken",
    "verifiedplexserverid",
    "xtream_username",
    "xtream_password",
    // Sentry Python EventScrubber DEFAULT_DENYLIST.
    "password",
    "secret",
    "api_key",
    "token",
    "session",
    "auth",
    "credential",
    "cookie",
    "key",
    "csrf",
    "pem",
    "key_id",
    "signature",
    "license",
    "jwt",
    "certificate",
    "hash",
    "salt",
    "oauth",
    "client_secret",
    "refresh_token",
    "access_token",
    "private_key",
    // Network-identifier extras.
    "passwd",
    "x-real-ip",
    "x-forwarded-for",
    "ip_address",
    "remote_addr",
];

/// Stream-grant URL token: `t=<anything>` query param. Replaces the
/// whole `t=<value>` with `t=REDACTED`, preserving the param name.
fn stream_token_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"\bt=[^&\s"']+"#).expect("static regex"))
}

/// JWE/JWT compact ciphertext: `eyJ` + 8+ base64url chars + `.` then the
/// rest of the compact form up to a cookie/query delimiter. Replaced with
/// `REDACTED.` so the shape is clearly scrubbed.
fn jwe_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"eyJ[A-Za-z0-9_-]{8,}\.[^"'\s;,]*"#).expect("static regex"))
}

/// Recursively scrub `value` in-place. Object keys matching any
/// `PII_KEYS` substring (case-insensitive) have their values replaced
/// with `"REDACTED"`. String values have stream-token / JWE patterns
/// redacted inline.
pub fn scrub_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if matches_pii_key(k) {
                    *v = Value::String(REDACTED.to_string());
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

/// Apply value-regex redactions to a string. Order matters and is
/// contract-stable: stream-grant tokens first, JWE compact second.
fn redact_string(s: &str) -> String {
    let mut out = s.to_string();
    out = stream_token_regex()
        .replace_all(&out, "t=REDACTED")
        .into_owned();
    out = jwe_regex().replace_all(&out, "REDACTED.").into_owned();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scrubs_plex_token_key() {
        let mut v = json!({"plexAuthToken": "abcdef", "username": "alice"});
        scrub_value(&mut v);
        assert_eq!(v["plexAuthToken"], "REDACTED");
        assert_eq!(v["username"], "alice");
    }

    #[test]
    fn scrubs_case_insensitive() {
        let mut v = json!({"Authorization": "Bearer abc"});
        scrub_value(&mut v);
        assert_eq!(v["Authorization"], "REDACTED");
    }

    #[test]
    fn scrubs_nested_object() {
        let mut v = json!({"headers": {"cookie": "eex.session=xyz"}});
        scrub_value(&mut v);
        assert_eq!(v["headers"]["cookie"], "REDACTED");
    }

    #[test]
    fn scrubs_stream_token_in_string_value() {
        let mut v = json!({"url": "/api/iptv/stream/live/42?t=4b0b2e58&fmt=hls"});
        scrub_value(&mut v);
        assert_eq!(v["url"], "/api/iptv/stream/live/42?t=REDACTED&fmt=hls");
    }

    #[test]
    fn scrubs_jwe_ciphertext_in_string_value() {
        let mut v = json!({"sqlParam": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.abc.def.ghi.jkl"});
        scrub_value(&mut v);
        assert_eq!(v["sqlParam"], "REDACTED.");
    }

    #[test]
    fn does_not_match_t_inside_words() {
        // `fmt=hls` must not trip the \bt= rule — t is preceded by a word char.
        let mut v = json!({"url": "/x?fmt=hls"});
        scrub_value(&mut v);
        assert_eq!(v["url"], "/x?fmt=hls");
    }

    #[test]
    fn redacts_non_string_values_for_denylisted_keys() {
        let mut v = json!({"session": 12345});
        scrub_value(&mut v);
        assert_eq!(v["session"], "REDACTED");
    }

    #[test]
    fn matches_pii_key_substring() {
        assert!(matches_pii_key("plexAuthToken"));
        assert!(matches_pii_key("X-AUTH-TOKEN"));
        assert!(matches_pii_key("my_secret_field"));
        assert!(matches_pii_key("x-forwarded-for"));
        assert!(!matches_pii_key("title"));
    }

    #[test]
    fn denylist_entries_are_lowercase() {
        // The matcher lowercases the key only; entries must already be
        // lowercase or they can never match.
        for k in PII_KEYS {
            assert_eq!(*k, k.to_lowercase(), "denylist entry not lowercase: {k}");
        }
    }
}
