//! WorkOS AuthKit sign-in, the port of `workosAuth.ts` and auth.ts's
//! /workos/{start,callback,native/start,native}. AuthKit hosts the login page;
//! we only see an authorization code and trade it server-to-server for the
//! WorkOS user. That proves identity only: the `workos:` sub still has to
//! clear the members allowlist (or redeem an invite).
//!
//! Browser: GET /start parks a state nonce (plus an optional invite) in a
//! 10-minute HttpOnly cookie scoped to the callback path and redirects to
//! AuthKit; GET /callback burns the cookie, compares the state in constant
//! time, exchanges the code and redirects back to the SPA with a session
//! cookie, or with `?auth_error=<reason>`.
//!
//! Native (Apple app, PKCE): POST /native/start hands back the authorize URL
//! and a single-use state; POST /native exchanges code + verifier and mints a
//! device token. No cookie is involved.
//!
//! The API key lives only in config and the request body; the WorkOS base URL
//! is a constant (tests point [`Workos::at`] at a local fake), never
//! request-derived; the exchange gives up after 15 s.

use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use crate::config::Config;
use crate::jwks::Identity;
use crate::members;
use crate::outcome::{Outcome, Phase, Provider, Reason, Reporter};
use crate::ratelimit::Kind;
use crate::session::{self, Session};
use crate::signin::{
    DeviceIdentity, Nonces, admit_or_reason, authorize_or_redeem, display_name, error, internal,
    json_body, maybe_mint_device_token, not_configured, read_body, text,
};
use crate::{AuthMode, AuthState, Result};

pub const WORKOS_API: &str = "https://api.workos.com";
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);
const STATE_COOKIE: &str = "eex_workos_state";
const STATE_TTL_SECS: u64 = 600;
const CALLBACK_PATH: &str = "/api/auth/workos/callback";
const NATIVE_STATE_TTL: Duration = Duration::from_secs(600);
/// /native/start carries only a challenge and a provider.
const NATIVE_START_MAX_BODY_BYTES: usize = 1024;

pub(crate) fn routes() -> Router<AuthState> {
    Router::new()
        .route("/api/auth/workos/start", get(start))
        .route("/api/auth/workos/callback", get(callback))
        .route("/api/auth/workos/native/start", post(native_start))
        .route("/api/auth/workos/native", post(native))
}

/// Why a code exchange failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeError {
    /// Network failure, timeout or a 5xx: ours to report, not the user's.
    ProviderUnavailable,
    /// Any other non-2xx, or a body that is not JSON.
    CodeInvalid,
    /// No string user id, or one that fails the `workos:` sub grammar.
    BadSubject,
}

/// The WorkOS endpoints plus the in-flight native states. One per process.
pub struct Workos {
    base: String,
    http: reqwest::Client,
    pub(crate) timeout: Duration,
    pub(crate) native_states: Nonces,
}

impl Workos {
    pub fn new() -> Workos {
        Workos::at(WORKOS_API)
    }

    /// WorkOS at another base URL (tests serve a fake locally).
    pub fn at(base: &str) -> Workos {
        Workos {
            base: base.trim_end_matches('/').to_string(),
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client builds"),
            timeout: EXCHANGE_TIMEOUT,
            native_states: Nonces::new(NATIVE_STATE_TTL),
        }
    }

    /// The AuthKit authorize URL. `provider` google|apple deep-links past the
    /// hosted chooser; `native` is (redirect_uri, PKCE S256 challenge).
    pub fn authorize_url(
        &self,
        config: &Config,
        state: &str,
        provider: Option<&str>,
        native: Option<(&str, &str)>,
    ) -> String {
        let mut url = reqwest::Url::parse(&format!("{}/user_management/authorize", self.base))
            .expect("WorkOS base URL parses");
        {
            let mut q = url.query_pairs_mut();
            q.append_pair(
                "client_id",
                config.workos_client_id.as_deref().unwrap_or_default(),
            );
            q.append_pair(
                "redirect_uri",
                native
                    .map(|(redirect, _)| redirect)
                    .or(config.workos_redirect_uri.as_deref())
                    .unwrap_or_default(),
            );
            q.append_pair("response_type", "code");
            let provider = match provider {
                Some("google") => "GoogleOAuth",
                Some("apple") => "AppleOAuth",
                _ => "authkit",
            };
            q.append_pair("provider", provider);
            q.append_pair("state", state);
            if let Some((_, challenge)) = native {
                q.append_pair("code_challenge", challenge);
                q.append_pair("code_challenge_method", "S256");
            }
        }
        url.into()
    }

    /// Trade an authorization code (plus the PKCE verifier on the native leg)
    /// for the WorkOS user.
    pub async fn exchange(
        &self,
        config: &Config,
        code: &str,
        verifier: Option<&str>,
    ) -> std::result::Result<Identity, ExchangeError> {
        use ExchangeError::*;
        let mut body = json!({
            "client_id": config.workos_client_id,
            "client_secret": config.workos_api_key,
            "grant_type": "authorization_code",
            "code": code,
        });
        if let Some(v) = verifier {
            body["code_verifier"] = v.into();
        }
        let res = self
            .http
            .post(format!("{}/user_management/authenticate", self.base))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|_| ProviderUnavailable)?;
        if res.status().is_server_error() {
            return Err(ProviderUnavailable);
        }
        if !res.status().is_success() {
            return Err(CodeInvalid);
        }
        let bytes = res.bytes().await.map_err(|_| CodeInvalid)?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| CodeInvalid)?;
        let user = &body["user"];
        let id = user["id"].as_str().ok_or(BadSubject)?;
        let sub = emerald_contracts::parse_sub(&format!("workos:{id}"))
            .map_err(|_| BadSubject)?
            .raw;
        let names: Vec<&str> = ["first_name", "last_name"]
            .iter()
            .filter_map(|k| user[k].as_str())
            .filter(|p| !p.trim().is_empty())
            .collect();
        Ok(Identity {
            sub,
            email: user["email"].as_str().map(String::from),
            name: (!names.is_empty()).then(|| names.join(" ")),
        })
    }
}

impl Default for Workos {
    fn default() -> Workos {
        Workos::new()
    }
}

/// `[A-Za-z0-9_-]` of a length in `len`: the invite, PKCE challenge and
/// verifier shapes.
fn token_shape(s: &str, len: std::ops::RangeInclusive<usize>) -> bool {
    len.contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The callback's state check: a non-empty expected nonce, equal length and
/// equal bytes, compared in constant time.
fn state_matches(expected: &str, got: &str) -> bool {
    !expected.is_empty()
        && expected.len() == got.len()
        && bool::from(expected.as_bytes().ct_eq(got.as_bytes()))
}

/// The first value of `key`, as Hono's `c.req.query(key)` reads it.
fn first<'a>(query: &'a [(String, String)], key: &str) -> Option<&'a str> {
    query
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn workos_not_configured() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": "workos_not_configured" }),
    )
}

fn state_cookie(config: &Config, value: &str) -> HeaderValue {
    let secure = if config.is_prod { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{STATE_COOKIE}={value}; Max-Age={STATE_TTL_SECS}; Path={CALLBACK_PATH}; HttpOnly{secure}; SameSite=Lax"
    ))
    .expect("state cookie is ASCII")
}

fn clear_state_cookie() -> HeaderValue {
    HeaderValue::from_static("eex_workos_state=; Max-Age=0; Path=/api/auth/workos/callback")
}

fn found(location: &str, cookies: &[HeaderValue]) -> Response {
    let mut res = StatusCode::FOUND.into_response();
    let headers = res.headers_mut();
    headers.insert(
        header::LOCATION,
        HeaderValue::from_str(location).expect("redirect URL is ASCII"),
    );
    for c in cookies {
        headers.append(header::SET_COOKIE, c.clone());
    }
    res
}

/// The request's own origin, as node-server builds `c.req.url`: the Host
/// header plus the scheme (http unless the URI carries https).
pub(crate) fn request_origin(uri: &Uri, headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|host| format!("{}://{host}", uri.scheme_str().unwrap_or("http")))
}

/// A redirect to the SPA root: the request's own origin when the backend
/// serves the SPA, else the first allowed SPA origin, else a relative `/`.
fn spa_redirect(
    config: &Config,
    uri: &Uri,
    headers: &HeaderMap,
    auth_error: Option<&str>,
    cookies: &[HeaderValue],
) -> Response {
    let base = if config.serve_spa {
        request_origin(uri, headers)
    } else {
        config.allowed_origins.first().cloned()
    };
    let location = match base
        .and_then(|b| reqwest::Url::parse(&b).ok())
        .and_then(|b| b.join("/").ok())
    {
        Some(mut url) => {
            if let Some(e) = auth_error {
                url.query_pairs_mut().append_pair("auth_error", e);
            }
            url.to_string()
        }
        None => match auth_error {
            Some(e) => format!("/?auth_error={e}"),
            None => "/".into(),
        },
    };
    found(&location, cookies)
}

/// Record a failed exchange; the reason key for the SPA / the native body.
fn exchange_failed(outcome: &Reporter, e: ExchangeError) -> &'static str {
    if e == ExchangeError::ProviderUnavailable {
        outcome.record(Outcome::Transient, Reason::ProviderUnavailable);
        "workos_unavailable"
    } else {
        outcome.record(Outcome::Invalid, Reason::IdentityTokenInvalid);
        "workos_code_invalid"
    }
}

/// GET /api/auth/workos/start. No limiter: it only writes a 10-minute cookie
/// and redirects; the code exchange on /callback is the guarded leg.
async fn start(State(st): State<AuthState>, Query(q): Query<Vec<(String, String)>>) -> Response {
    if !st.config.workos_configured() {
        return workos_not_configured();
    }
    let invite = first(&q, "invite")
        .filter(|i| token_shape(i, 22..=22))
        .unwrap_or_default();
    let nonce: String = rand::random::<[u8; 16]>()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let url = st
        .workos
        .authorize_url(&st.config, &nonce, first(&q, "provider"), None);
    found(
        &url,
        &[state_cookie(&st.config, &format!("{nonce}.{invite}"))],
    )
}

/// GET /api/auth/workos/callback.
async fn callback(
    State(st): State<AuthState>,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let outcome = Reporter::new(&headers, Provider::Workos, Phase::IdentityVerify);
    outcome
        .run(callback_inner(&st, &uri, &headers, &q, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn callback_inner(
    st: &AuthState,
    uri: &Uri,
    headers: &HeaderMap,
    q: &[(String, String)],
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Workos, outcome) {
        return Ok(r);
    }
    if !st.config.workos_configured() {
        return Ok(not_configured(outcome, "workos"));
    }
    // The state cookie is single use: every answer from here deletes it.
    let clear = clear_state_cookie();
    let redirect = |auth_error: Option<&str>, cookies: &[HeaderValue]| {
        spa_redirect(&st.config, uri, headers, auth_error, cookies)
    };
    let stored = session::read_named_cookie(headers, STATE_COOKIE).unwrap_or_default();
    let (expected, invite) = match stored.split_once('.') {
        Some((nonce, invite)) if !nonce.is_empty() => (nonce, Some(invite)),
        _ => ("", None),
    };
    let code = first(q, "code").filter(|c| !c.is_empty());
    let state_ok = state_matches(expected, first(q, "state").unwrap_or_default());
    let (true, Some(code)) = (state_ok, code) else {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        return Ok(redirect(
            Some("workos_state_invalid"),
            std::slice::from_ref(&clear),
        ));
    };

    let identity = match st.workos.exchange(&st.config, code, None).await {
        Ok(id) => id,
        Err(e) => {
            let reason = exchange_failed(outcome, e);
            return Ok(redirect(Some(reason), std::slice::from_ref(&clear)));
        }
    };
    let name = display_name(&identity);
    let sub = identity.sub;
    if let Err(reason) = admit_or_reason(st, &sub, invite, &name, AuthMode::Workos).await? {
        outcome.record(Outcome::Denied, Reason::NoInvite);
        return Ok(redirect(Some(reason), std::slice::from_ref(&clear)));
    }
    let role = members::effective_role(&st.pool, &st.config.admin_subs, &sub).await?;
    let cookie = session::mint(
        &st.session_key,
        &Session {
            sub,
            username: name,
            role,
            auth_mode: AuthMode::Workos,
            plex_auth_token: None,
        },
        st.now(),
    );
    let https = uri.scheme_str() == Some("https");
    outcome.record(Outcome::Authorized, Reason::Cookie);
    Ok(redirect(
        None,
        &[clear, session::set_cookie(&st.config, &cookie, https)],
    ))
}

/// POST /api/auth/workos/native/start: the authorize URL bound to the native
/// redirect and the app's PKCE challenge, plus a single-use state.
async fn native_start(State(st): State<AuthState>, body: Body) -> Response {
    if !st.config.workos_configured() {
        return workos_not_configured();
    }
    let body = match json_body(body, NATIVE_START_MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let challenge = text(&body, "code_challenge").unwrap_or_default();
    if !token_shape(challenge, 43..=43) {
        return error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_code_challenge" }),
        );
    }
    let state = st.workos.native_states.issue();
    let redirect_uri = &st.config.workos_native_redirect_uri;
    let url = st.workos.authorize_url(
        &st.config,
        &state,
        text(&body, "provider"),
        Some((redirect_uri, challenge)),
    );
    Json(json!({ "url": url, "state": state, "redirect_uri": redirect_uri })).into_response()
}

/// POST /api/auth/workos/native: code + verifier + state + the device triple
/// in, a device token out.
async fn native(State(st): State<AuthState>, headers: HeaderMap, body: Body) -> Response {
    let outcome = Reporter::new(&headers, Provider::Workos, Phase::IdentityVerify);
    outcome
        .run(native_inner(&st, &headers, body, &outcome))
        .await
        .unwrap_or_else(internal)
}

async fn native_inner(
    st: &AuthState,
    headers: &HeaderMap,
    body: Body,
    outcome: &Reporter,
) -> Result<Response> {
    if let Err(r) = st.limiter.check(headers, Kind::Workos, outcome) {
        return Ok(r);
    }
    if !st.config.workos_configured() {
        return Ok(not_configured(outcome, "workos"));
    }
    let body = match read_body(body, outcome).await {
        Ok(b) => b,
        Err(r) => return Ok(r),
    };
    let code = text(&body, "code").unwrap_or_default();
    let verifier = text(&body, "code_verifier").unwrap_or_default();
    // Burned whatever happens next, so a state is good for one attempt.
    let state_ok = st
        .workos
        .native_states
        .consume_at(text(&body, "state").unwrap_or_default(), Instant::now());
    if code.is_empty() || !token_shape(verifier, 43..=128) || !state_ok {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        return Ok(error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid_request" }),
        ));
    }

    let identity = match st.workos.exchange(&st.config, code, Some(verifier)).await {
        Ok(id) => id,
        Err(e) => {
            let reason = exchange_failed(outcome, e);
            let status = if e == ExchangeError::ProviderUnavailable {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::UNAUTHORIZED
            };
            return Ok(error(status, json!({ "error": reason })));
        }
    };
    let name = display_name(&identity);
    let sub = identity.sub;
    let invite = text(&body, "inviteCode");
    if !authorize_or_redeem(st, &sub, invite, &name, AuthMode::Workos).await? {
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
        auth_mode: AuthMode::Workos,
        username: &name,
    };
    let Some(response) = maybe_mint_device_token(st, &body, &device).await? else {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
        return Ok(error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing_device_fields" }),
        ));
    };
    if response.status().is_success() {
        outcome.record(Outcome::Authorized, Reason::DevicePair);
    } else {
        outcome.record(Outcome::Invalid, Reason::InvalidRequest);
    }
    Ok(response)
}

#[cfg(test)]
mod tests;
