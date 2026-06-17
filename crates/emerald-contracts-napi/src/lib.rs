//! N-API binding for `emerald-contracts`. Hono imports this via
//! `require('@emerald/contracts-napi')` and calls the exposed functions
//! instead of `jose.EncryptJWT` / `node:crypto.createHmac`.
//!
//! Build: `cd crates/emerald-contracts-napi && napi build --release`.
//! Output: `index.node` + auto-generated TS types.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;

use emerald_contracts::{
    INFO_DEVICE_TOKEN, INFO_INTERNAL_PRINCIPAL, INFO_SESSION, derive_key as ec_derive_key,
    device_token, internal_principal, parse_sub as ec_parse_sub, stream_token, sub::Provider,
    telemetry::scrub_value,
};

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct DerivedKey {
    /// 32-byte derived key as a Buffer.
    pub bytes: Buffer,
}

#[napi]
pub fn hkdf_session(secret: Buffer) -> DerivedKey {
    DerivedKey {
        bytes: ec_derive_key(secret.as_ref(), INFO_SESSION).to_vec().into(),
    }
}

#[napi]
pub fn hkdf_device_token(secret: Buffer) -> DerivedKey {
    DerivedKey {
        bytes: ec_derive_key(secret.as_ref(), INFO_DEVICE_TOKEN)
            .to_vec()
            .into(),
    }
}

#[napi]
pub fn hkdf_internal_principal(secret: Buffer) -> DerivedKey {
    DerivedKey {
        bytes: ec_derive_key(secret.as_ref(), INFO_INTERNAL_PRINCIPAL)
            .to_vec()
            .into(),
    }
}

/// Generic HKDF-Extract+Expand (RFC 5869, SHA-256, zero-length salt,
/// 32-byte OKM) with a caller-supplied info label. This backs the
/// production `deriveKey(secret, info)` in
/// `server/services/keyDerivation.ts` so TS has no parallel HKDF
/// implementation. Callers MUST pass one of the frozen `INFO_*` labels —
/// the label is part of the wire contract and changing it silently
/// rotates every key derived under it (see `emerald_contracts::hkdf`).
/// The fixed-label wrappers above remain for surfaces (PyO3 parity,
/// cross-binding tests) that want the label locked at the binding edge.
#[napi]
pub fn hkdf_derive(secret: Buffer, info: String) -> DerivedKey {
    DerivedKey {
        bytes: ec_derive_key(secret.as_ref(), info.as_bytes())
            .to_vec()
            .into(),
    }
}

// ---------------------------------------------------------------------------
// Stream tokens
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct StreamClaimsJs {
    pub exp: i64,
    pub iat: i64,
    pub jti: String,
    pub k: String,
    pub nbf: i64,
    pub rid: String,
    pub sub: String,
    pub v: u32,
}

fn claims_from_js(c: &StreamClaimsJs) -> Result<stream_token::StreamClaims> {
    let kind = stream_token::StreamKind::from_wire(&c.k)
        .ok_or_else(|| Error::from_reason(format!("unknown stream kind: {}", c.k)))?;
    Ok(stream_token::StreamClaims {
        exp: c.exp,
        iat: c.iat,
        jti: c.jti.clone(),
        k: kind,
        nbf: c.nbf,
        rid: c.rid.clone(),
        sub: c.sub.clone(),
        v: c.v,
    })
}

fn claims_to_js(c: stream_token::StreamClaims) -> StreamClaimsJs {
    StreamClaimsJs {
        exp: c.exp,
        iat: c.iat,
        jti: c.jti,
        k: c.k.as_wire().to_string(),
        nbf: c.nbf,
        rid: c.rid,
        sub: c.sub,
        v: c.v,
    }
}

#[napi]
pub fn stream_token_sign(secret: Buffer, claims: StreamClaimsJs) -> Result<String> {
    let parsed = claims_from_js(&claims)?;
    Ok(stream_token::sign(secret.as_ref(), &parsed))
}

#[napi]
pub fn stream_token_verify(secret: Buffer, token: String) -> Result<StreamClaimsJs> {
    let c = stream_token::verify(secret.as_ref(), &token)
        .map_err(|e| Error::from_reason(format!("verify failed: {:?}", e)))?;
    Ok(claims_to_js(c))
}

#[napi(object)]
pub struct DualKeyVerifyResult {
    pub claims: StreamClaimsJs,
    pub used_fallback: bool,
}

#[napi]
pub fn stream_token_verify_dual_key(
    primary: Buffer,
    fallback: Buffer,
    token: String,
) -> Result<DualKeyVerifyResult> {
    let (c, used) = stream_token::verify_dual_key(primary.as_ref(), fallback.as_ref(), &token)
        .map_err(|e| Error::from_reason(format!("verify failed: {:?}", e)))?;
    Ok(DualKeyVerifyResult {
        claims: claims_to_js(c),
        used_fallback: used,
    })
}

#[napi]
pub fn stream_token_enforce_time_window(claims: StreamClaimsJs, now_secs: i64) -> Result<()> {
    let parsed = claims_from_js(&claims)?;
    stream_token::enforce_time_window(&parsed, now_secs)
        .map_err(|e| Error::from_reason(format!("{:?}", e)))
}

// ---------------------------------------------------------------------------
// Device tokens (kid-aware multi-key dispatch)
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct DeviceClaimsJs {
    pub aud: String,
    pub iss: String,
    pub sub: String,
    pub role: String,
    pub auth_mode: String,
    pub device_id: String,
    pub device_platform: String,
    pub server_id: String,
    pub jti: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
}

fn dev_from_js(c: &DeviceClaimsJs) -> device_token::DeviceClaims {
    device_token::DeviceClaims {
        aud: c.aud.clone(),
        iss: c.iss.clone(),
        sub: c.sub.clone(),
        role: c.role.clone(),
        auth_mode: c.auth_mode.clone(),
        device_id: c.device_id.clone(),
        device_platform: c.device_platform.clone(),
        server_id: c.server_id.clone(),
        jti: c.jti.clone(),
        iat: c.iat,
        nbf: c.nbf,
        exp: c.exp,
    }
}

fn dev_to_js(c: device_token::DeviceClaims) -> DeviceClaimsJs {
    DeviceClaimsJs {
        aud: c.aud,
        iss: c.iss,
        sub: c.sub,
        role: c.role,
        auth_mode: c.auth_mode,
        device_id: c.device_id,
        device_platform: c.device_platform,
        server_id: c.server_id,
        jti: c.jti,
        iat: c.iat,
        nbf: c.nbf,
        exp: c.exp,
    }
}

#[napi]
pub fn device_token_encrypt(key: Buffer, kid: String, claims: DeviceClaimsJs) -> Result<String> {
    let key_arr: [u8; 32] = key
        .as_ref()
        .try_into()
        .map_err(|_| Error::from_reason("device key must be exactly 32 bytes"))?;
    Ok(device_token::encrypt(&key_arr, &kid, &dev_from_js(&claims)))
}

#[napi(object)]
pub struct KidKey {
    pub kid: String,
    pub key: Buffer,
}

#[napi]
pub fn device_token_decrypt(keys: Vec<KidKey>, token: String) -> Result<DeviceClaimsJs> {
    let mut map: HashMap<String, [u8; 32]> = HashMap::new();
    for kk in keys {
        let arr: [u8; 32] = kk
            .key
            .as_ref()
            .try_into()
            .map_err(|_| Error::from_reason("each device key must be exactly 32 bytes"))?;
        map.insert(kk.kid, arr);
    }
    let c =
        device_token::decrypt(&map, &token).map_err(|e| Error::from_reason(format!("{:?}", e)))?;
    Ok(dev_to_js(c))
}

// ---------------------------------------------------------------------------
// Internal principal
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct InternalClaimsJs {
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

fn int_from_js(c: &InternalClaimsJs) -> internal_principal::InternalClaims {
    internal_principal::InternalClaims {
        iss: c.iss.clone(),
        sub: c.sub.clone(),
        role: c.role.clone(),
        auth_mode: c.auth_mode.clone(),
        server_id: c.server_id.clone(),
        device_id: c.device_id.clone(),
        req_id: c.req_id.clone(),
        iat: c.iat,
        exp: c.exp,
    }
}

#[napi]
pub fn internal_principal_encrypt(
    key: Buffer,
    kid: String,
    claims: InternalClaimsJs,
) -> Result<String> {
    let key_arr: [u8; 32] = key
        .as_ref()
        .try_into()
        .map_err(|_| Error::from_reason("internal-principal key must be exactly 32 bytes"))?;
    Ok(internal_principal::encrypt(
        &key_arr,
        &kid,
        &int_from_js(&claims),
    ))
}

// ---------------------------------------------------------------------------
// Sub-namespace parsing
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct SubJs {
    pub provider: String,
    pub id: String,
    pub raw: String,
}

#[napi]
pub fn parse_sub(s: String) -> Result<SubJs> {
    let parsed = ec_parse_sub(&s).map_err(|e| Error::from_reason(format!("{:?}", e)))?;
    let provider = match parsed.provider {
        Provider::Plex => "plex",
        Provider::Local => "local",
        Provider::Apple => "apple",
        Provider::Google => "google",
    };
    Ok(SubJs {
        provider: provider.to_string(),
        id: parsed.id,
        raw: parsed.raw,
    })
}

// ---------------------------------------------------------------------------
// Telemetry PII scrub
// ---------------------------------------------------------------------------

#[napi]
pub fn pii_scrub_keys() -> Vec<&'static str> {
    emerald_contracts::telemetry::PII_KEYS.to_vec()
}

#[napi]
pub fn pii_scrub_value(json_str: String) -> Result<String> {
    let mut v: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| Error::from_reason(format!("{}", e)))?;
    scrub_value(&mut v);
    serde_json::to_string(&v).map_err(|e| Error::from_reason(format!("{}", e)))
}
