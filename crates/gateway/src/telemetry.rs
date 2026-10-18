//! Glitchtip (§15): the server's own crash reports, scrubbed before they
//! leave the box by `emerald_contracts::telemetry` (the key denylist plus the
//! stream-token and JWE string rules) and the login query secrets SDK URLs
//! can carry. An event that cannot be scrubbed is dropped, never sent raw.
//!
//! Also the client half (routes/telemetry.ts): `GET /api/telemetry/config`
//! hands client SDKs the public DSN, and `POST /api/telemetry/tunnel` relays
//! the SPA's envelopes to Glitchtip on the docker network (the public DSN's
//! host is unreachable off the tailnet). And the boot self-check
//! (serverTelemetry.ts): a DSN that does not resolve, or a store endpoint
//! that rejects, is logged loudly instead of every event vanishing.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http_body_util::{BodyExt, Limited};
use regex::Regex;
use sentry::protocol::{Breadcrumb, Event};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::AppState;
use crate::config::Config;
use crate::routes::err;

/// The internal DSN (reachable inside the docker network) wins over the
/// public one handed to clients. None, or an unparsable DSN, leaves the SDK
/// off.
pub fn init(config: &Config) -> Option<sentry::ClientInitGuard> {
    let dsn = config
        .telemetry_dsn_internal
        .as_deref()
        .or(config.telemetry_dsn.as_deref())?;
    let Ok(dsn) = dsn.parse::<sentry::types::Dsn>() else {
        tracing::error!(
            event = "telemetry",
            "EEX_TELEMETRY_DSN is not a valid DSN; telemetry off"
        );
        return None;
    };
    let mut options = sentry::ClientOptions::default();
    options.dsn = Some(dsn);
    options.release = Some(config.release.clone().into());
    options.environment = Some(
        if config.auth.is_prod {
            "production"
        } else {
            "staging"
        }
        .into(),
    );
    options.send_default_pii = false;
    options.before_send = Some(Arc::new(|e: Event<'static>| scrub(&e)));
    options.before_breadcrumb = Some(Arc::new(|b: Breadcrumb| scrub(&b)));
    Some(sentry::init(options))
}

fn auth_query_secret() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r#"(?i)([?&](?:inviteCode|invite_code|setupToken|idToken|id_token)=)[^&#\s"']+"#)
            .expect("static regex")
    })
}

/// Round-trip through JSON: redact URL login secrets in the text, then walk
/// it with the contract scrubber.
pub fn scrub<T: Serialize + DeserializeOwned>(item: &T) -> Option<T> {
    let text = serde_json::to_string(item).ok()?;
    let text = auth_query_secret().replace_all(&text, "${1}REDACTED");
    let mut value: serde_json::Value = serde_json::from_str(&text).ok()?;
    emerald_contracts::telemetry::scrub_value(&mut value);
    serde_json::from_value(value).ok()
}

// --- client routes ---------------------------------------------------------------

/// Envelopes are capped; callers share 30 per minute per key.
pub const TUNNEL_BODY_LIMIT: usize = 256 * 1024;
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(5);
const RELAY_TIMEOUT: Duration = Duration::from_secs(2);

pub fn tunnel_limiter() -> media_core::rate_limit::RateLimiter {
    media_core::rate_limit::RateLimiter::new(30, 30, Duration::from_secs(60))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/telemetry/config", get(config))
        .route("/api/telemetry/tunnel", post(tunnel))
}

/// Public bootstrap metadata. The DSN is not a secret: its key only
/// authorizes writes to that project. A malformed DSN is a 500 here rather
/// than a fleet of clients that silently send nothing.
async fn config(State(st): State<AppState>) -> Response {
    let Some(dsn) = st.config.telemetry_dsn.as_deref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "telemetry_not_configured",
                "detail": "EEX_TELEMETRY_DSN is not set. Create an EEX project in Glitchtip, copy the DSN, and set EEX_TELEMETRY_DSN in your environment. Telemetry remains disabled until configured.",
            })),
        )
            .into_response();
    };
    let invalid = |detail: String| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "telemetry_dsn_invalid", "detail": detail })),
        )
            .into_response()
    };
    let Ok(url) = reqwest::Url::parse(dsn) else {
        return invalid(
            "EEX_TELEMETRY_DSN is set but is not a valid URL. Sentry-compatible DSNs must be a URL of the form https://<key>@<host>/<projectId>. Correct EEX_TELEMETRY_DSN and restart the server.".into(),
        );
    };
    if !matches!(url.scheme(), "http" | "https") {
        return invalid(format!(
            "EEX_TELEMETRY_DSN must use the http or https scheme. Received scheme: {}:",
            url.scheme()
        ));
    }
    Json(json!({
        "dsn": dsn,
        "environment": if st.config.auth.is_prod { "production" } else { "staging" },
        "release": st.config.release,
    }))
    .into_response()
}

/// The DSN's key and project, both required.
fn dsn_identity(dsn: Option<&str>) -> Option<(String, String)> {
    let url = reqwest::Url::parse(dsn?).ok()?;
    let project = url.path().trim_matches('/');
    (!url.username().is_empty() && !project.is_empty())
        .then(|| (url.username().to_string(), project.to_string()))
}

/// `scheme://host[:port]` of a URL.
fn origin(url: &reqwest::Url) -> String {
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!(
        "{}://{}{port}",
        url.scheme(),
        url.host_str().unwrap_or_default()
    )
}

fn server_side_dsn(c: &Config) -> Option<&str> {
    c.telemetry_dsn_internal
        .as_deref()
        .or(c.telemetry_dsn.as_deref())
}

/// The SPA's Sentry `tunnel`. Open (crashes happen before sign-in) but
/// narrow: the envelope header must name OUR key and project, the body is
/// capped, callers are rate-limited, and it only ever posts to our Glitchtip.
async fn tunnel(State(st): State<AppState>, req: Request) -> Response {
    let ip = st
        .config
        .auth
        .trust_client_ip_headers
        .then(|| {
            let h = req.headers();
            let get = |n: &str| h.get(n).and_then(|v| v.to_str().ok());
            get("cf-connecting-ip").map(String::from).or_else(|| {
                get("x-forwarded-for")
                    .map(|v| v.split(',').next().unwrap_or_default().trim().to_string())
            })
        })
        .flatten();
    let key = ip.map_or_else(|| "anon".to_string(), |ip| format!("ip:{ip}"));
    if let Err(res) = st.tunnel.check(&key) {
        return res;
    }
    let body = match Limited::new(req.into_body(), TUNNEL_BODY_LIMIT)
        .collect()
        .await
    {
        Ok(b) => String::from_utf8_lossy(&b.to_bytes()).into_owned(),
        Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large"),
    };
    let public = dsn_identity(st.config.telemetry_dsn.as_deref());
    let target = server_side_dsn(&st.config).and_then(|d| reqwest::Url::parse(d).ok());
    let (Some((key, project)), Some(target)) = (public, target) else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "telemetry_not_configured");
    };
    let first = body.split('\n').next().unwrap_or_default();
    let Ok(header) = serde_json::from_str::<serde_json::Value>(first) else {
        return err(StatusCode::BAD_REQUEST, "invalid_envelope");
    };
    let claimed = dsn_identity(header.get("dsn").and_then(|d| d.as_str()));
    if claimed.as_ref() != Some(&(key.clone(), project.clone())) {
        return err(StatusCode::FORBIDDEN, "dsn_mismatch");
    }
    // Glitchtip authenticates an envelope by sentry_key in the query, not
    // by the DSN in its header.
    let url = format!(
        "{}/api/{project}/envelope/?sentry_version=7&sentry_key={}",
        origin(&target),
        crate::proxy::encode_uri_component(&key)
    );
    let req = st
        .upstream
        .client()
        .post(url)
        .header(header::CONTENT_TYPE, "application/x-sentry-envelope")
        .body(body);
    let reply = st
        .upstream
        .fetch(req, TUNNEL_TIMEOUT, "telemetry.tunnel")
        .await;
    let status = if reply.is_success() {
        StatusCode::OK
    } else {
        StatusCode::BAD_GATEWAY
    };
    (status, Body::empty()).into_response()
}

// --- the boot self-check -----------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum SelfCheck {
    Disabled,
    Misconfigured,
    Unresolvable { hostname: String, error: String },
    ProbeFailed { hostname: String, detail: String },
    Ok { hostname: String },
}

/// Resolve the server-side DSN's host from inside this container, then post
/// a benign info event to its store endpoint (which doubles as the deploy
/// gate's direct store test). Never fails the boot: the caller spawns it.
pub async fn self_check(c: &Config, upstream: &crate::upstream::Upstream) -> SelfCheck {
    self_check_with(c, upstream, |host, port| async move {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    })
    .await
}

/// [`self_check`] with the DNS lookup injected (tests never touch real DNS).
pub async fn self_check_with<F, Fut>(
    c: &Config,
    upstream: &crate::upstream::Upstream,
    resolve: F,
) -> SelfCheck
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let Some(dsn) = server_side_dsn(c) else {
        return SelfCheck::Disabled;
    };
    let parsed = reqwest::Url::parse(dsn).ok().and_then(|u| {
        let project = u.path().trim_start_matches('/').to_string();
        (!project.is_empty() && !u.username().is_empty()).then(|| {
            let store = format!("{}/api/{project}/store/", origin(&u));
            (
                u.host_str().unwrap_or_default().to_string(),
                u.username().to_string(),
                store,
                u.port_or_known_default().unwrap_or(443),
            )
        })
    });
    let Some((hostname, key, store, port)) = parsed else {
        tracing::error!(
            event = "telemetry",
            "EEX_TELEMETRY_DSN is set but MALFORMED: telemetry is disabled and every server/background error will be silently dropped. Fix the DSN shape (https://<key>@<host>/<projectId>)."
        );
        return SelfCheck::Misconfigured;
    };
    let host = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    if let Err(error) = resolve(host, port).await {
        tracing::error!(
            event = "telemetry",
            hostname,
            error,
            "Glitchtip DSN host \"{hostname}\" is UNRESOLVABLE from inside this container: ALL server-side and background telemetry will be silently dropped. Point the DSN at a host this network can resolve (a LAN or reverse-proxy address, or a sidecar on the same docker network), not a bare MagicDNS name."
        );
        return SelfCheck::Unresolvable { hostname, error };
    }
    let event = json!({
        "event_id": uuid::Uuid::new_v4().simple().to_string(),
        "timestamp": auth::now_iso(),
        "level": "info",
        "message": "eex telemetry self-check (boot)",
        "platform": "rust",
    });
    let req = upstream
        .client()
        .post(store)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            "X-Sentry-Auth",
            format!("Sentry sentry_version=7, sentry_key={key}"),
        )
        .body(event.to_string());
    let reply = upstream
        .fetch(req, RELAY_TIMEOUT, "telemetry.selfcheck")
        .await;
    if !reply.is_success() {
        let status = reply.status.as_u16();
        tracing::error!(
            event = "telemetry",
            hostname,
            status,
            "Glitchtip DSN host \"{hostname}\" resolves but the store endpoint rejected the boot self-check (HTTP {status}): telemetry delivery is broken. Verify the DSN key/project and that Glitchtip is reachable."
        );
        return SelfCheck::ProbeFailed {
            hostname,
            detail: format!("http_{status}"),
        };
    }
    tracing::info!(
        event = "telemetry",
        hostname,
        "Glitchtip DSN self-check passed: telemetry pipeline reachable"
    );
    SelfCheck::Ok { hostname }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_lose_tokens_cookies_and_login_secrets() {
        let mut event = Event {
            message: Some("grant /api/media/stream?t=tok123 eyJhbGciOiJkaXIifQ.x.y.z.w".into()),
            ..Default::default()
        };
        event
            .extra
            .insert("authorization".into(), "Bearer abc".into());
        event.extra.insert(
            "url".into(),
            "https://api.example/api/auth/workos/start?inviteCode=INV-1&x=1".into(),
        );
        let out = scrub(&event).unwrap();
        let msg = out.message.unwrap();
        assert!(
            msg.contains("t=REDACTED") && !msg.contains("tok123"),
            "{msg}"
        );
        assert!(!msg.contains("eyJhbGciOiJkaXIifQ"), "{msg}");
        assert_eq!(out.extra["authorization"], "REDACTED");
        assert_eq!(
            out.extra["url"],
            "https://api.example/api/auth/workos/start?inviteCode=REDACTED&x=1"
        );
        assert_eq!(out.event_id, event.event_id);
    }

    #[test]
    fn breadcrumbs_are_scrubbed_too() {
        let mut b = Breadcrumb {
            message: Some("GET /api/x?id_token=secret".into()),
            ..Default::default()
        };
        b.data.insert("cookie".into(), "eex.session=abc".into());
        let out = scrub(&b).unwrap();
        assert_eq!(out.message.as_deref(), Some("GET /api/x?id_token=REDACTED"));
        assert_eq!(out.data["cookie"], "REDACTED");
    }

    // --- routes/telemetry.test.ts, serverTelemetry.test.ts (the self-check) ---

    use crate::proxy::fake::{Fake, Route};
    use crate::testutil::{config as test_config, json_req, send, state_in};

    async fn config_body(extra: &[(&str, &str)]) -> (u16, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(&dir, extra).await;
        let r = send(
            &crate::router(st),
            json_req("GET", "/api/telemetry/config", None, None),
        )
        .await;
        (r.status.as_u16(), serde_json::from_str(&r.body).unwrap())
    }

    #[tokio::test]
    async fn config_names_the_environment_and_release() {
        let (status, b) = config_body(&[
            ("EEX_TELEMETRY_DSN", "http://k@glitch.example:8000/1"),
            ("EEX_RELEASE", "sha-abc"),
        ])
        .await;
        assert_eq!(status, 200, "http is accepted too");
        assert_eq!(
            b,
            json!({ "dsn": "http://k@glitch.example:8000/1", "environment": "staging", "release": "sha-abc" })
        );
        let mut c = test_config(&[("EEX_TELEMETRY_DSN", "https://k@glitch.example/1")]);
        c.auth.is_prod = true;
        let dir = tempfile::tempdir().unwrap();
        let pool = auth::db::open(dir.path().join("s.db").to_str().unwrap())
            .await
            .unwrap();
        let st = AppState::new(pool, c);
        let r = send(
            &crate::router(st),
            json_req("GET", "/api/telemetry/config", None, None),
        )
        .await;
        let b: serde_json::Value = serde_json::from_str(&r.body).unwrap();
        assert_eq!(b["environment"], "production");
    }

    #[tokio::test]
    async fn an_empty_dsn_is_not_configured() {
        let (status, b) = config_body(&[("EEX_TELEMETRY_DSN", "")]).await;
        assert_eq!(
            (status, b["error"].as_str()),
            (503, Some("telemetry_not_configured"))
        );
    }

    #[tokio::test]
    async fn the_tunnel_keys_its_bucket_by_the_trusted_client_ip() {
        let fake = Fake::start("x").await;
        fake.set_routes(vec![Route::json(
            "POST",
            "/api/42/envelope/",
            200,
            json!({}),
        )]);
        let dsn = format!(
            "http://pubkey@{}/42",
            fake.url.trim_start_matches("http://")
        );
        let dir = tempfile::tempdir().unwrap();
        let st = state_in(
            &dir,
            &[
                ("EEX_TELEMETRY_DSN", &dsn),
                ("TRUST_CLIENT_IP_HEADERS", "1"),
            ],
        )
        .await;
        let app = crate::router(st);
        let post = |ip: &str| {
            axum::http::Request::post("/api/telemetry/tunnel")
                .header("cf-connecting-ip", ip)
                .body(axum::body::Body::from("not json"))
                .unwrap()
        };
        for _ in 0..30 {
            assert_eq!(send(&app, post("203.0.113.1")).await.status, 400);
        }
        assert_eq!(send(&app, post("203.0.113.1")).await.status, 429);
        assert_eq!(
            send(&app, post("203.0.113.2")).await.status,
            400,
            "another caller's bucket"
        );
    }

    fn dsn_config(public: &str, internal: Option<&str>) -> Config {
        let mut c = test_config(&[("EEX_TELEMETRY_DSN", public)]);
        c.telemetry_dsn_internal = internal.map(String::from);
        c
    }

    async fn resolves(_: String, _: u16) -> Result<(), String> {
        Ok(())
    }

    #[tokio::test]
    async fn self_check_is_quiet_without_a_dsn_and_loud_on_a_malformed_one() {
        let up = crate::upstream::Upstream::default();
        let none = test_config(&[]);
        assert_eq!(
            self_check_with(&none, &up, resolves).await,
            SelfCheck::Disabled
        );
        for bad in [
            "not a url",
            "https://glitch.example/42",
            "https://key@glitch.example/",
        ] {
            assert_eq!(
                self_check_with(&dsn_config(bad, None), &up, resolves).await,
                SelfCheck::Misconfigured,
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn self_check_reports_an_unresolvable_host() {
        let up = crate::upstream::Upstream::default();
        let c = dsn_config("https://key@glitch.tailnet.ts.net/42", None);
        let r = self_check_with(&c, &up, |host, port| async move {
            assert_eq!((host.as_str(), port), ("glitch.tailnet.ts.net", 443));
            Err("ENOTFOUND".to_string())
        })
        .await;
        assert_eq!(
            r,
            SelfCheck::Unresolvable {
                hostname: "glitch.tailnet.ts.net".into(),
                error: "ENOTFOUND".into()
            }
        );
    }

    #[tokio::test]
    async fn self_check_probes_the_internal_store_endpoint_with_an_event_id() {
        let fake = Fake::start("x").await;
        fake.set_routes(vec![Route::json(
            "POST",
            "/api/42/store/",
            200,
            json!({ "id": "x" }),
        )]);
        let host = fake.url.trim_start_matches("http://");
        let up = crate::upstream::Upstream::default();
        let c = dsn_config(
            "https://key@public.unresolvable.example/42",
            Some(&format!("http://key@{host}/42")),
        );
        assert_eq!(
            self_check_with(&c, &up, resolves).await,
            SelfCheck::Ok {
                hostname: "127.0.0.1".into()
            }
        );
        let calls = fake.settle().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].headers["x-sentry-auth"],
            "Sentry sentry_version=7, sentry_key=key"
        );
        let body: serde_json::Value = serde_json::from_slice(&calls[0].body).unwrap();
        let id = body["event_id"].as_str().unwrap();
        assert!(
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "{id}"
        );
        assert_eq!(
            (body["level"].as_str(), body["message"].as_str()),
            (Some("info"), Some("eex telemetry self-check (boot)"))
        );
        assert!(body["timestamp"].as_str().unwrap().ends_with('Z'));

        fake.set_routes(vec![Route::json("POST", "/api/42/store/", 403, json!({}))]);
        assert_eq!(
            self_check_with(&c, &up, resolves).await,
            SelfCheck::ProbeFailed {
                hostname: "127.0.0.1".into(),
                detail: "http_403".into()
            }
        );
        let dead = dsn_config("http://key@127.0.0.1:9/42", None);
        assert!(matches!(
            self_check_with(&dead, &up, resolves).await,
            SelfCheck::ProbeFailed { detail, .. } if detail == "http_504"
        ));
    }
}
