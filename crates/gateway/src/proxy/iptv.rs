//! /api/iptv and /api/dvr (routes/iptv.ts, dvr.ts, services/iptvService.ts):
//! gated proxies to the iptv service, which owns iptv.db and is the only
//! process that dials the provider. Paths, queries and bodies pass through
//! unchanged (a gzipped guide stays gzipped, Content-Encoding and all); the
//! gateway only decides who may reach them.
//!
//! - `GET /api/iptv/stream/**`: cookieless, a `?t=` (or `?u=` for segments)
//!   stream token: signature, time window and membership here; kind and
//!   resource at the service.
//! - `GET /api/iptv/playlist.m3u`: cookieless, a playlist token plus
//!   membership, the live section and the rating cap at serve time (VLC
//!   refetches it). A revoked member's playlist tokens are revoked.
//! - everything else: the session, then the live section except on the
//!   caller's own sessions and playlist-token list, then the rating cap on
//!   every grant and playlist mint (live TV carries no certification).
//! - /api/dvr: recordings belong to the live section; scheduling and
//!   deleting are admin-only, the grant needs an uncapped profile, and play
//!   takes a `?t=` recording token or the session with the grant's gates.

use std::sync::OnceLock;
use std::time::Duration;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use regex::Regex;
use serde_json::json;

use super::{IPTV_TTFB, copy, principal, req_id, token_caller};
use crate::AppState;
use crate::arr::shared::{query_first, query_pairs};
use crate::principal::Caller;
use crate::routes::err;
use crate::stores::Section;

/// Range for seeking, Accept-Encoding for the gzipped guide, the client IP
/// pair for the sessions widget.
const FORWARD_REQUEST: &[&str] = &[
    "range",
    "if-range",
    "accept-encoding",
    "content-type",
    "cf-connecting-ip",
    "x-forwarded-for",
];

const INTERNAL_TIMEOUT: Duration = Duration::from_secs(10);

pub fn router(st: &AppState) -> Router<AppState> {
    let mut r = Router::new();
    if !st.config.auth.iptv_disabled {
        r = r
            .route(
                "/api/iptv/stream/{*rest}",
                get(stream).fallback(session_route),
            )
            .route(
                "/api/iptv/playlist.m3u",
                get(playlist).fallback(session_route),
            )
            .route("/api/iptv", any(session_route))
            .route("/api/iptv/{*rest}", any(session_route));
    }
    if st.config.dvr_mounted() {
        r = r
            .route("/api/dvr/recordings", get(dvr_list).post(dvr_admin))
            .route("/api/dvr/recordings/{id}", get(dvr_list).delete(dvr_admin))
            .route("/api/dvr/recordings/{id}/grant", post(dvr_grant))
            .route("/api/dvr/recordings/{id}/play", get(dvr_play));
    }
    r
}

/// Who a forward acts as.
struct Actor {
    session: auth::session::Session,
    device_id: Option<String>,
}

impl Actor {
    fn from_sub(sub: String, role: auth::Role) -> Actor {
        Actor {
            session: auth::session::Session {
                auth_mode: auth::AuthMode::Local,
                username: String::new(),
                role,
                sub,
            },
            device_id: None,
        }
    }
}

async fn session(st: &AppState, headers: &HeaderMap) -> Result<Actor, Response> {
    auth::authenticate(&st.auth, headers)
        .await
        .map(|p| Actor {
            device_id: p.device.map(|d| d.device_id),
            session: p.session,
        })
        .map_err(IntoResponse::into_response)
}

async fn admin(st: &AppState, headers: &HeaderMap) -> Result<Actor, Response> {
    let a = session(st, headers).await?;
    if a.session.role != auth::Role::Admin {
        return Err(auth::Rejection::AdminOnly.into_response());
    }
    Ok(a)
}

/// The TS `detail` strings for a refused stream token.
fn legacy(e: emerald_contracts::stream_token::TokenError) -> &'static str {
    use emerald_contracts::stream_token::TokenError;
    match e {
        TokenError::Expired => "expired_token",
        TokenError::NotYetValid => "token_not_yet_valid",
        TokenError::UnsupportedVersion | TokenError::BadPayload => "token_version_unsupported",
        _ => "invalid_signature",
    }
}

/// Signature and time window; the claims' sub, or the 401.
// The 401 is the cold path; boxing it buys nothing.
#[allow(clippy::result_large_err)]
fn verify_token(st: &AppState, token: &str) -> Result<String, Response> {
    use emerald_contracts::stream_token;
    let secret = st.config.auth.stream_token_secret.as_bytes();
    stream_token::verify(secret, token)
        .and_then(|c| {
            stream_token::enforce_time_window(&c, chrono::Utc::now().timestamp()).map(|()| c.sub)
        })
        .map_err(|e| invalid(legacy(e)))
}

fn invalid(detail: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": "invalid_token", "detail": detail })),
    )
        .into_response()
}

/// verifyStreamTokenMember: the token, a well-formed sub, an allowed member.
async fn token_member(st: &AppState, token: &str) -> Result<String, Response> {
    let sub = verify_token(st, token)?;
    if emerald_contracts::parse_sub(&sub).is_err() {
        return Err(invalid("sub_invalid_format"));
    }
    super::require_member(st, &sub).await?;
    Ok(sub)
}

async fn live_section(st: &AppState, a: &Actor) -> Result<(), Response> {
    st.stores
        .policies
        .require_section(&a.session, Section::Live)
        .await
}

async fn cap(st: &AppState, a: &Actor) -> Result<(), Response> {
    match st.stores.policies.cap_blocks_unrated(&a.session).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(err(StatusCode::FORBIDDEN, "rating_blocked")),
        Err(e) => Err(e.into_response()),
    }
}

/// Forward the request as-is under `actor`'s principal and stream the reply.
async fn forward(st: &AppState, parts: &Parts, body: axum::body::Body, actor: &Actor) -> Response {
    let caller = Caller {
        role: actor.session.role.as_str(),
        device_id: actor.device_id.as_deref(),
        ..token_caller(&actor.session.sub)
    };
    let mut headers = HeaderMap::new();
    match principal(st, &caller, req_id(&parts.headers)).await {
        Ok(Some(bearer)) => {
            headers.insert(header::AUTHORIZATION, bearer);
        }
        Ok(None) => {}
        Err(res) => return res,
    }
    copy(&parts.headers, &mut headers, FORWARD_REQUEST);
    // Playlist URLs are minted against the public origin the client used.
    let inbound = |name: &str| parts.headers.get(name).cloned();
    let proto = inbound("x-forwarded-proto").unwrap_or_else(|| {
        HeaderValue::from_static(if parts.uri.scheme_str() == Some("https") {
            "https"
        } else {
            "http"
        })
    });
    headers.insert("x-forwarded-proto", proto);
    if let Some(host) = inbound("x-forwarded-host")
        .or_else(|| inbound("host"))
        .or_else(|| {
            parts
                .uri
                .authority()
                .and_then(|a| HeaderValue::from_str(a.as_str()).ok())
        })
    {
        headers.insert("x-forwarded-host", host);
    }
    let body = if matches!(parts.method, Method::GET | Method::HEAD) {
        None
    } else {
        Some(
            axum::body::to_bytes(body, usize::MAX)
                .await
                .unwrap_or_default(),
        )
    };
    let path = parts
        .uri
        .path_and_query()
        .map_or_else(|| parts.uri.path(), |p| p.as_str());
    let url = format!("{}{path}", st.config.auth.iptv_service_url);
    match st
        .proxy
        .send("iptv", parts.method.clone(), &url, headers, body, IPTV_TTFB)
        .await
    {
        Ok(res) => super::respond(res, None),
        Err(res) => res,
    }
}

// --- /api/iptv ------------------------------------------------------------------------

async fn stream(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let pairs = query_pairs(&parts.uri);
    let token = query_first(&pairs, "t")
        .or_else(|| query_first(&pairs, "u"))
        .unwrap_or_default();
    match token_member(&st, token).await {
        Ok(sub) => forward(&st, &parts, body, &Actor::from_sub(sub, auth::Role::User)).await,
        Err(res) => res,
    }
}

async fn playlist(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let pairs = query_pairs(&parts.uri);
    let sub = match verify_token(&st, query_first(&pairs, "t").unwrap_or_default()) {
        Ok(sub) => sub,
        Err(res) => return res,
    };
    let admin_subs = &st.config.auth.admin_subs;
    match auth::member_status(&st.auth.pool, admin_subs, &sub).await {
        Ok(auth::members::MemberStatus::Allowed) => {}
        Ok(status) => {
            // A revoked member's tokens die with the membership, not at
            // their 90-day exp.
            if status == auth::members::MemberStatus::Revoked
                && !st.config.auth.iptv_disabled
                && let Err(e) = super::iptv_internal(
                    &st,
                    Method::POST,
                    &format!(
                        "/internal/members/{}/revoke-playlist-tokens",
                        super::encode_uri_component(&sub)
                    ),
                    &sub,
                    None,
                    INTERNAL_TIMEOUT,
                )
                .await
            {
                tracing::error!(event = "iptv", error = %e, "playlist-token revoke failed");
            }
            return err(StatusCode::UNAUTHORIZED, "access_revoked");
        }
        Err(e) => return e.into_response(),
    }
    // No cookie here: the role is ADMIN_SUBS plus the members row.
    let role = match auth::effective_role(&st.auth.pool, admin_subs, &sub).await {
        Ok(role) => role,
        Err(e) => return e.into_response(),
    };
    let actor = Actor::from_sub(sub, role);
    if let Err(res) = live_section(&st, &actor).await {
        return res;
    }
    if let Err(res) = cap(&st, &actor).await {
        return res;
    }
    forward(&st, &parts, body, &actor).await
}

fn no_section() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^/(sessions(/[^/]+)?|playlist/tokens(/[^/]+)?)$").expect("static regex")
    })
}

fn capped() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^/(stream/(live|catchup|vod|series)/[^/]+/grant|playlist/token)$")
            .expect("static regex")
    })
}

async fn session_route(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let actor = match session(&st, &parts.headers).await {
        Ok(a) => a,
        Err(res) => return res,
    };
    let path = match parts.uri.path().strip_prefix("/api/iptv") {
        Some("") | None => "/",
        Some(rest) => rest,
    };
    if !no_section().is_match(path)
        && let Err(res) = live_section(&st, &actor).await
    {
        return res;
    }
    if parts.method == Method::POST
        && capped().is_match(path)
        && let Err(res) = cap(&st, &actor).await
    {
        return res;
    }
    forward(&st, &parts, body, &actor).await
}

// --- /api/dvr -------------------------------------------------------------------------

async fn dvr_admin(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    match admin(&st, &parts.headers).await {
        Ok(a) => forward(&st, &parts, body, &a).await,
        Err(res) => res,
    }
}

async fn live_gates(
    st: &AppState,
    parts: &Parts,
    body: axum::body::Body,
    a: &Actor,
    capped: bool,
) -> Response {
    if let Err(res) = live_section(st, a).await {
        return res;
    }
    if capped && let Err(res) = cap(st, a).await {
        return res;
    }
    forward(st, parts, body, a).await
}

async fn dvr_list(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    match session(&st, &parts.headers).await {
        Ok(a) => live_gates(&st, &parts, body, &a, false).await,
        Err(res) => res,
    }
}

async fn dvr_grant(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    match session(&st, &parts.headers).await {
        Ok(a) => live_gates(&st, &parts, body, &a, true).await,
        Err(res) => res,
    }
}

async fn dvr_play(State(st): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let pairs = query_pairs(&parts.uri);
    if let Some(token) = query_first(&pairs, "t").filter(|t| !t.is_empty()) {
        return match token_member(&st, token).await {
            Ok(sub) => forward(&st, &parts, body, &Actor::from_sub(sub, auth::Role::User)).await,
            Err(res) => res,
        };
    }
    match session(&st, &parts.headers).await {
        Ok(a) => live_gates(&st, &parts, body, &a, true).await,
        Err(res) => res,
    }
}
