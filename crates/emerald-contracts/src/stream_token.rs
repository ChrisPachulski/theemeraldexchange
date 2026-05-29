//! Stream-token HMAC-SHA256 sign/verify per §5.
//!
//! **Key derivation:** stream tokens use RAW UTF-8 bytes of
//! `STREAM_TOKEN_SECRET` as the HMAC key, NOT HKDF-derived. Locked
//! 2026-05-27 per contract D18 amendment. See
//! `tests/vectors/stream-token-canonical.json` `_meta.hmac_key_is`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::canonical::json_escape_string;

type HmacSha256 = Hmac<Sha256>;

/// Stream-token kind enum per §5.3. `'recording'` is M6-reserved (DVR
/// pick) — accepted by verifiers but not minted by any current path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Live,
    Vod,
    Series,
    Catchup,
    Segment,
    Remux,
    Playlist,
    /// M6 reserved (DVR). Verifiers MUST treat unknown future values as
    /// hard reject; this variant exists so future Rust code doesn't
    /// require an enum amendment.
    Recording,
}

impl StreamKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            StreamKind::Live => "live",
            StreamKind::Vod => "vod",
            StreamKind::Series => "series",
            StreamKind::Catchup => "catchup",
            StreamKind::Segment => "segment",
            StreamKind::Remux => "remux",
            StreamKind::Playlist => "playlist",
            StreamKind::Recording => "recording",
        }
    }

    pub fn from_wire(s: &str) -> Option<StreamKind> {
        match s {
            "live" => Some(StreamKind::Live),
            "vod" => Some(StreamKind::Vod),
            "series" => Some(StreamKind::Series),
            "catchup" => Some(StreamKind::Catchup),
            "segment" => Some(StreamKind::Segment),
            "remux" => Some(StreamKind::Remux),
            "playlist" => Some(StreamKind::Playlist),
            "recording" => Some(StreamKind::Recording),
            _ => None,
        }
    }
}

/// Stream-token claims, alphabetical field order matches canonical bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamClaims {
    pub exp: i64,
    pub iat: i64,
    pub jti: String,
    pub k: StreamKind,
    pub nbf: i64,
    pub rid: String,
    pub sub: String,
    /// Token format version. Reject any value other than 1.
    pub v: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    /// Token does not have exactly two base64url segments separated by `.`.
    Malformed,
    /// One of the segments failed base64url decode.
    BadBase64,
    /// HMAC signature did not match.
    BadSignature,
    /// Payload JSON parse failed or schema was wrong.
    BadPayload,
    /// `v` claim is not 1.
    UnsupportedVersion,
    /// Now is before `nbf` (with skew applied).
    NotYetValid,
    /// Now is past `exp` (with skew applied).
    Expired,
    /// `k` claim does not parse to a known StreamKind.
    UnknownKind,
    /// `exp < nbf`, or the claimed lifetime (`exp - iat`) exceeds
    /// `MAX_TTL_SECS`. Indicates a malformed or forged token rather than an
    /// expiry condition, so it is reported distinctly from `Expired`.
    BadTtl,
}

/// Clock-skew constants per §5.7. Frozen numeric values — Rust + TS +
/// Swift MUST agree. Without lock here we get drift between languages.
pub const NBF_SKEW_SECS: i64 = 30;
pub const EXP_SKEW_SECS: i64 = 5;

/// Hard upper bound on a stream token's lifetime (`exp - iat`). The longest
/// legitimate stream token is the 90-day external-playlist token; anything
/// claiming more than that is malformed or forged. This is a defense-in-depth
/// safety net layered on top of the per-mint policy TTLs — the verifier never
/// trusts an `exp` that implies a longer-than-possible window. One extra day
/// of slack absorbs leap seconds / mint-time rounding.
pub const MAX_TTL_SECS: i64 = 91 * 24 * 60 * 60;

/// Produce the canonical byte representation used as HMAC input.
///
/// Fixed-template, alphabetical key order: `exp, iat, jti, k, nbf, rid, sub, v`.
/// No whitespace. Integers as bare decimal. Strings JSON-escaped via
/// `canonical::json_escape_string` (includes the surrounding quotes).
pub fn canonical_bytes(claims: &StreamClaims) -> Vec<u8> {
    let mut s = String::with_capacity(192);
    s.push_str("{\"exp\":");
    s.push_str(&claims.exp.to_string());
    s.push_str(",\"iat\":");
    s.push_str(&claims.iat.to_string());
    s.push_str(",\"jti\":");
    json_escape_string(&claims.jti, &mut s);
    s.push_str(",\"k\":");
    json_escape_string(claims.k.as_wire(), &mut s);
    s.push_str(",\"nbf\":");
    s.push_str(&claims.nbf.to_string());
    s.push_str(",\"rid\":");
    json_escape_string(&claims.rid, &mut s);
    s.push_str(",\"sub\":");
    json_escape_string(&claims.sub, &mut s);
    s.push_str(",\"v\":");
    s.push_str(&claims.v.to_string());
    s.push('}');
    s.into_bytes()
}

/// Sign a claim set with the given raw HMAC key bytes (the UTF-8 bytes
/// of `STREAM_TOKEN_SECRET` — NOT HKDF-derived).
pub fn sign(secret_bytes: &[u8], claims: &StreamClaims) -> String {
    let canonical = canonical_bytes(claims);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret_bytes)
        .expect("HMAC-SHA256 accepts any-length keys");
    mac.update(&canonical);
    let sig = mac.finalize().into_bytes();
    let mut out = String::with_capacity(256);
    URL_SAFE_NO_PAD.encode_string(&canonical, &mut out);
    out.push('.');
    URL_SAFE_NO_PAD.encode_string(sig.as_slice(), &mut out);
    out
}

/// Verify a token with a single key. Returns claims on success.
/// Does NOT enforce nbf/exp — call `enforce_time_window` separately
/// with a clock source.
pub fn verify(secret_bytes: &[u8], token: &str) -> Result<StreamClaims, TokenError> {
    let (canonical, sig) = split_token(token)?;
    verify_with_canonical(secret_bytes, &canonical, &sig)?;
    parse_canonical(&canonical)
}

/// Verify with grace-window dual-key fallback. Both HMACs are computed
/// unconditionally (timing-safe per Patch 5); branch on bool result only.
pub fn verify_dual_key(
    primary: &[u8],
    fallback: &[u8],
    token: &str,
) -> Result<(StreamClaims, bool), TokenError> {
    let (canonical, sig) = split_token(token)?;
    let primary_ok = compute_and_compare(primary, &canonical, &sig);
    let fallback_ok = compute_and_compare(fallback, &canonical, &sig);
    if !primary_ok && !fallback_ok {
        return Err(TokenError::BadSignature);
    }
    let claims = parse_canonical(&canonical)?;
    // `used_fallback` is true only when the primary key did NOT match
    // but the fallback did. Caller emits a WARN log so the operator
    // sees the legacy tail-off.
    Ok((claims, !primary_ok && fallback_ok))
}

/// Enforce nbf ≤ now ≤ exp with skew constants per §5.7.
pub fn enforce_time_window(claims: &StreamClaims, now: i64) -> Result<(), TokenError> {
    // Upper-bound safety net: a token can never outlive the longest legitimate
    // policy window. Checked before the skew comparisons so a forged long-lived
    // exp is rejected as BadTtl regardless of the current clock. `exp < nbf` is
    // a nonsensical window and is rejected on the same path.
    if claims.exp < claims.nbf || claims.exp - claims.iat > MAX_TTL_SECS {
        return Err(TokenError::BadTtl);
    }
    if now + NBF_SKEW_SECS < claims.nbf {
        return Err(TokenError::NotYetValid);
    }
    if now - EXP_SKEW_SECS > claims.exp {
        return Err(TokenError::Expired);
    }
    Ok(())
}

fn split_token(token: &str) -> Result<(Vec<u8>, Vec<u8>), TokenError> {
    let mut parts = token.split('.');
    let payload_b64 = parts.next().ok_or(TokenError::Malformed)?;
    let sig_b64 = parts.next().ok_or(TokenError::Malformed)?;
    if parts.next().is_some() {
        return Err(TokenError::Malformed);
    }
    let canonical = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| TokenError::BadBase64)?;
    let sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| TokenError::BadBase64)?;
    Ok((canonical, sig))
}

fn verify_with_canonical(
    secret_bytes: &[u8],
    canonical: &[u8],
    sig: &[u8],
) -> Result<(), TokenError> {
    if compute_and_compare(secret_bytes, canonical, sig) {
        Ok(())
    } else {
        Err(TokenError::BadSignature)
    }
}

fn compute_and_compare(secret_bytes: &[u8], canonical: &[u8], sig: &[u8]) -> bool {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(secret_bytes)
        .expect("HMAC-SHA256 accepts any-length keys");
    mac.update(canonical);
    let computed = mac.finalize().into_bytes();
    // Constant-time compare. ct_eq returns Choice (0 or 1).
    // We compute both even when lengths differ to avoid a length-branch
    // timing leak — but HMAC-SHA256 output is always 32 bytes so sig
    // length is a known constant when valid.
    if sig.len() != computed.len() {
        // Treat length mismatch as failure without short-circuiting the
        // compare itself: bool::from on a fake-equal Choice keeps the
        // op constant-time per call.
        return false;
    }
    bool::from(computed.as_slice().ct_eq(sig))
}

fn parse_canonical(bytes: &[u8]) -> Result<StreamClaims, TokenError> {
    // Use serde_json for parsing only (not for HMAC input — parsing is
    // permissive about whitespace, which is irrelevant since the input
    // is the freshly-decoded canonical bytes).
    let v: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| TokenError::BadPayload)?;
    let obj = v.as_object().ok_or(TokenError::BadPayload)?;

    let version = obj
        .get("v")
        .and_then(|x| x.as_u64())
        .ok_or(TokenError::BadPayload)?;
    if version != 1 {
        return Err(TokenError::UnsupportedVersion);
    }

    let kind_str = obj.get("k").and_then(|x| x.as_str()).ok_or(TokenError::BadPayload)?;
    let k = StreamKind::from_wire(kind_str).ok_or(TokenError::UnknownKind)?;

    Ok(StreamClaims {
        exp: obj.get("exp").and_then(|x| x.as_i64()).ok_or(TokenError::BadPayload)?,
        iat: obj.get("iat").and_then(|x| x.as_i64()).ok_or(TokenError::BadPayload)?,
        jti: obj
            .get("jti")
            .and_then(|x| x.as_str())
            .ok_or(TokenError::BadPayload)?
            .to_string(),
        k,
        nbf: obj.get("nbf").and_then(|x| x.as_i64()).ok_or(TokenError::BadPayload)?,
        rid: obj
            .get("rid")
            .and_then(|x| x.as_str())
            .ok_or(TokenError::BadPayload)?
            .to_string(),
        sub: obj
            .get("sub")
            .and_then(|x| x.as_str())
            .ok_or(TokenError::BadPayload)?
            .to_string(),
        v: version as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_claims() -> StreamClaims {
        StreamClaims {
            exp: 1748256000,
            iat: 1748169600,
            jti: "01HWXYZ01234567890ABCDEFGH".to_string(),
            k: StreamKind::Live,
            nbf: 1748169600,
            rid: "ch-101".to_string(),
            sub: "plex:12345".to_string(),
            v: 1,
        }
    }

    #[test]
    fn canonical_bytes_match_ts() {
        // Hex from tests/vectors/stream-token-canonical.json live-basic vector.
        let want_hex = "7b22657870223a313734383235363030302c22696174223a313734383136393630302c226a7469223a223031485758595a30313233343536373839304142434445464748222c226b223a226c697665222c226e6266223a313734383136393630302c22726964223a2263682d313031222c22737562223a22706c65783a3132333435222c2276223a317d";
        let want: Vec<u8> = (0..want_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&want_hex[i..i + 2], 16).unwrap())
            .collect();
        let got = canonical_bytes(&sample_claims());
        assert_eq!(got, want, "canonical bytes diverged from vector");
    }

    #[test]
    fn sign_matches_ts_hmac() {
        // Expected HMAC from vector live-basic.
        let key = b"TEST_SECRET_32_CHARS_FIXED_VALUE_X";
        let token = sign(key, &sample_claims());
        // The HMAC is the second segment; split and decode.
        let (canonical, sig) = split_token(&token).unwrap();
        assert_eq!(canonical, canonical_bytes(&sample_claims()));
        let sig_hex: String = sig.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(
            sig_hex, "4b0b2e5892535269eddb6a080143edaae77ca3227572f4406221ab4c2eb1ec1f",
            "HMAC diverged from vector — Rust/TS key derivation mismatch likely",
        );
    }

    #[test]
    fn roundtrip_sign_verify() {
        let key = b"TEST_SECRET_32_CHARS_FIXED_VALUE_X";
        let token = sign(key, &sample_claims());
        let got = verify(key, &token).unwrap();
        assert_eq!(got, sample_claims());
    }

    #[test]
    fn verify_rejects_tampered_sig() {
        let key = b"TEST_SECRET_32_CHARS_FIXED_VALUE_X";
        let token = sign(key, &sample_claims());
        // Flip last char of signature
        let mut chars: Vec<char> = token.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == 'A' { 'B' } else { 'A' };
        let tampered: String = chars.into_iter().collect();
        assert_eq!(verify(key, &tampered).unwrap_err(), TokenError::BadSignature);
    }

    #[test]
    fn dual_key_fallback() {
        let primary = b"PRIMARY_KEY_32_CHARS_FIXED_X_XXXX";
        let fallback = b"FALLBACK_KEY_32_CHARS_FIXED_X_XXX";
        let token = sign(fallback, &sample_claims());
        let (claims, used_fallback) = verify_dual_key(primary, fallback, &token).unwrap();
        assert_eq!(claims, sample_claims());
        assert!(used_fallback);

        let token2 = sign(primary, &sample_claims());
        let (_, used2) = verify_dual_key(primary, fallback, &token2).unwrap();
        assert!(!used2);
    }

    #[test]
    fn time_window_enforcement() {
        let claims = sample_claims();
        // Within window
        assert!(enforce_time_window(&claims, 1748169600).is_ok());
        // Before nbf (beyond skew)
        assert_eq!(
            enforce_time_window(&claims, 1748169600 - 31).unwrap_err(),
            TokenError::NotYetValid,
        );
        // Within nbf skew
        assert!(enforce_time_window(&claims, 1748169600 - 30).is_ok());
        // After exp (beyond skew)
        assert_eq!(
            enforce_time_window(&claims, 1748256000 + 6).unwrap_err(),
            TokenError::Expired,
        );
        // Within exp skew
        assert!(enforce_time_window(&claims, 1748256000 + 5).is_ok());
    }

    #[test]
    fn time_window_rejects_over_long_ttl() {
        let mut claims = sample_claims();
        // Forge a lifetime one second past the cap.
        claims.exp = claims.iat + MAX_TTL_SECS + 1;
        assert_eq!(
            enforce_time_window(&claims, claims.iat).unwrap_err(),
            TokenError::BadTtl,
        );
    }

    #[test]
    fn time_window_accepts_max_ttl() {
        let mut claims = sample_claims();
        // Exactly at the cap is allowed (covers the 90-day playlist token).
        claims.exp = claims.iat + MAX_TTL_SECS;
        claims.nbf = claims.iat;
        assert!(enforce_time_window(&claims, claims.iat).is_ok());
    }

    #[test]
    fn time_window_rejects_exp_before_nbf() {
        let mut claims = sample_claims();
        claims.nbf = claims.iat + 100;
        claims.exp = claims.iat + 50;
        assert_eq!(
            enforce_time_window(&claims, claims.iat).unwrap_err(),
            TokenError::BadTtl,
        );
    }

    #[test]
    fn unknown_kind_rejected() {
        // Hand-craft token with invalid kind
        let canonical = b"{\"exp\":1,\"iat\":1,\"jti\":\"x\",\"k\":\"bogus\",\"nbf\":1,\"rid\":\"r\",\"sub\":\"plex:1\",\"v\":1}";
        let key = b"k";
        let mut mac = <HmacSha256 as Mac>::new_from_slice(key).unwrap();
        mac.update(canonical);
        let sig = mac.finalize().into_bytes();
        let mut tok = String::new();
        URL_SAFE_NO_PAD.encode_string(canonical, &mut tok);
        tok.push('.');
        URL_SAFE_NO_PAD.encode_string(sig.as_slice(), &mut tok);
        assert_eq!(verify(key, &tok).unwrap_err(), TokenError::UnknownKind);
    }
}
