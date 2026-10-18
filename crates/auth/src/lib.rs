//! auth: the identity half of `server.db` (members, invites, device tokens,
//! server_id). A library linked in-process by the gateway, not a service:
//! every protected route needs its answer, so a network hop per request would
//! buy nothing.

pub mod config;
pub mod db;
pub mod device_tokens;
pub mod invites;
pub mod members;

#[cfg(test)]
mod testutil;

pub use db::ensure_server_id;
pub use members::{effective_role, member_status};

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    /// A sub that fails the contract grammar where the caller must supply a
    /// valid one (an invite issuer, a device-token subject).
    #[error("sub_invalid_format")]
    InvalidSub,
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "admin" => Some(Role::Admin),
            "user" => Some(Role::User),
            _ => None,
        }
    }
}

/// The provider an identity signed in with. Plex is gone (decisions.md), so a
/// stored `plex` row reads as a plain string on [`members::Member`] and a
/// `plex` device token no longer verifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Local,
    Apple,
    Google,
    Workos,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Local => "local",
            AuthMode::Apple => "apple",
            AuthMode::Google => "google",
            AuthMode::Workos => "workos",
        }
    }

    pub fn parse(s: &str) -> Option<AuthMode> {
        match s {
            "local" => Some(AuthMode::Local),
            "apple" => Some(AuthMode::Apple),
            "google" => Some(AuthMode::Google),
            "workos" => Some(AuthMode::Workos),
            _ => None,
        }
    }
}

pub(crate) fn valid_sub(sub: &str) -> bool {
    emerald_contracts::parse_sub(sub).is_ok()
}

/// JS `Date#toISOString()`: millisecond precision, `Z`. Stored timestamps are
/// compared as strings, so the format must match the rows Node wrote.
pub(crate) fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn now_iso() -> String {
    iso(chrono::Utc::now())
}
