//! Subject (`sub`) namespace parsing per §8 of the cross-service contract.
//!
//! Three provider namespaces: `plex:`, `local:`, `apple:`. The format is
//! `<provider>:<id>`. Regex literals are the contract — Rust + TS + Swift
//! implementations MUST match exactly. Verified against
//! `tests/vectors/sub-namespace.json`.

use regex::Regex;
use std::sync::OnceLock;

/// `plex:` — non-negative integer, no leading zeros except for the literal
/// `0` (which is itself valid — Plex's anonymous account ID). Matches
/// `server/services/sub.ts` and `tests/vectors/sub-namespace.json`
/// (`valid-plex-zero` case).
pub const PLEX_REGEX: &str = r"^plex:(0|[1-9][0-9]*)$";

/// `local:` — Crockford Base32 ULID, uppercase, 26 chars, no I/L/O/U.
pub const LOCAL_REGEX: &str = r"^local:[0-9A-HJKMNP-TV-Z]{26}$";

/// `apple:` — Sign in with Apple identifier: `<6digit>.<32hex>.<4digit>`.
pub const APPLE_REGEX: &str = r"^apple:[0-9]{6}\.[0-9a-f]{32}\.[0-9]{4}$";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Provider {
    Plex,
    Local,
    Apple,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sub {
    pub provider: Provider,
    pub id: String,
    /// Full namespaced form, e.g. `"plex:12345"`.
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubError {
    /// Sub is not in `<provider>:<id>` shape at all.
    Unprefixed,
    /// Provider prefix is unknown (not plex/local/apple).
    UnknownProvider,
    /// Provider matches but the id portion fails the regex.
    InvalidFormat,
}

fn plex_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(PLEX_REGEX).expect("static regex"))
}
fn local_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(LOCAL_REGEX).expect("static regex"))
}
fn apple_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(APPLE_REGEX).expect("static regex"))
}

/// Parse a namespaced `sub` string. The string MUST already carry a
/// provider prefix — grace-window normalization of legacy bare-Plex-ID
/// `sub` values lives in the TS path (`tryNormaliseLegacySub`) because
/// it depends on the per-deployment `D7_DEPLOYED_AT` timer.
pub fn parse_sub(s: &str) -> Result<Sub, SubError> {
    if !s.contains(':') {
        return Err(SubError::Unprefixed);
    }
    let (prefix, rest) = s.split_once(':').ok_or(SubError::Unprefixed)?;
    match prefix {
        "plex" => {
            if plex_re().is_match(s) {
                Ok(Sub { provider: Provider::Plex, id: rest.to_string(), raw: s.to_string() })
            } else {
                Err(SubError::InvalidFormat)
            }
        }
        "local" => {
            if local_re().is_match(s) {
                Ok(Sub { provider: Provider::Local, id: rest.to_string(), raw: s.to_string() })
            } else {
                Err(SubError::InvalidFormat)
            }
        }
        "apple" => {
            if apple_re().is_match(s) {
                Ok(Sub { provider: Provider::Apple, id: rest.to_string(), raw: s.to_string() })
            } else {
                Err(SubError::InvalidFormat)
            }
        }
        _ => Err(SubError::UnknownProvider),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_plex() {
        let s = parse_sub("plex:12345").unwrap();
        assert_eq!(s.provider, Provider::Plex);
        assert_eq!(s.id, "12345");
        assert_eq!(s.raw, "plex:12345");
    }

    #[test]
    fn plex_no_leading_zero() {
        assert_eq!(parse_sub("plex:007").unwrap_err(), SubError::InvalidFormat);
        // `plex:0` is the documented exception (Plex's anonymous-account
        // id). Per the canonical vector `valid-plex-zero`.
        let s = parse_sub("plex:0").unwrap();
        assert_eq!(s.provider, Provider::Plex);
        assert_eq!(s.id, "0");
    }

    #[test]
    fn valid_local_ulid() {
        let s = parse_sub("local:01HABCDEFGHJKMNPQRSTVWXYZ0").unwrap();
        assert_eq!(s.provider, Provider::Local);
    }

    #[test]
    fn local_rejects_lowercase() {
        assert_eq!(
            parse_sub("local:01habcdefghjkmnpqrstvwxyz0").unwrap_err(),
            SubError::InvalidFormat,
        );
    }

    #[test]
    fn valid_apple() {
        let s = parse_sub("apple:001126.d3c6971f4faa4ccd80027e3654fa404a.1616").unwrap();
        assert_eq!(s.provider, Provider::Apple);
    }

    #[test]
    fn rejects_unprefixed() {
        assert_eq!(parse_sub("12345").unwrap_err(), SubError::Unprefixed);
    }

    #[test]
    fn rejects_unknown_provider() {
        assert_eq!(parse_sub("google:abc").unwrap_err(), SubError::UnknownProvider);
    }
}
