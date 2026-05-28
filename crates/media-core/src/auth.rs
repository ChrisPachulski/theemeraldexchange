//! Internal-principal verification (§4 Hybrid D). Hono mints a 60s JWE and
//! sends it as `Authorization: Bearer <jwe>`; media-core verifies with the
//! HKDF-derived key from `INTERNAL_PRINCIPAL_SECRET`. Posture mirrors the
//! recommender: off (skip) → log (warn, allow) → enforce (reject).

use std::collections::HashMap;

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;
use emerald_contracts::derive_key;
use emerald_contracts::internal_principal::{self, DEFAULT_KID, InternalClaims};
use emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL;

use crate::AppState;
use crate::config::PrincipalMode;
use crate::error::AppError;

/// Verify a Bearer internal-principal token against the shared secret.
pub fn verify_principal(
    secret: &str,
    token: &str,
    now: i64,
) -> Result<InternalClaims, String> {
    let key = derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
    let mut keys = HashMap::new();
    keys.insert(DEFAULT_KID.to_string(), key);
    let claims = internal_principal::decrypt(&keys, token).map_err(|e| format!("{e:?}"))?;
    internal_principal::enforce_time_window(&claims, now).map_err(|e| format!("{e:?}"))?;
    Ok(claims)
}

/// axum middleware gating `/api/media/*`. On success the verified
/// [`InternalClaims`] are inserted into request extensions so handlers can
/// read the acting `sub` for per-user watch state.
pub async fn principal_layer(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let mode = state.config.principal_mode.clone();
    if mode == PrincipalMode::Off {
        return Ok(next.run(req).await);
    }

    let token = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let secret = state.config.internal_principal_secret.clone();

    match (token, secret) {
        (Some(tok), Some(sec)) => {
            let now = chrono::Utc::now().timestamp();
            match verify_principal(&sec, &tok, now) {
                Ok(claims) => {
                    req.extensions_mut().insert(claims);
                    Ok(next.run(req).await)
                }
                Err(e) => {
                    if mode == PrincipalMode::Enforce {
                        Err(AppError::Unauthorized(format!(
                            "internal-principal verify failed: {e}"
                        )))
                    } else {
                        tracing::warn!("internal-principal verify failed (log mode): {e}");
                        Ok(next.run(req).await)
                    }
                }
            }
        }
        _ => {
            if mode == PrincipalMode::Enforce {
                Err(AppError::Unauthorized("internal-principal required".into()))
            } else {
                tracing::warn!("internal-principal missing or secret unset (log mode)");
                Ok(next.run(req).await)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use emerald_contracts::internal_principal::{DEFAULT_TTL_SECS, InternalClaims, encrypt};

    fn claims(now: i64) -> InternalClaims {
        InternalClaims {
            iss: "eex".into(),
            sub: "plex:42".into(),
            role: "user".into(),
            auth_mode: "plex".into(),
            server_id: "srv".into(),
            device_id: None,
            req_id: "r1".into(),
            iat: now,
            exp: now + DEFAULT_TTL_SECS,
        }
    }

    #[test]
    fn verify_roundtrip_and_expiry() {
        let secret = "super-secret-internal-principal-key";
        let key = derive_key(secret.as_bytes(), INFO_INTERNAL_PRINCIPAL);
        let now = 1_748_000_000;
        let token = encrypt(&key, DEFAULT_KID, &claims(now));

        let ok = verify_principal(secret, &token, now).unwrap();
        assert_eq!(ok.sub, "plex:42");

        // Past the 60s window → rejected.
        assert!(verify_principal(secret, &token, now + DEFAULT_TTL_SECS + 1).is_err());
        // Wrong secret → rejected.
        assert!(verify_principal("other-secret", &token, now).is_err());
    }
}
