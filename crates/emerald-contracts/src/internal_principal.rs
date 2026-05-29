//! Internal-principal JWE per §4 Hybrid D.
//!
//! Hono mints, Rust services (M3 media-core, M4 transcoder) verify. The
//! claim set carries the *requestor's* identity across the internal
//! service boundary so M3/M4 don't need to verify session cookies or
//! device tokens themselves.
//!
//! Key: `HKDF(INTERNAL_PRINCIPAL_SECRET, 'eex/internal-principal/v1', 32)`.
//! TTL: 60 seconds (enforced by verifier).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hkdf::{derive_key, INFO_INTERNAL_PRINCIPAL};
use crate::jwe::{self, JweError};

pub const DEFAULT_KID: &str = "internal-v1";
pub const DEFAULT_TTL_SECS: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InternalClaims {
    pub iss: String,
    pub sub: String,
    pub role: String,
    pub auth_mode: String,
    pub server_id: String,
    pub device_id: Option<String>,
    pub req_id: String,
    pub iat: i64,
    pub exp: i64,
}

#[derive(Debug)]
pub enum InternalPrincipalError {
    Jwe(JweError),
    BadPayload,
    UnsupportedIss,
    Expired,
    /// `exp - iat` exceeds `DEFAULT_TTL_SECS`, or `exp < iat`. A well-formed
    /// minter always sets `exp = iat + DEFAULT_TTL_SECS`; a longer (or
    /// inverted) window means a forged claim set and is rejected at decrypt
    /// time so the documented "60s TTL enforced by verifier" is actually true.
    BadTtl,
    UnknownKid(String),
}

impl From<JweError> for InternalPrincipalError {
    fn from(e: JweError) -> Self {
        InternalPrincipalError::Jwe(e)
    }
}

pub fn encrypt(key: &[u8; 32], kid: &str, claims: &InternalClaims) -> String {
    let json = serde_json::to_vec(claims).expect("InternalClaims serializes");
    jwe::encrypt(key, kid, &json)
}

pub fn encrypt_with_secret(secret: &[u8], claims: &InternalClaims) -> String {
    let key = derive_key(secret, INFO_INTERNAL_PRINCIPAL);
    encrypt(&key, DEFAULT_KID, claims)
}

pub fn decrypt(
    keys: &HashMap<String, [u8; 32]>,
    token: &str,
) -> Result<InternalClaims, InternalPrincipalError> {
    let (hdr, _) = jwe::decode_protected_header(token)?;
    let key = keys
        .get(&hdr.kid)
        .ok_or(InternalPrincipalError::UnknownKid(hdr.kid.clone()))?;
    let plain = jwe::decrypt_with_key(key, token)?;
    let claims: InternalClaims =
        serde_json::from_slice(&plain).map_err(|_| InternalPrincipalError::BadPayload)?;
    if claims.iss != "eex" {
        return Err(InternalPrincipalError::UnsupportedIss);
    }
    // Defense-in-depth: bound the lifetime claimed by the token. Under
    // INTERNAL_PRINCIPAL_SECRET compromise an attacker could otherwise mint
    // `exp = iat + 1 year` and replay it indefinitely. The contract states a
    // hard 60s TTL "enforced by verifier" — enforce it here, against the
    // token's own iat, so the bound holds regardless of the caller's clock.
    if claims.exp < claims.iat || claims.exp - claims.iat > DEFAULT_TTL_SECS {
        return Err(InternalPrincipalError::BadTtl);
    }
    Ok(claims)
}

/// Hard-enforce 60s TTL window. No `nbf` skew applied — internal
/// principal is for a single in-flight request, must be fresh.
pub fn enforce_time_window(claims: &InternalClaims, now: i64) -> Result<(), InternalPrincipalError> {
    if now > claims.exp {
        return Err(InternalPrincipalError::Expired);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_claims() -> InternalClaims {
        InternalClaims {
            iss: "eex".to_string(),
            sub: "plex:12345".to_string(),
            role: "user".to_string(),
            auth_mode: "plex".to_string(),
            server_id: "abc-uuid".to_string(),
            device_id: Some("01HABCDEFGHJKMNPQRSTVWXYZ0".to_string()),
            req_id: "req-1".to_string(),
            iat: 1748169600,
            exp: 1748169600 + DEFAULT_TTL_SECS,
        }
    }

    #[test]
    fn roundtrip() {
        let key = derive_key(b"x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x", INFO_INTERNAL_PRINCIPAL);
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        let token = encrypt(&key, DEFAULT_KID, &sample_claims());
        let got = decrypt(&keys, &token).unwrap();
        assert_eq!(got, sample_claims());
    }

    #[test]
    fn ttl_enforcement() {
        let claims = sample_claims();
        assert!(enforce_time_window(&claims, claims.iat).is_ok());
        assert!(enforce_time_window(&claims, claims.exp + 1).is_err());
    }

    #[test]
    fn decrypt_rejects_over_long_ttl() {
        let key = derive_key(b"x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x", INFO_INTERNAL_PRINCIPAL);
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        // Forge a token whose exp is one year past iat — well over the 60s cap.
        let mut forged = sample_claims();
        forged.exp = forged.iat + 365 * 24 * 60 * 60;
        let token = encrypt(&key, DEFAULT_KID, &forged);
        assert!(matches!(
            decrypt(&keys, &token),
            Err(InternalPrincipalError::BadTtl)
        ));
    }

    #[test]
    fn decrypt_rejects_inverted_window() {
        let key = derive_key(b"x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x", INFO_INTERNAL_PRINCIPAL);
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        // exp < iat is nonsensical and must be rejected.
        let mut forged = sample_claims();
        forged.exp = forged.iat - 1;
        let token = encrypt(&key, DEFAULT_KID, &forged);
        assert!(matches!(
            decrypt(&keys, &token),
            Err(InternalPrincipalError::BadTtl)
        ));
    }

    #[test]
    fn decrypt_accepts_exact_ttl() {
        let key = derive_key(b"x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x", INFO_INTERNAL_PRINCIPAL);
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        // exp == iat + DEFAULT_TTL_SECS is the canonical minter shape.
        let token = encrypt(&key, DEFAULT_KID, &sample_claims());
        assert!(decrypt(&keys, &token).is_ok());
    }
}
