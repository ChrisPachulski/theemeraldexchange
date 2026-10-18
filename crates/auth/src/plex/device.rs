//! The Apple TV / device Plex flow, the port of `routes/device.ts`:
//! POST /api/auth/device/poll. The device creates the PIN on plex.tv itself
//! (under GET /api/auth/plex/config's client id, so plex.tv sees the device's
//! IP, never the host's), shows the code, and polls here. Once the user has
//! authorized it, the same authZ gate as the web sign-in decides, and an
//! admitted member gets a device token bound to the device's id and name.
//! There is no Plex-share admission here, as in TS: a device needs a member
//! row or an invite.

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use super::PlexError;
use super::signin::pin_id;
use crate::device_tokens::{self, MintInput};
use crate::members;
use crate::outcome::{Outcome, Phase, Provider, Reason, Reporter};
use crate::signin::{authorize_or_redeem, denied, error, internal, not_configured, text};
use crate::{AuthMode, AuthState, Error, Result, Role, js_trim, json_body};

/// A pinId, the device fields and an invite code fit in 2 KB.
const MAX_BODY_BYTES: usize = 2048;

pub(super) async fn poll(State(st): State<AuthState>, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Plex, Phase::Check);
    outcome
        .run(poll_inner(&st, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn poll_inner(
    st: &AuthState,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    let bad = |msg: &str| {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        error(StatusCode::BAD_REQUEST, json!({ "error": msg }))
    };
    let body = match json_body(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(too_large) => {
            outcome.record(Outcome::Invalid, Reason::InvalidRequest);
            return Ok(too_large);
        }
    };
    let (named, pin) = pin_id(&body);
    if !named {
        return Ok(bad("missing_pinId"));
    }
    let Some(pin) = pin else {
        return Ok(bad("bad_pinId"));
    };
    // The check buckets and this PIN's bucket, before any plex.tv call, so a
    // poll flood burns neither the Plex API budget nor the authZ path.
    if let Err(r) = st.limiter.check_plex_pin(headers, Some(pin), outcome) {
        return Ok(r);
    }

    let field = |k: &str| text(&body, k).map(js_trim).unwrap_or_default();
    let (device_id, device_name, device_platform) = (
        field("device_id"),
        field("device_name"),
        field("device_platform"),
    );
    if device_id.is_empty() {
        return Ok(bad("missing_device_id"));
    }
    if device_name.is_empty() {
        return Ok(bad("missing_device_name"));
    }
    if device_platform.is_empty() {
        return Ok(bad("missing_device_platform"));
    }
    let invite = text(&body, "invite_code").or_else(|| text(&body, "inviteCode"));

    let pin = match st.plex.check_pin(&st.config, pin).await {
        Ok(pin) => pin,
        Err(PlexError::RateLimited {
            retry_after,
            retry_after_seconds,
        }) => {
            outcome.record_provider_rate_limited(retry_after_seconds);
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, retry_after)],
                Json(json!({ "error": "plex_rate_limited" })),
            )
                .into_response());
        }
        Err(PlexError::NotConfigured) => return Ok(not_configured(outcome, "plex")),
        Err(e) => return Err(e.into()),
    };
    let Some(token) = pin.auth_token.filter(|t| !t.is_empty()) else {
        return Ok(Json(json!({ "status": "pending" })).into_response());
    };

    let user = st.plex.get_user(&st.config, &token).await?;
    let sub = format!("plex:{}", user.id);
    if !authorize_or_redeem(st, &sub, invite, &user.username, AuthMode::Plex).await? {
        return Ok(denied(outcome));
    }
    let role = members::effective_role(&st.pool, &st.config.admin_subs, &sub).await?;

    let keys = st.device_keys.as_deref().ok_or(Error::NoDeviceSecret)?;
    let server_id = crate::ensure_server_id(&st.pool).await?;
    let token = device_tokens::mint(
        &st.pool,
        keys,
        &MintInput {
            sub: &sub,
            role,
            auth_mode: AuthMode::Plex,
            device_id,
            device_platform,
            device_name,
            username: Some(&user.username),
            server_id: &server_id,
        },
    )
    .await?;
    outcome.record(Outcome::Authorized, Reason::DevicePair);
    Ok(Json(Authorized {
        status: "authorized",
        token,
        server_id,
        user: PairedUser {
            sub: &sub,
            username: &user.username,
            role,
        },
    })
    .into_response())
}

/// The success body, in the TS key order. The apps keep the token in the
/// Keychain under the server id, so a server_id reset forces a re-pair.
#[derive(Serialize)]
struct Authorized<'a> {
    status: &'static str,
    token: String,
    server_id: String,
    user: PairedUser<'a>,
}

#[derive(Serialize)]
struct PairedUser<'a> {
    sub: &'a str,
    username: &'a str,
    role: Role,
}

#[cfg(test)]
mod tests;
