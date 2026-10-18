//! Internal-principal JWEs for calls to the internal services (recommender,
//! media-core, transcoder, iptv): who is acting, minted here, verified there.
//! 60 s TTL, minted exactly as auth's admin revoke does
//! (`emerald_contracts::internal_principal`).

use emerald_contracts::internal_principal::{self, DEFAULT_TTL_SECS, InternalClaims};

use crate::upstream::Error;

/// The acting identity.
pub struct Caller<'a> {
    pub sub: &'a str,
    pub role: &'a str,
    pub auth_mode: &'a str,
    /// Set when the call came in over a device-token Bearer.
    pub device_id: Option<&'a str>,
}

impl<'a> From<&'a auth::Principal> for Caller<'a> {
    fn from(p: &'a auth::Principal) -> Self {
        Caller {
            sub: &p.session.sub,
            role: p.session.role.as_str(),
            auth_mode: p.session.auth_mode.as_str(),
            device_id: p.device.as_ref().map(|d| d.device_id.as_str()),
        }
    }
}

/// `req_id` is the inbound X-Request-Id; background work passes None and
/// gets a fresh ULID.
pub fn mint(
    secret: Option<&str>,
    caller: &Caller,
    server_id: &str,
    req_id: Option<&str>,
) -> Result<String, Error> {
    let secret = secret.ok_or(Error::NoPrincipalSecret)?;
    let now = chrono::Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: caller.sub.into(),
        role: caller.role.into(),
        auth_mode: caller.auth_mode.into(),
        server_id: server_id.into(),
        device_id: caller.device_id.map(String::from),
        req_id: req_id
            .filter(|r| !r.is_empty())
            .map_or_else(|| ulid::Ulid::generate().to_string(), String::from),
        iat: now,
        exp: now + DEFAULT_TTL_SECS,
    };
    Ok(internal_principal::encrypt_with_secret(
        secret.as_bytes(),
        &claims,
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use emerald_contracts::internal_principal::{DEFAULT_KID, decrypt};

    use super::*;

    const SECRET: &str = "principal-test-secret-0123456789abcdef";

    fn open(token: &str) -> InternalClaims {
        let key = emerald_contracts::hkdf::derive_key(
            SECRET.as_bytes(),
            emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL,
        );
        let keys = HashMap::from([(DEFAULT_KID.to_string(), key)]);
        decrypt(&keys, token).unwrap()
    }

    const MOM: Caller = Caller {
        sub: "apple:000001.0123456789abcdef0123456789abcdef.0001",
        role: "user",
        auth_mode: "apple",
        device_id: None,
    };

    #[test]
    fn mints_a_compact_jwe_the_services_can_open() {
        let token = mint(Some(SECRET), &MOM, "srv-1", None).unwrap();
        assert_eq!(token.split('.').count(), 5);
        let c = open(&token);
        assert_eq!(
            (
                c.iss.as_str(),
                c.sub.as_str(),
                c.role.as_str(),
                c.auth_mode.as_str()
            ),
            ("eex", MOM.sub, "user", "apple")
        );
        assert_eq!(c.server_id, "srv-1");
        assert_eq!(c.device_id, None);
        assert_eq!(c.exp - c.iat, 60);
        assert_eq!(c.req_id.len(), 26, "a fresh ULID");
    }

    #[test]
    fn successive_tokens_differ() {
        let a = mint(Some(SECRET), &MOM, "srv-1", None).unwrap();
        let b = mint(Some(SECRET), &MOM, "srv-1", None).unwrap();
        assert_ne!(a, b);
        assert_ne!(open(&a).req_id, open(&b).req_id);
    }

    #[test]
    fn carries_the_device_and_the_request_id() {
        let tv = Caller {
            device_id: Some("01HABCDEFGHJKMNPQRSTVWXYZ0"),
            ..MOM
        };
        let c = open(&mint(Some(SECRET), &tv, "srv-1", Some("req-42")).unwrap());
        assert_eq!(c.device_id.as_deref(), Some("01HABCDEFGHJKMNPQRSTVWXYZ0"));
        assert_eq!(c.req_id, "req-42");
    }

    #[test]
    fn refuses_without_the_secret() {
        assert!(matches!(
            mint(None, &MOM, "srv-1", None),
            Err(Error::NoPrincipalSecret)
        ));
    }
}
