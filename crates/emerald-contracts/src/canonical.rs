//! Canonical JSON encoding for HMAC input.
//!
//! Stream tokens MUST NOT use serde_json::to_string for HMAC input —
//! serde serializes fields in declaration order, not alphabetical. The
//! TS implementation uses a hand-rolled fixed-template serializer; this
//! module mirrors it byte-for-byte.
//!
//! Cross-language guarantee: identical bytes to the TS `jsonEscapeString`
//! and the fixed-template emitter in `server/services/iptvStreamToken.ts`.
//! Verified by `tests/vectors/stream-token-canonical.json`.

/// JSON-escape a single string into `out`, matching the TS jsonEscapeString.
///
/// Escape set (per RFC 8259 §7):
///   `"` → `\"`
///   `\` → `\\`
///   `\b` → `\b`
///   `\t` → `\t`
///   `\n` → `\n`
///   `\f` → `\f`
///   `\r` → `\r`
///   any code point < 0x20 not above → `\uXXXX` (lowercase hex, 4 digits)
///   code points ≥ 0x20 → emitted as their UTF-8 bytes
///
/// Code points > U+FFFF are emitted as their 4-byte UTF-8 sequences via
/// Rust's `char` iteration — identical bytes to Node's `Buffer.from(s, 'utf-8')`
/// path which encodes JS surrogate pairs as 4-byte UTF-8.
///
/// PRECONDITION (cross-language contract): `rid` and `sub` MUST be well-formed
/// Unicode. A lone/unpaired UTF-16 surrogate is OUT OF CONTRACT. Rust `&str`
/// cannot represent a lone surrogate at all (the type guarantees valid UTF-8),
/// whereas the TS path replaces it with U+FFFD via `Buffer.from(s, 'utf-8')`.
/// The two implementations would therefore diverge on malformed-UTF16 input.
/// This is unreachable for server-minted tokens (rid/sub are constructed from
/// well-formed sources) and is pinned negatively in
/// `tests/vectors/stream-token-canonical.json` (`surrogate-pair-emoji` vector,
/// a valid pair) — DO NOT feed lone surrogates through this function.
pub fn json_escape_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000A}' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{000D}' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ascii() {
        let mut buf = String::new();
        json_escape_string("hello", &mut buf);
        assert_eq!(buf, "\"hello\"");
    }

    #[test]
    fn escape_quotes_backslash() {
        let mut buf = String::new();
        json_escape_string("a\"b\\c", &mut buf);
        assert_eq!(buf, "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn escape_control_chars() {
        let mut buf = String::new();
        json_escape_string("\u{0001}\u{0019}", &mut buf);
        assert_eq!(buf, "\"\\u0001\\u0019\"");
    }

    #[test]
    fn escape_common_whitespace() {
        let mut buf = String::new();
        json_escape_string("\n\t\r\u{0008}\u{000C}", &mut buf);
        assert_eq!(buf, "\"\\n\\t\\r\\b\\f\"");
    }

    #[test]
    fn surrogate_pair_codepoint() {
        // U+1F4FA TV emoji — exercises 4-byte UTF-8 path that JS encodes
        // via the surrogate pair (D83D, DCFA).
        let mut buf = String::new();
        json_escape_string("\u{1F4FA}", &mut buf);
        // Expected bytes: 0x22 F0 9F 93 BA 0x22
        let want = "\"\u{1F4FA}\"";
        assert_eq!(buf, want);
        assert_eq!(buf.as_bytes(), &[0x22, 0xF0, 0x9F, 0x93, 0xBA, 0x22]);
    }
}
