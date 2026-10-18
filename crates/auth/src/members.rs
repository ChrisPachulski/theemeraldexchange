//! The `members` allowlist: authorization only. Identity is proven upstream
//! (Apple, Google, WorkOS); these functions answer whether a proven sub is let
//! in and with which role. A sub is allowed iff it is in ADMIN_SUBS (owner
//! bootstrap) or has a members row with `revoked_at IS NULL`.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::{Result, Role, now_iso, valid_sub};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, sqlx::FromRow)]
pub struct Member {
    pub sub: String,
    pub display_name: Option<String>,
    pub role: Role,
    /// A string, not [`crate::AuthMode`]: rows written by Plex sign-in stay
    /// readable for the admin list.
    pub auth_mode: String,
    pub invited_by: Option<String>,
    pub joined_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberStatus {
    Allowed,
    /// Has a row whose access was revoked; the caller cascades device tokens.
    Revoked,
    NotMember,
}

/// The single authZ verdict for an identity-verified sub. ADMIN_SUBS wins
/// before any DB read; a malformed sub fails closed to `NotMember`.
pub async fn member_status(
    pool: &SqlitePool,
    admin_subs: &[String],
    sub: &str,
) -> Result<MemberStatus> {
    if !valid_sub(sub) {
        return Ok(MemberStatus::NotMember);
    }
    if admin_subs.iter().any(|s| s == sub) {
        return Ok(MemberStatus::Allowed);
    }
    let row: Option<Option<String>> =
        sqlx::query_scalar("SELECT revoked_at FROM members WHERE sub = ?")
            .bind(sub)
            .fetch_optional(pool)
            .await?;
    Ok(match row {
        Some(None) => MemberStatus::Allowed,
        Some(Some(_)) => MemberStatus::Revoked,
        None => MemberStatus::NotMember,
    })
}

/// The active row for `sub`, or None when unknown, revoked or malformed.
pub async fn is_member(pool: &SqlitePool, sub: &str) -> Result<Option<Member>> {
    if !valid_sub(sub) {
        return Ok(None);
    }
    let row: Option<Member> = sqlx::query_as(
        "SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at \
         FROM members WHERE sub = ? AND revoked_at IS NULL",
    )
    .bind(sub)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Admin when the sub is in ADMIN_SUBS or has an active row with role admin.
pub async fn effective_role(pool: &SqlitePool, admin_subs: &[String], sub: &str) -> Result<Role> {
    if admin_subs.iter().any(|s| s == sub) {
        return Ok(Role::Admin);
    }
    Ok(match is_member(pool, sub).await? {
        Some(m) if m.role == Role::Admin => Role::Admin,
        _ => Role::User,
    })
}

/// Every member, active and revoked, newest first (the admin list).
pub async fn list(pool: &SqlitePool) -> Result<Vec<Member>> {
    Ok(sqlx::query_as(
        "SELECT sub, display_name, role, auth_mode, invited_by, joined_at, revoked_at \
         FROM members ORDER BY joined_at DESC",
    )
    .fetch_all(pool)
    .await?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafeRevocation {
    Revoked,
    NotFound,
    /// The target is an ADMIN_SUBS owner.
    Owner,
    /// An admin may not revoke themselves here (that is [`revoke_self`]).
    OwnSub,
    ActorNotAdmin,
}

/// Revoke `target` while `actor` is still an administrator. BEGIN IMMEDIATE
/// takes the write lock before the actor is re-read, so two admins revoking
/// each other serialise and the second fails closed. Self-revocation is refused
/// first, so a live distinct actor proves an authority remains afterwards. The
/// target's unrevoked invites are revoked with them.
pub async fn revoke_safely(
    pool: &SqlitePool,
    admin_subs: &[String],
    target: &str,
    actor: &str,
) -> Result<SafeRevocation> {
    if !valid_sub(target) {
        return Ok(SafeRevocation::NotFound);
    }
    let is_owner = |s: &str| admin_subs.iter().any(|a| a == s);
    if is_owner(target) {
        return Ok(SafeRevocation::Owner);
    }
    if target == actor {
        return Ok(SafeRevocation::OwnSub);
    }

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let target_active: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM members WHERE sub = ? AND revoked_at IS NULL")
            .bind(target)
            .fetch_optional(&mut *tx)
            .await?;
    if target_active.is_none() {
        return Ok(SafeRevocation::NotFound);
    }
    if !is_owner(actor) {
        if !valid_sub(actor) {
            return Ok(SafeRevocation::ActorNotAdmin);
        }
        let role: Option<Role> =
            sqlx::query_scalar("SELECT role FROM members WHERE sub = ? AND revoked_at IS NULL")
                .bind(actor)
                .fetch_optional(&mut *tx)
                .await?;
        if role != Some(Role::Admin) {
            return Ok(SafeRevocation::ActorNotAdmin);
        }
    }

    let now = now_iso();
    let changed =
        sqlx::query("UPDATE members SET revoked_at = ? WHERE sub = ? AND revoked_at IS NULL")
            .bind(&now)
            .bind(target)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if changed != 1 {
        return Ok(SafeRevocation::NotFound);
    }
    revoke_invites_of(&mut tx, target, &now).await?;
    tx.commit().await?;
    Ok(SafeRevocation::Revoked)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfRevocation {
    Revoked,
    AlreadyRevoked,
    LastAdmin,
}

/// Revoke the caller's own membership and every invite they issued (account
/// deletion). An ADMIN_SUBS owner is always refused (the env would re-admit
/// them on the next sign-in), and so is the last administrator: another
/// active admin row, or an ADMIN_SUBS entry that has not signed in yet, must
/// remain. A sub with no active row is `AlreadyRevoked` (an idempotent replay).
pub async fn revoke_self(
    pool: &SqlitePool,
    admin_subs: &[String],
    sub: &str,
) -> Result<SelfRevocation> {
    if !valid_sub(sub) {
        return Ok(SelfRevocation::AlreadyRevoked);
    }
    let is_owner = |s: &str| admin_subs.iter().any(|a| a == s);
    if is_owner(sub) {
        return Ok(SelfRevocation::LastAdmin);
    }

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let role: Option<Role> =
        sqlx::query_scalar("SELECT role FROM members WHERE sub = ? AND revoked_at IS NULL")
            .bind(sub)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(role) = role else {
        return Ok(SelfRevocation::AlreadyRevoked);
    };
    if role == Role::Admin {
        let others: Vec<(String, Role)> =
            sqlx::query_as("SELECT sub, role FROM members WHERE revoked_at IS NULL AND sub != ?")
                .bind(sub)
                .fetch_all(&mut *tx)
                .await?;
        let row_admins = others
            .iter()
            .filter(|(s, r)| *r == Role::Admin || is_owner(s))
            .count();
        // ADMIN_SUBS entries are admins before their first sign-in writes a row.
        let env_only = admin_subs
            .iter()
            .filter(|a| !others.iter().any(|(s, _)| s == *a))
            .count();
        if row_admins + env_only == 0 {
            return Ok(SelfRevocation::LastAdmin);
        }
    }

    let now = now_iso();
    sqlx::query("UPDATE members SET revoked_at = ? WHERE sub = ? AND revoked_at IS NULL")
        .bind(&now)
        .bind(sub)
        .execute(&mut *tx)
        .await?;
    revoke_invites_of(&mut tx, sub, &now).await?;
    tx.commit().await?;
    Ok(SelfRevocation::Revoked)
}

/// A revoked member's invites die with them.
async fn revoke_invites_of(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    sub: &str,
    now: &str,
) -> Result<()> {
    sqlx::query("UPDATE invites SET revoked_at = ? WHERE issued_by = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(sub)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
