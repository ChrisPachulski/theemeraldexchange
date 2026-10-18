//! Owner-issued invite codes: how a new member joins the allowlist.
//!
//! A code carries 128 random bits; only its sha256 hex is stored (the input is
//! high-entropy, so a slow KDF would add nothing). The plaintext goes to the
//! admin once and is never stored or logged. The attacker-supplied code is
//! hashed before any lookup, so there is no plaintext timing oracle. Redeem
//! runs under BEGIN IMMEDIATE with a `used_count < max_uses` guard, so
//! concurrent redeems cannot over-spend a code.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::{AuthMode, Error, Result, Role, iso, now_iso, valid_sub};

pub const DEFAULT_EXPIRES_IN_DAYS: f64 = 14.0;

#[derive(Debug, Clone)]
pub struct IssueOptions {
    pub label: Option<String>,
    /// Days until expiry; negative gives an already-expired invite, None never
    /// expires.
    pub expires_in_days: Option<f64>,
    /// Clamped to at least 1.
    pub max_uses: i64,
    /// The role the redeeming member receives ("owner invite" when admin).
    pub role: Role,
}

impl Default for IssueOptions {
    fn default() -> Self {
        IssueOptions {
            label: None,
            expires_in_days: Some(DEFAULT_EXPIRES_IN_DAYS),
            max_uses: 1,
            role: Role::User,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Issued {
    /// Shown to the admin once; never persisted or logged.
    pub code: String,
    pub code_hash_prefix: String,
    pub label: Option<String>,
    pub role: Role,
    pub expires_at: Option<String>,
    pub max_uses: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redeem {
    /// A new member, or a revoked one re-granted. One use burned.
    Created,
    /// The sub is already an active member; no use burned.
    AlreadyMember,
    Invalid,
    Expired,
    Exhausted,
    /// The invite, or the member who issued it, is revoked.
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Active,
    Expired,
    Exhausted,
    Revoked,
}

/// One row of the admin list: never the code or the full hash.
#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub code_hash_prefix: String,
    pub issued_by: String,
    pub label: Option<String>,
    pub role: Role,
    pub expires_at: Option<String>,
    pub max_uses: i64,
    pub used_count: i64,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub status: Status,
}

fn hash_code(code: &str) -> String {
    Sha256::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The first 8 hex chars: the only id safe to log or return.
fn prefix(hash: &str) -> String {
    hash[..8].to_string()
}

pub async fn issue(pool: &SqlitePool, admin_sub: &str, opts: IssueOptions) -> Result<Issued> {
    if !valid_sub(admin_sub) {
        return Err(Error::InvalidSub);
    }
    let code = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 16]>());
    let hash = hash_code(&code);
    let max_uses = opts.max_uses.max(1);
    let now = chrono::Utc::now();
    let expires_at = opts
        .expires_in_days
        .map(|d| iso(now + chrono::Duration::milliseconds((d * 86_400_000.0) as i64)));
    sqlx::query(
        "INSERT INTO invites (code_hash, issued_by, label, role, expires_at, max_uses, used_count, created_at, revoked_at) \
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL)",
    )
    .bind(&hash)
    .bind(admin_sub)
    .bind(&opts.label)
    .bind(opts.role)
    .bind(&expires_at)
    .bind(max_uses)
    .bind(iso(now))
    .execute(pool)
    .await?;
    Ok(Issued {
        code,
        code_hash_prefix: prefix(&hash),
        label: opts.label,
        role: opts.role,
        expires_at,
        max_uses,
    })
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    issued_by: String,
    role: Role,
    expires_at: Option<String>,
    max_uses: i64,
    used_count: i64,
    revoked_at: Option<String>,
}

/// Redeem `code` for an identity-verified sub, creating or re-granting its
/// members row in one transaction.
pub async fn redeem(
    pool: &SqlitePool,
    code: &str,
    sub: &str,
    display_name: Option<&str>,
    auth_mode: AuthMode,
) -> Result<Redeem> {
    if !valid_sub(sub) {
        return Ok(Redeem::Invalid);
    }
    let hash = hash_code(code);
    let now = now_iso();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let invite: Option<InviteRow> = sqlx::query_as(
        "SELECT issued_by, role, expires_at, max_uses, used_count, revoked_at \
         FROM invites WHERE code_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(invite) = invite else {
        return Ok(Redeem::Invalid);
    };
    if invite.revoked_at.is_some() {
        return Ok(Redeem::Revoked);
    }
    let member_revoked = |s: &str| {
        sqlx::query_scalar::<_, Option<String>>("SELECT revoked_at FROM members WHERE sub = ?")
            .bind(s.to_string())
    };
    // A revoked member's invites die with them (an env-only admin has no row).
    if let Some(Some(_)) = member_revoked(&invite.issued_by)
        .fetch_optional(&mut *tx)
        .await?
    {
        return Ok(Redeem::Revoked);
    }
    if invite
        .expires_at
        .as_deref()
        .is_some_and(|e| e < now.as_str())
    {
        return Ok(Redeem::Expired);
    }
    let member = member_revoked(sub).fetch_optional(&mut *tx).await?;
    if let Some(None) = member {
        return Ok(Redeem::AlreadyMember);
    }
    if invite.used_count >= invite.max_uses {
        return Ok(Redeem::Exhausted);
    }

    let write = if member.is_some() {
        // Re-grant, attributed to this invite's issuer.
        "UPDATE members SET revoked_at = NULL, joined_at = ?1, display_name = ?2, role = ?3, \
         auth_mode = ?4, invited_by = ?5 WHERE sub = ?6"
    } else {
        "INSERT INTO members (joined_at, display_name, role, auth_mode, invited_by, sub, revoked_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)"
    };
    sqlx::query(write)
        .bind(&now)
        .bind(display_name)
        .bind(invite.role)
        .bind(auth_mode.as_str())
        .bind(&invite.issued_by)
        .bind(sub)
        .execute(&mut *tx)
        .await?;
    let spent = sqlx::query(
        "UPDATE invites SET used_count = used_count + 1 WHERE code_hash = ? AND used_count < max_uses",
    )
    .bind(&hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if spent == 0 {
        // Lost the last use: dropping tx rolls the member write back.
        return Ok(Redeem::Exhausted);
    }
    tx.commit().await?;
    Ok(Redeem::Created)
}

/// Every invite, newest first, with its derived status.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Summary>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        code_hash: String,
        issued_by: String,
        label: Option<String>,
        role: Role,
        expires_at: Option<String>,
        max_uses: i64,
        used_count: i64,
        created_at: String,
        revoked_at: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT code_hash, issued_by, label, role, expires_at, max_uses, used_count, created_at, revoked_at \
         FROM invites ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    let now = now_iso();
    Ok(rows
        .into_iter()
        .map(|r| {
            let status = if r.revoked_at.is_some() {
                Status::Revoked
            } else if r.expires_at.as_deref().is_some_and(|e| e < now.as_str()) {
                Status::Expired
            } else if r.used_count >= r.max_uses {
                Status::Exhausted
            } else {
                Status::Active
            };
            Summary {
                code_hash_prefix: prefix(&r.code_hash),
                issued_by: r.issued_by,
                label: r.label,
                role: r.role,
                expires_at: r.expires_at,
                max_uses: r.max_uses,
                used_count: r.used_count,
                created_at: r.created_at,
                revoked_at: r.revoked_at,
                status,
            }
        })
        .collect())
}

/// Revoke the one unrevoked invite whose hash starts with `hash_prefix`.
/// False for non-hex, unknown, ambiguous (several matches) or already revoked.
pub async fn revoke(pool: &SqlitePool, hash_prefix: &str) -> Result<bool> {
    if hash_prefix.is_empty()
        || hash_prefix.len() > 64
        || !hash_prefix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Ok(false);
    }
    // Hex only, so the pattern holds no LIKE wildcards.
    let matches: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT code_hash, revoked_at FROM invites WHERE code_hash LIKE ? || '%'")
            .bind(hash_prefix)
            .fetch_all(pool)
            .await?;
    let [(hash, None)] = matches.as_slice() else {
        return Ok(false);
    };
    let changed =
        sqlx::query("UPDATE invites SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL")
            .bind(now_iso())
            .bind(hash)
            .execute(pool)
            .await?
            .rows_affected();
    Ok(changed > 0)
}

#[cfg(test)]
mod tests;
