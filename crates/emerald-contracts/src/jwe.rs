//! JWE compact serialization (alg:dir, enc:A256GCM) — shared by
//! `device_token` and `internal_principal`.
//!
//! Per contract §4 Hybrid D: hand-rolled with `aes-gcm` (RustCrypto).
//! `josekit` is PROHIBITED; `jsonwebtoken` does not support JWE.
//!
//! Compact form: `b64u(header).b64u("").b64u(iv).b64u(ciphertext).b64u(tag)`
//! where `b64u("")` is the empty string for alg:dir (no encrypted key).
//!
//! AAD = the ASCII bytes of the encoded protected header (segment 1).
//! Tag and ciphertext are split from `aes-gcm`'s combined output.

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JweError {
    Malformed,
    BadBase64,
    BadHeader,
    UnknownKid,
    DecryptFailed,
    BadPayload,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProtectedHeader<'a> {
    alg: &'a str,
    enc: &'a str,
    kid: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProtectedHeaderOwned {
    pub alg: String,
    pub enc: String,
    pub kid: String,
}

/// Encrypt `plaintext` (typically a JSON claim set as bytes) into a JWE
/// compact string. Random 12-byte nonce per call via `OsRng` (nonce
/// reuse with the same key is catastrophic; counter-based nonces are
/// PROHIBITED).
pub fn encrypt(key: &[u8; 32], kid: &str, plaintext: &[u8]) -> String {
    let header = ProtectedHeader {
        alg: "dir",
        enc: "A256GCM",
        kid,
    };
    let header_json = serde_json::to_vec(&header).expect("static header serializes");
    let header_b64 = URL_SAFE_NO_PAD.encode(&header_json);

    let cipher = Aes256Gcm::new(key.into());
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    // AAD = the encoded protected header (ASCII bytes).
    let aad = header_b64.as_bytes();
    let combined = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("aes-gcm encrypt with random nonce should not fail");

    // aes-gcm returns ciphertext || tag (tag is the last 16 bytes).
    debug_assert!(combined.len() >= 16);
    let split = combined.len() - 16;
    let ciphertext = &combined[..split];
    let tag = &combined[split..];

    let mut out = String::with_capacity(header_b64.len() + 64);
    out.push_str(&header_b64);
    out.push('.');
    // Empty encrypted-key segment for alg:dir.
    out.push('.');
    URL_SAFE_NO_PAD.encode_string(nonce.as_slice(), &mut out);
    out.push('.');
    URL_SAFE_NO_PAD.encode_string(ciphertext, &mut out);
    out.push('.');
    URL_SAFE_NO_PAD.encode_string(tag, &mut out);
    out
}

/// Decode the protected header without decrypting — used for kid
/// dispatch. Returns `(header, header_b64_bytes)`. The bytes are needed
/// because they serve as AAD in the decrypt call.
pub fn decode_protected_header(token: &str) -> Result<(ProtectedHeaderOwned, Vec<u8>), JweError> {
    let header_b64 = token.split('.').next().ok_or(JweError::Malformed)?;
    let header_bytes = URL_SAFE_NO_PAD
        .decode(header_b64)
        .map_err(|_| JweError::BadBase64)?;
    let hdr: ProtectedHeaderOwned =
        serde_json::from_slice(&header_bytes).map_err(|_| JweError::BadHeader)?;
    if hdr.alg != "dir" || hdr.enc != "A256GCM" {
        return Err(JweError::BadHeader);
    }
    Ok((hdr, header_b64.as_bytes().to_vec()))
}

/// Decrypt a JWE compact token with the given 32-byte key. Caller
/// resolved the key via `decode_protected_header` + a kid lookup.
pub fn decrypt_with_key(key: &[u8; 32], token: &str) -> Result<Vec<u8>, JweError> {
    let mut parts = token.split('.');
    let header_b64 = parts.next().ok_or(JweError::Malformed)?;
    let _enc_key = parts.next().ok_or(JweError::Malformed)?; // empty for alg:dir
    let iv_b64 = parts.next().ok_or(JweError::Malformed)?;
    let ct_b64 = parts.next().ok_or(JweError::Malformed)?;
    let tag_b64 = parts.next().ok_or(JweError::Malformed)?;
    if parts.next().is_some() {
        return Err(JweError::Malformed);
    }

    let iv = URL_SAFE_NO_PAD
        .decode(iv_b64)
        .map_err(|_| JweError::BadBase64)?;
    let ct = URL_SAFE_NO_PAD
        .decode(ct_b64)
        .map_err(|_| JweError::BadBase64)?;
    let tag = URL_SAFE_NO_PAD
        .decode(tag_b64)
        .map_err(|_| JweError::BadBase64)?;
    if iv.len() != 12 || tag.len() != 16 {
        return Err(JweError::Malformed);
    }

    let mut combined = ct;
    combined.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new(key.into());
    let aad = header_b64.as_bytes();
    let nonce = Nonce::from_slice(&iv);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &combined,
                aad,
            },
        )
        .map_err(|_| JweError::DecryptFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_basic() {
        let key = [42u8; 32];
        let plain = b"hello world";
        let token = encrypt(&key, "test-v1", plain);
        let got = decrypt_with_key(&key, &token).unwrap();
        assert_eq!(got, plain);
    }

    #[test]
    fn wrong_key_fails() {
        let key = [42u8; 32];
        let wrong = [43u8; 32];
        let token = encrypt(&key, "test-v1", b"secret");
        assert_eq!(
            decrypt_with_key(&wrong, &token).unwrap_err(),
            JweError::DecryptFailed
        );
    }

    #[test]
    fn nonce_uniqueness() {
        let key = [42u8; 32];
        let plain = b"same plaintext";
        let t1 = encrypt(&key, "test-v1", plain);
        let t2 = encrypt(&key, "test-v1", plain);
        // Two encrypts of the same plaintext MUST differ — random nonce.
        // If equal, nonce was deterministic = catastrophic AES-GCM failure.
        assert_ne!(t1, t2);
    }

    #[test]
    fn header_decode() {
        let key = [42u8; 32];
        let token = encrypt(&key, "device-v1", b"x");
        let (hdr, b64) = decode_protected_header(&token).unwrap();
        assert_eq!(hdr.alg, "dir");
        assert_eq!(hdr.enc, "A256GCM");
        assert_eq!(hdr.kid, "device-v1");
        assert!(!b64.is_empty());
    }

    #[test]
    fn rejects_wrong_alg() {
        // Tamper with header before decrypting — should fail header parse.
        let key = [42u8; 32];
        let token = encrypt(&key, "x", b"y");
        let bad_header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RSA-OAEP","enc":"A256GCM","kid":"x"}"#);
        let rest: String = token.split('.').skip(1).collect::<Vec<_>>().join(".");
        let mut tampered = bad_header;
        tampered.push('.');
        tampered.push_str(&rest);
        assert_eq!(
            decode_protected_header(&tampered).unwrap_err(),
            JweError::BadHeader
        );
    }
}
