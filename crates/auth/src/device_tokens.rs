//! Device tokens: the 180-day bearer JWEs paired Apple devices send. The wire
//! format is emerald-contracts' (`device_token`); this module owns the
//! server.db side: every minted jti gets a `device_tokens` row, and a token
//! verifies only while that row is live and its jti is not in
//! `device_token_revocations`.

use std::collections::HashMap;

use emerald_contracts::device_token::{self, DEFAULT_KID, DEFAULT_TTL_SECS};
use emerald_contracts::{DeviceClaims, INFO_DEVICE_TOKEN, derive_key};
use sqlx::SqlitePool;

use crate::{AuthMode, Error, Result, Role, iso, valid_sub};

/// Verify keys by kid. Today one kid (`device-v1`); a rotation adds the new
/// kid here and mints with it while the old one stays for the grace window.
#[derive(Clone)]
pub struct Keys {
    keys: HashMap<String, [u8; 32]>,
}

impl Keys {
    /// HKDF(DEVICE_TOKEN_SECRET, 'eex/device-token/v1') under `device-v1`.
    pub fn from_secret(secret: &str) -> Keys {
        Keys {
            keys: HashMap::from([(
                DEFAULT_KID.to_string(),
                derive_key(secret.as_bytes(), INFO_DEVICE_TOKEN),
            )]),
        }
    }
}

pub struct MintInput<'a> {
    pub sub: &'a str,
    pub role: Role,
    pub auth_mode: AuthMode,
    /// Client-generated ULID kept in the device keychain.
    pub device_id: &'a str,
    /// Advisory ('tvos' | 'ios' | 'ipados' | 'macos'), never rejected.
    pub device_platform: &'a str,
    /// UI label, stored in the row (mutable), not in the token.
    pub device_name: &'a str,
    /// The identity's display name at pairing, stored in the row.
    pub username: Option<&'a str>,
    pub server_id: &'a str,
}

fn iso_secs(secs: i64) -> String {
    iso(chrono::DateTime::from_timestamp(secs, 0).unwrap_or_default())
}

/// Mint a token and insert its row.
pub async fn mint(pool: &SqlitePool, keys: &Keys, input: &MintInput<'_>) -> Result<String> {
    if !valid_sub(input.sub) {
        return Err(Error::InvalidSub);
    }
    let now = chrono::Utc::now().timestamp();
    let exp = now + DEFAULT_TTL_SECS;
    let jti = ulid::Ulid::generate().to_string();
    let claims = DeviceClaims {
        aud: "device".into(),
        iss: "eex".into(),
        sub: input.sub.into(),
        role: input.role.as_str().into(),
        auth_mode: input.auth_mode.as_str().into(),
        device_id: input.device_id.into(),
        device_platform: input.device_platform.into(),
        server_id: input.server_id.into(),
        jti: jti.clone(),
        iat: now,
        nbf: now,
        exp,
    };
    let token = device_token::encrypt(&keys.keys[DEFAULT_KID], DEFAULT_KID, &claims);
    sqlx::query(
        "INSERT INTO device_tokens \
         (jti, sub, device_id, device_name, username, platform, server_id, kid, issued_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&jti)
    .bind(input.sub)
    .bind(input.device_id)
    .bind(input.device_name)
    .bind(input.username)
    .bind(input.device_platform)
    .bind(input.server_id)
    .bind(DEFAULT_KID)
    .bind(iso_secs(now))
    .bind(iso_secs(exp))
    .execute(pool)
    .await?;
    Ok(token)
}

/// Verify `token` at unix time `now`: a known kid decrypts it, aud/iss/role/
/// auth_mode are valid, nbf/exp hold (30 s / 5 s skew), its row exists and has
/// not expired, and its jti is not revoked. None on any failure.
pub async fn verify(
    pool: &SqlitePool,
    keys: &Keys,
    token: &str,
    now: i64,
) -> Result<Option<DeviceClaims>> {
    let Ok(claims) = device_token::decrypt(&keys.keys, token) else {
        return Ok(None);
    };
    if Role::parse(&claims.role).is_none() || AuthMode::parse(&claims.auth_mode).is_none() {
        return Ok(None);
    }
    if let Err(e) = device_token::enforce_time_window(&claims, now) {
        tracing::warn!(jti = %claims.jti, "device token outside its time window: {e:?}");
        return Ok(None);
    }
    let live: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM device_tokens WHERE jti = ? AND expires_at > ? \
         AND NOT EXISTS (SELECT 1 FROM device_token_revocations r WHERE r.jti = device_tokens.jti)",
    )
    .bind(&claims.jti)
    .bind(iso_secs(now))
    .fetch_optional(pool)
    .await?;
    if live.is_none() {
        tracing::warn!(jti = %claims.jti, "device token row missing, expired or revoked");
        return Ok(None);
    }
    Ok(Some(claims))
}

/// Revoke one jti. Idempotent.
pub async fn revoke(pool: &SqlitePool, jti: &str, reason: &str) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason) \
         VALUES (?, datetime('now'), ?)",
    )
    .bind(jti)
    .bind(reason)
    .execute(pool)
    .await?;
    Ok(())
}

/// Revoke every token of `sub` (membership revoked or never granted).
/// Idempotent; returns how many tokens the sub holds.
pub async fn cascade_revoke_for_sub(pool: &SqlitePool, sub: &str, reason: &str) -> Result<u64> {
    let mut tx = pool.begin().await?;
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_tokens WHERE sub = ?")
        .bind(sub)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO device_token_revocations (jti, revoked_at, reason) \
         SELECT jti, datetime('now'), ? FROM device_tokens WHERE sub = ?",
    )
    .bind(reason)
    .bind(sub)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(n as u64)
}

/// Delete rows past `expires_at` (they can no longer verify). Returns the count.
pub async fn sweep_expired(pool: &SqlitePool, now_iso: &str) -> Result<u64> {
    Ok(
        sqlx::query("DELETE FROM device_tokens WHERE expires_at < ?")
            .bind(now_iso)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}

#[cfg(test)]
mod tests;
