//! Sign in with Apple and Google, the port of `auth.ts`'s /methods, /apple,
//! /apple/nonce and /google with `devicePair.ts`. The identity comes only
//! from a verified token ([`crate::jwks`]); the members allowlist (or an
//! invite redeemed here) decides access. A body with the device-pair triple
//! gets a device token, any other body a session cookie.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::device_tokens::{self, MintInput};
use crate::invites::{self, Redeem};
use crate::jwks::{Identity, VerifyError};
use crate::members::{self, MemberStatus};
use crate::outcome::{Outcome, Phase, Provider, Reason, Reporter};
use crate::ratelimit::{Kind, unverified_jwt_sub};
use crate::reconcile::Rejection;
use crate::session::{self, Session};
use crate::{AuthMode, AuthState, Error, Result, Role};

/// An identity token is a full RS256 JWT; 8 KB also covers nonce + invite.
const MAX_BODY_BYTES: usize = 8192;
const NONCE_TTL: Duration = Duration::from_secs(300);
const NONCE_CAP: usize = 10_000;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/auth/methods", get(methods))
        .route("/api/auth/apple/nonce", get(apple_nonce))
        .route("/api/auth/apple", post(apple))
        .route("/api/auth/google", post(google))
}

/// Server-issued Sign in with Apple nonces for the native device-pair flow.
/// The app hands Apple the SHA-256 hex of one and sends the raw value back
/// beside the identity token; a nonce burns on first use, so a captured token
/// cannot mint a second device token. In memory: a restart costs an in-flight
/// login one retry. The native WorkOS states ride the same store with their
/// own TTL.
pub(crate) struct Nonces {
    map: Mutex<HashMap<String, Instant>>,
    ttl: Duration,
}

impl Default for Nonces {
    fn default() -> Nonces {
        Nonces::new(NONCE_TTL)
    }
}

impl Nonces {
    pub(crate) fn new(ttl: Duration) -> Nonces {
        Nonces {
            map: Mutex::default(),
            ttl,
        }
    }

    pub(crate) fn issue(&self) -> String {
        self.issue_at(Instant::now())
    }

    pub(crate) fn issue_at(&self, now: Instant) -> String {
        let mut map = self.map.lock().unwrap();
        map.retain(|_, expires| *expires > now);
        // ponytail: O(n) oldest-first eviction under a flood; the apple rate
        // limit keeps it unreachable in practice (workos/native/start has
        // none, so there the cap is what bounds memory).
        while map.len() >= NONCE_CAP {
            let Some(oldest) = map.iter().min_by_key(|(_, e)| **e).map(|(k, _)| k.clone()) else {
                break;
            };
            map.remove(&oldest);
        }
        let nonce = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
        map.insert(nonce.clone(), now + self.ttl);
        nonce
    }

    /// Burn `nonce`. False when unknown, already used or expired.
    pub(crate) fn consume_at(&self, nonce: &str, now: Instant) -> bool {
        self.map
            .lock()
            .unwrap()
            .remove(nonce)
            .is_some_and(|expires| expires > now)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }
}

/// GET /api/auth/methods: which providers this install offers. There is no
/// plex key; the Apple app decodes a missing key as false.
async fn methods(State(st): State<AuthState>) -> Json<Value> {
    Json(json!({
        "apple": st.config.apple_configured(),
        "google": st.config.google_configured(),
        "workos": st.config.workos_configured(),
    }))
}

pub(crate) fn error(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

pub(crate) fn not_configured(outcome: &Reporter, provider: &str) -> Response {
    outcome.record(Outcome::Transient, Reason::NotConfigured);
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": format!("{provider}_not_configured") }),
    )
}

pub(crate) fn internal(e: Error) -> Response {
    tracing::error!(event = "auth_signin", error = %e, "sign-in store error");
    Rejection::Internal.into_response()
}

/// GET /api/auth/apple/nonce. Shares the apple bucket, so a login costs two
/// hits; 503 when Apple is not configured, so no ceremony starts that the
/// server cannot finish.
async fn apple_nonce(State(st): State<AuthState>, headers: HeaderMap) -> Response {
    let outcome = Reporter::new(&headers, Provider::Apple, Phase::Check);
    if let Err(r) = st.limiter.check(&headers, Kind::Apple, &outcome) {
        return r;
    }
    if !st.config.apple_configured() {
        return not_configured(&outcome, "apple");
    }
    Json(json!({
        "nonce": st.apple_nonces.issue(),
        "expires_in": NONCE_TTL.as_secs(),
    }))
    .into_response()
}

/// POST /api/auth/apple.
async fn apple(State(st): State<AuthState>, uri: Uri, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Apple, Phase::IdentityVerify);
    outcome
        .run(apple_inner(&st, &uri, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn apple_inner(
    st: &AuthState,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Apple, outcome) {
        return Ok(r);
    }
    let Some(audience) = st.config.apple_client_id.as_slice().first() else {
        return Ok(not_configured(outcome, "apple"));
    };
    let body = match read_body(body, outcome).await {
        Ok(b) => b,
        Err(r) => return Ok(r),
    };
    let Some(token) = text(&body, "identityToken").filter(|t| !t.is_empty()) else {
        return Ok(missing_token(outcome));
    };
    if let Err(r) =
        st.limiter
            .check_identity(Kind::Apple, unverified_jwt_sub(token).as_deref(), outcome)
    {
        return Ok(r);
    }

    // A nonce is always required: without one any valid identity token,
    // replayed or minted for another flow, signed in. A device pair must
    // present a server-issued nonce (burned here, whatever the verifier says
    // next) and Apple echoed its SHA-256 hex; a browser's client-chosen
    // nonce is compared as sent.
    let Some(nonce) = text(&body, "nonce").filter(|n| !n.is_empty()) else {
        return Ok(invalid_nonce(outcome));
    };
    let device_pair = text(&body, "device_id").is_some_and(|d| !d.trim().is_empty());
    let expected = if device_pair {
        if !st.apple_nonces.consume_at(nonce, Instant::now()) {
            return Ok(invalid_nonce(outcome));
        }
        format!("{:x}", Sha256::digest(nonce.as_bytes()))
    } else {
        nonce.to_string()
    };

    let identity = match st
        .apple_jwks
        .verify(
            token,
            std::slice::from_ref(audience),
            Some(&expected),
            st.now(),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return Ok(rejected(outcome, e)),
    };
    // Apple names are absent or unstable: the email local-part, else the sub.
    let display_name = match identity.email.as_deref().filter(|e| !e.is_empty()) {
        Some(email) => email.split('@').next().unwrap_or_default().to_string(),
        None => identity.sub.clone(),
    };
    admit(
        st,
        uri,
        outcome,
        &body,
        identity,
        display_name,
        AuthMode::Apple,
    )
    .await
}

/// POST /api/auth/google. The token is `identityToken` or `idToken`; the nonce
/// is optional and compared as sent.
async fn google(State(st): State<AuthState>, uri: Uri, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Google, Phase::IdentityVerify);
    outcome
        .run(google_inner(&st, &uri, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn google_inner(
    st: &AuthState,
    uri: &Uri,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Google, outcome) {
        return Ok(r);
    }
    if !st.config.google_configured() {
        return Ok(not_configured(outcome, "google"));
    }
    let body = match read_body(body, outcome).await {
        Ok(b) => b,
        Err(r) => return Ok(r),
    };
    let Some(token) = text(&body, "identityToken")
        .or_else(|| text(&body, "idToken"))
        .filter(|t| !t.is_empty())
    else {
        return Ok(missing_token(outcome));
    };
    if let Err(r) =
        st.limiter
            .check_identity(Kind::Google, unverified_jwt_sub(token).as_deref(), outcome)
    {
        return Ok(r);
    }
    let identity = match st
        .google_jwks
        .verify(
            token,
            &st.config.google_client_ids,
            text(&body, "nonce"),
            st.now(),
        )
        .await
    {
        Ok(id) => id,
        Err(e) => return Ok(rejected(outcome, e)),
    };
    let display_name = display_name(&identity);
    admit(
        st,
        uri,
        outcome,
        &body,
        identity,
        display_name,
        AuthMode::Google,
    )
    .await
}

/// The provider's name, then the email local-part, then the sub (Google and
/// WorkOS). The sub is the stable key; the name is advisory chrome.
pub(crate) fn display_name(identity: &Identity) -> String {
    match (&identity.name, identity.email.as_deref()) {
        (Some(name), _) => name.clone(),
        (None, Some(email)) if !email.is_empty() => {
            email.split('@').next().unwrap_or_default().to_string()
        }
        _ => identity.sub.clone(),
    }
}

pub(crate) fn text<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// The JSON body under the 8 KB cap. Unparseable JSON reads as null (the
/// field checks then answer 400); an oversized or broken stream is a 413.
pub(crate) async fn read_body(
    body: Body,
    outcome: &Reporter,
) -> std::result::Result<Value, Response> {
    json_body(body, MAX_BODY_BYTES).await.inspect_err(|_| {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
    })
}

/// [`read_body`] under `limit` bytes, without an outcome.
pub async fn json_body(body: Body, limit: usize) -> std::result::Result<Value, Response> {
    match axum::body::to_bytes(body, limit).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null)),
        Err(_) => Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({ "error": "body_too_large" }),
        )),
    }
}

fn missing_token(outcome: &Reporter) -> Response {
    outcome.record(Outcome::Invalid, Reason::InvalidRequest);
    error(
        StatusCode::BAD_REQUEST,
        json!({ "error": "missing identity_token" }),
    )
}

fn invalid_nonce(outcome: &Reporter) -> Response {
    outcome.record(Outcome::Invalid, Reason::InvalidRequest);
    error(StatusCode::BAD_REQUEST, json!({ "error": "invalid_nonce" }))
}

fn rejected(outcome: &Reporter, e: VerifyError) -> Response {
    if e == VerifyError::JwksUnavailable {
        outcome.record(Outcome::Transient, Reason::ProviderUnavailable);
    } else {
        outcome.record(Outcome::Invalid, Reason::IdentityTokenInvalid);
    }
    error(
        e.status(),
        json!({ "error": "invalid_identity_token", "reason": e.as_str() }),
    )
}

/// The shared tail of every provider route: authZ, then a device token for a
/// device-pair body or a session cookie for a browser.
async fn admit(
    st: &AuthState,
    uri: &Uri,
    outcome: &Reporter,
    body: &Value,
    identity: Identity,
    display_name: String,
    mode: AuthMode,
) -> Result<Response> {
    let sub = identity.sub;
    if !authorize_or_redeem(st, &sub, text(body, "inviteCode"), &display_name, mode).await? {
        outcome.record(Outcome::Denied, Reason::NoInvite);
        return Ok(error(
            StatusCode::FORBIDDEN,
            json!({ "status": "denied", "reason": "no_invite" }),
        ));
    }
    let role = members::effective_role(&st.pool, &st.config.admin_subs, &sub).await?;

    let device = DeviceIdentity {
        sub: &sub,
        role,
        auth_mode: mode,
        username: &display_name,
    };
    if let Some(response) = maybe_mint_device_token(st, body, &device).await? {
        if response.status().is_success() {
            outcome.record(Outcome::Authorized, Reason::DevicePair);
        } else {
            outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        }
        return Ok(response);
    }

    let cookie = session::mint(
        &st.session_key,
        &Session {
            sub: sub.clone(),
            username: display_name.clone(),
            role,
            auth_mode: mode,
        },
        st.now(),
    );
    outcome.record(Outcome::Authorized, Reason::Cookie);
    let mut user = json!({ "sub": sub, "username": display_name, "role": role });
    if let Some(email) = identity.email {
        user["email"] = email.into();
    }
    let https = uri.scheme_str() == Some("https");
    Ok((
        [(
            header::SET_COOKIE,
            session::set_cookie(&st.config, &cookie, https),
        )],
        Json(json!({ "status": "authorized", "user": user })),
    )
        .into_response())
}

/// The shared authZ gate for every provider, after identity is proven: an
/// allowed member is admitted; otherwise a valid invite mints (or re-grants)
/// the membership. There is no ownership seal (setupState is not ported).
pub(crate) async fn authorize_or_redeem(
    st: &AuthState,
    sub: &str,
    invite_code: Option<&str>,
    display_name: &str,
    mode: AuthMode,
) -> Result<bool> {
    if members::member_status(&st.pool, &st.config.admin_subs, sub).await? == MemberStatus::Allowed
    {
        return Ok(true);
    }
    let Some(code) = invite_code.filter(|c| !c.is_empty()) else {
        return Ok(false);
    };
    Ok(matches!(
        invites::redeem(&st.pool, code, sub, Some(display_name), mode).await?,
        Redeem::Created | Redeem::AlreadyMember
    ))
}

pub(crate) struct DeviceIdentity<'a> {
    pub sub: &'a str,
    pub role: Role,
    /// Derived from the proven identity, never client-supplied.
    pub auth_mode: AuthMode,
    pub username: &'a str,
}

/// With all three of device_id, device_name and device_platform (trimmed,
/// non-empty) in `body`, mint a device token and answer with the device wire
/// shape. None of them: None, so the caller sets a cookie. Some but not all:
/// 400 `incomplete_device_fields`, never a silent cookie. Call it only after
/// authN and authZ; it picks the credential format, not the decision.
pub(crate) async fn maybe_mint_device_token(
    st: &AuthState,
    body: &Value,
    id: &DeviceIdentity<'_>,
) -> Result<Option<Response>> {
    let field = |k: &str| text(body, k).map(str::trim).unwrap_or_default();
    let (device_id, device_name, device_platform) = (
        field("device_id"),
        field("device_name"),
        field("device_platform"),
    );
    match [device_id, device_name, device_platform]
        .iter()
        .filter(|f| !f.is_empty())
        .count()
    {
        0 => return Ok(None),
        3 => {}
        _ => {
            return Ok(Some(error(
                StatusCode::BAD_REQUEST,
                json!({ "error": "incomplete_device_fields" }),
            )));
        }
    }
    let keys = st.device_keys.as_deref().ok_or(Error::NoDeviceSecret)?;
    let server_id = crate::ensure_server_id(&st.pool).await?;
    let token = device_tokens::mint(
        &st.pool,
        keys,
        &MintInput {
            sub: id.sub,
            role: id.role,
            auth_mode: id.auth_mode,
            device_id,
            device_platform,
            device_name,
            username: Some(id.username),
            server_id: &server_id,
        },
    )
    .await?;
    Ok(Some(
        Json(json!({
            "status": "authorized",
            "token": token,
            "server_id": server_id,
            "user": { "sub": id.sub, "username": id.username, "role": id.role },
        }))
        .into_response(),
    ))
}

#[cfg(test)]
mod tests;
