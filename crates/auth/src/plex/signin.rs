//! Web Plex sign-in, the port of `auth.ts`'s /plex/config and /plex/check.
//! The browser creates the PIN (so plex.tv sees the visitor's IP, never the
//! host's) and polls it here. A token proves the Plex identity; the members
//! allowlist, an invite, or a share on the owner's Plex server decides access.

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::{Value, json};

use super::{PLEX_PRODUCT, PlexError, Probe};
use crate::members::{self, MemberStatus};
use crate::outcome::{Outcome, Phase, Provider, Reason, Reporter};
use crate::session::{self, Session};
use crate::signin::{authorize_or_redeem, denied, error, internal, not_configured, text};
use crate::{AuthMode, AuthState, Result, Role, json_body, now_iso, valid_sub};

/// A pinId and an invite code fit in 1 KB.
const MAX_BODY_BYTES: usize = 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/auth/plex/config", get(plex_config))
        .route("/api/auth/plex/check", post(plex_check))
}

/// GET /api/auth/plex/config: the public client id and product label the SPA
/// creates its PIN under. The server polls with the same client id.
async fn plex_config(State(st): State<AuthState>) -> Response {
    match st.config.plex_client_id.as_deref() {
        Some(id) => Json(json!({ "clientId": id, "product": PLEX_PRODUCT })).into_response(),
        None => error(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "plex_not_configured" }),
        ),
    }
}

/// POST /api/auth/plex/check. POST so the CSRF gate covers it: a cross-site
/// GET with an attacker-authorized pinId would overwrite the victim's cookie.
async fn plex_check(
    State(st): State<AuthState>,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let outcome = Reporter::new(&headers, Provider::Plex, Phase::Check);
    outcome
        .run(check_inner(&st, &uri, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn check_inner(
    st: &AuthState,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    // The rate limits come first, the PIN's own bucket only for a body that
    // named an integer pinId; then the body's verdicts.
    let body = json_body(body, MAX_BODY_BYTES).await;
    let (named, pin_id) = body.as_ref().map_or((false, None), pin_id);
    if let Err(r) = st.limiter.check_plex_pin(headers, pin_id, outcome) {
        return Ok(r);
    }
    let body = match body {
        Ok(b) => b,
        Err(too_large) => {
            outcome.record(Outcome::Invalid, Reason::InvalidRequest);
            return Ok(too_large);
        }
    };
    let bad = |msg: &str| {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        error(StatusCode::BAD_REQUEST, json!({ "error": msg }))
    };
    if !named {
        return Ok(bad("missing pinId"));
    }
    let Some(pin_id) = pin_id else {
        return Ok(bad("bad pinId"));
    };

    let pin = match st.plex.check_pin(&st.config, pin_id).await {
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
    let invite = text(&body, "inviteCode");
    let mut allowed = authorize_or_redeem(st, &sub, invite, &user.username, AuthMode::Plex).await?;

    // Shared on (or owning) the configured home server admits a brand-new
    // identity and mints its member row, so a Plex share needs no invite.
    // Revoked members are not re-admitted (an explicit revoke wins), and a
    // probe error fails closed: uncertainty must not grant access.
    if !allowed
        && let Some(server_id) = st.config.plex_server_id.as_deref()
        && valid_sub(&sub)
        && members::member_status(&st.pool, &st.config.admin_subs, &sub).await?
            == MemberStatus::NotMember
    {
        match st.plex.probe_resources(&st.config, &token).await {
            Probe::Ok(resources) => {
                if resources
                    .iter()
                    .any(|r| r.provides.contains("server") && r.client_identifier == server_id)
                {
                    // Sharing grants membership, never the admin role.
                    sqlx::query(
                        "INSERT INTO members (sub, display_name, role, auth_mode, invited_by, \
                         joined_at, revoked_at) \
                         VALUES (?, ?, 'user', 'plex', 'plex:server-share', ?, NULL) \
                         ON CONFLICT(sub) DO NOTHING",
                    )
                    .bind(&sub)
                    .bind(&user.username)
                    .bind(now_iso())
                    .execute(&st.pool)
                    .await?;
                    allowed = true;
                }
            }
            Probe::HttpError(_) | Probe::NetworkError => {
                outcome.record(Outcome::Transient, Reason::ProviderUnavailable);
            }
        }
    }
    if !allowed {
        return Ok(denied(outcome));
    }
    let role = members::effective_role(&st.pool, &st.config.admin_subs, &sub).await?;

    // Without PLEX_SERVER_ID, list the user's servers so the operator can find
    // the machine id. Best effort: a probe failure lists none.
    let discovered_servers = match st.config.plex_server_id {
        Some(_) => Vec::new(),
        None => match st.plex.probe_resources(&st.config, &token).await {
            Probe::Ok(resources) => resources
                .into_iter()
                .filter(|r| r.provides.contains("server"))
                .map(|r| Server {
                    name: r.name,
                    id: r.client_identifier,
                    owned: r.owned,
                })
                .collect(),
            _ => Vec::new(),
        },
    };

    let cookie = session::mint(
        &st.session_key,
        &Session {
            sub: sub.clone(),
            username: user.username.clone(),
            role,
            auth_mode: AuthMode::Plex,
            plex_auth_token: Some(token),
        },
        st.now(),
    );
    outcome.record(Outcome::Authorized, Reason::Cookie);
    let https = uri.scheme_str() == Some("https");
    Ok((
        [(
            header::SET_COOKIE,
            session::set_cookie(&st.config, &cookie, https),
        )],
        Json(Authorized {
            status: "authorized",
            user: SignedIn {
                sub: &sub,
                username: &user.username,
                email: user.email.as_deref(),
                thumb: user.thumb.as_deref(),
                role,
            },
            discovered_servers,
        }),
    )
        .into_response())
}

/// The success body, in the TS key order.
#[derive(Serialize)]
struct Authorized<'a> {
    status: &'static str,
    user: SignedIn<'a>,
    #[serde(rename = "discoveredServers", skip_serializing_if = "Vec::is_empty")]
    discovered_servers: Vec<Server>,
}

#[derive(Serialize)]
struct SignedIn<'a> {
    sub: &'a str,
    username: &'a str,
    email: Option<&'a str>,
    thumb: Option<&'a str>,
    role: Role,
}

#[derive(Serialize)]
struct Server {
    name: String,
    id: String,
    owned: bool,
}

/// Whether the body named a pinId (a non-empty string or a number), and its
/// value when that is an integer, read the way JS `Number()` reads it.
fn pin_id(body: &Value) -> (bool, Option<i64>) {
    let n = match body.get("pinId") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.is_empty() => js_number(s),
        _ => return (false, None),
    };
    // ponytail: integers past i64 are refused as bad pinId (JS would poll
    // plex.tv for /pins/1e+300 and 500 on its 404).
    let int = n.filter(|f| f.fract() == 0.0 && f.abs() < 9.2e18);
    (true, int.map(|f| f as i64))
}

/// JS `Number(s)` for a string: trimmed, empty is 0, 0x/0o/0b radix
/// prefixes, else a decimal float. Rust's float grammar also takes "inf" and
/// "nan", which are never integers, so the verdict is the same.
fn js_number(s: &str) -> Option<f64> {
    let s = crate::js_trim(s);
    if s.is_empty() {
        return Some(0.0);
    }
    let radix = |p: &str, r: u32| {
        let digits = s.strip_prefix(p).or(s.strip_prefix(&p.to_uppercase()))?;
        // from_str_radix takes a leading '+', JS does not.
        let digits = digits.strip_prefix('+').map_or(Some(digits), |_| None)?;
        u64::from_str_radix(digits, r).ok().map(|n| n as f64)
    };
    if s.len() > 2 && s.as_bytes()[0] == b'0' && s.as_bytes()[1].is_ascii_alphabetic() {
        return radix("0x", 16)
            .or_else(|| radix("0o", 8))
            .or_else(|| radix("0b", 2));
    }
    s.parse().ok()
}

#[cfg(test)]
mod tests;
