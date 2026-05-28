//! Device-token mint and verify per §3.
//!
//! JWE wrapping (alg:dir, enc:A256GCM) of a claim set including
//! `aud:'device'`, `iss:'eex'`, `sub`, `role`, `auth_mode`, `device_id`,
//! `device_platform`, `server_id`, `jti`, `iat`, `nbf`, `exp`. Key is
//! `HKDF(DEVICE_TOKEN_SECRET, 'eex/device-token/v1', 32)`.
//!
//! Multi-key verify (kid-aware): caller passes a `HashMap<kid, key>`;
//! the protected header's `kid` selects the active key.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::hkdf::{INFO_DEVICE_TOKEN, derive_key};
use crate::jwe::{self, JweError};

/// Default kid for the v1 device-token key. Bump (`device-v2`, etc.)
/// when rotating; old kid stays in the verifier `HashMap` during the
/// grace window.
pub const DEFAULT_KID: &str = "device-v1";

/// 180-day TTL per contract §3.5. **Locked at 180 days, NOT 1 year**
/// despite design.md's older text — contract wins.
pub const DEFAULT_TTL_SECS: i64 = 180 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceClaims {
    pub aud: String,
    pub iss: String,
    pub sub: String,
    pub role: String,
    /// 'plex' | 'local' | 'apple' per §3.2. 'guest' is M6-reserved (§19.2).
    pub auth_mode: String,
    pub device_id: String,
    pub device_platform: String,
    pub server_id: String,
    pub jti: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
}

#[derive(Debug)]
pub enum DeviceTokenError {
    Jwe(JweError),
    BadPayload,
    UnsupportedAud,
    UnsupportedIss,
    NotYetValid,
    Expired,
    UnknownKid(String),
}

impl From<JweError> for DeviceTokenError {
    fn from(e: JweError) -> Self {
        DeviceTokenError::Jwe(e)
    }
}

/// Mint a device-token JWE. Caller derives the key once at startup via
/// `derive_key(DEVICE_TOKEN_SECRET, INFO_DEVICE_TOKEN)` and reuses for
/// every mint.
pub fn encrypt(key: &[u8; 32], kid: &str, claims: &DeviceClaims) -> String {
    let json = serde_json::to_vec(claims).expect("DeviceClaims serializes");
    jwe::encrypt(key, kid, &json)
}

/// Mint with the default kid `device-v1` using a freshly-derived key
/// from the raw secret. Prefer the `encrypt` path with a cached key in
/// hot paths.
pub fn encrypt_with_secret(secret: &[u8], claims: &DeviceClaims) -> String {
    let key = derive_key(secret, INFO_DEVICE_TOKEN);
    encrypt(&key, DEFAULT_KID, claims)
}

/// Verify a device-token JWE with a kid-keyed key map. Resolves the
/// active key by reading the protected header's kid; returns
/// `UnknownKid` if the kid is not in the map (rotation safety —
/// missing kid is rejected, never silently accepted).
pub fn decrypt(
    keys: &HashMap<String, [u8; 32]>,
    token: &str,
) -> Result<DeviceClaims, DeviceTokenError> {
    let (hdr, _) = jwe::decode_protected_header(token)?;
    let key = keys
        .get(&hdr.kid)
        .ok_or(DeviceTokenError::UnknownKid(hdr.kid.clone()))?;
    let plain = jwe::decrypt_with_key(key, token)?;
    let claims: DeviceClaims =
        serde_json::from_slice(&plain).map_err(|_| DeviceTokenError::BadPayload)?;
    if claims.aud != "device" {
        return Err(DeviceTokenError::UnsupportedAud);
    }
    if claims.iss != "eex" {
        return Err(DeviceTokenError::UnsupportedIss);
    }
    Ok(claims)
}

/// Enforce nbf/exp against `now`. Same skew constants as stream tokens
/// (NBF_SKEW_SECS=30, EXP_SKEW_SECS=5) per contract §3.5.
pub fn enforce_time_window(claims: &DeviceClaims, now: i64) -> Result<(), DeviceTokenError> {
    if now + crate::stream_token::NBF_SKEW_SECS < claims.nbf {
        return Err(DeviceTokenError::NotYetValid);
    }
    if now - crate::stream_token::EXP_SKEW_SECS > claims.exp {
        return Err(DeviceTokenError::Expired);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_claims() -> DeviceClaims {
        DeviceClaims {
            aud: "device".to_string(),
            iss: "eex".to_string(),
            sub: "plex:12345".to_string(),
            role: "user".to_string(),
            auth_mode: "plex".to_string(),
            device_id: "01HABCDEFGHJKMNPQRSTVWXYZ0".to_string(),
            device_platform: "tvos".to_string(),
            server_id: "abc123-server-uuid".to_string(),
            jti: "01HWXYZ01234567890ABCDEFGH".to_string(),
            iat: 1748169600,
            nbf: 1748169600,
            exp: 1748169600 + DEFAULT_TTL_SECS,
        }
    }

    #[test]
    fn roundtrip() {
        let key = derive_key(
            b"test-secret-test-secret-test-secret-test-secret",
            INFO_DEVICE_TOKEN,
        );
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        let token = encrypt(&key, DEFAULT_KID, &sample_claims());
        let got = decrypt(&keys, &token).unwrap();
        assert_eq!(got, sample_claims());
    }

    #[test]
    fn unknown_kid_rejected() {
        let key = derive_key(b"x", INFO_DEVICE_TOKEN);
        let keys: HashMap<String, [u8; 32]> = HashMap::new(); // empty — no kids
        let token = encrypt(&key, "device-v1", &sample_claims());
        match decrypt(&keys, &token).unwrap_err() {
            DeviceTokenError::UnknownKid(k) => assert_eq!(k, "device-v1"),
            e => panic!("expected UnknownKid, got {:?}", e),
        }
    }

    #[test]
    fn kid_rotation_two_keys() {
        let k_old = derive_key(b"old-secret-32-chars-fixed-padding", INFO_DEVICE_TOKEN);
        let k_new = derive_key(b"new-secret-32-chars-fixed-padding", INFO_DEVICE_TOKEN);
        let mut keys = HashMap::new();
        keys.insert("device-v1".to_string(), k_old);
        keys.insert("device-v2".to_string(), k_new);

        let old_token = encrypt(&k_old, "device-v1", &sample_claims());
        let new_token = encrypt(&k_new, "device-v2", &sample_claims());

        assert!(decrypt(&keys, &old_token).is_ok());
        assert!(decrypt(&keys, &new_token).is_ok());
    }

    #[test]
    fn aud_rejection() {
        let key = derive_key(b"x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x", INFO_DEVICE_TOKEN);
        let mut claims = sample_claims();
        claims.aud = "session".to_string();
        let token = encrypt(&key, DEFAULT_KID, &claims);
        let mut keys = HashMap::new();
        keys.insert(DEFAULT_KID.to_string(), key);
        match decrypt(&keys, &token).unwrap_err() {
            DeviceTokenError::UnsupportedAud => {}
            e => panic!("expected UnsupportedAud, got {:?}", e),
        }
    }

    #[test]
    fn time_window() {
        let claims = sample_claims();
        assert!(enforce_time_window(&claims, claims.iat).is_ok());
        // Beyond exp + skew
        assert!(matches!(
            enforce_time_window(&claims, claims.exp + 10).unwrap_err(),
            DeviceTokenError::Expired,
        ));
    }
}
