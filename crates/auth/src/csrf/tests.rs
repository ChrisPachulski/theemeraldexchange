//! middleware/csrf.test.ts and app.csrf.test.ts, minus the Plex and passkey
//! paths. The Plex /device/poll and /plex/check paths are now plain gated
//! routes, which is asserted below.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::middleware::from_fn_with_state;
use axum::routing::{any, get, post};
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;

const APP: &str = "https://app.example";
const ATTACKER: &str = "https://attacker.example";
const STATE_CHANGING: [&str; 4] = ["POST", "PUT", "PATCH", "DELETE"];

#[derive(Clone, Copy)]
enum Gate {
    Safe,
    Trusted,
}

fn config(allowed: &[&str], is_prod: bool) -> Arc<Config> {
    let mut c = crate::testutil::config(&[]);
    c.allowed_origins = allowed.iter().map(|s| s.to_string()).collect();
    c.is_prod = is_prod;
    Arc::new(c)
}

async fn ok() -> Json<Value> {
    Json(json!({ "ok": true }))
}

fn app(allowed: &[&str], is_prod: bool, gate: Gate) -> Router {
    let mut r = Router::new()
        .route("/echo", any(ok))
        .route("/api/transcode/session/{id}/heartbeat", any(ok))
        // Cookie-authed or dropped auth paths: never in the bootstrap list.
        .route("/api/auth/device/link/claim", any(ok))
        .route("/api/auth/device/poll", any(ok))
        .route("/api/auth/plex/check", any(ok));
    for path in NATIVE_BOOTSTRAP_PATHS {
        r = r.route(path, any(ok));
    }
    let cfg = config(allowed, is_prod);
    match gate {
        Gate::Safe => r.layer(from_fn_with_state(cfg, require_safe_origin)),
        Gate::Trusted => r.layer(from_fn_with_state(cfg, require_trusted_origin)),
    }
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn forbidden(reason: &str) -> Value {
    json!({ "error": "forbidden", "reason": reason })
}

fn prod() -> Router {
    app(&[APP], true, Gate::Safe)
}

// ---- safe methods ------------------------------------------------------------

#[tokio::test]
async fn safe_methods_bypass_the_gate() {
    let a = prod();
    for method in ["GET", "HEAD"] {
        assert_eq!(send(&a, method, "/echo", &[]).await.0, StatusCode::OK);
    }
    let (status, _) = send(&a, "GET", "/echo", &[("origin", ATTACKER)]).await;
    assert_eq!(status, StatusCode::OK);
}

// ---- same-host pass ----------------------------------------------------------

#[tokio::test]
async fn same_host_origin_passes_with_an_empty_allowlist() {
    let a = app(&[], true, Gate::Safe);
    let h = [
        ("origin", "http://nas.local:3001"),
        ("host", "nas.local:3001"),
    ];
    assert_eq!(send(&a, "POST", "/echo", &h).await.0, StatusCode::OK);
    // Scheme ignored: a TLS-terminating sidecar in front of plain http.
    let h = [
        ("origin", "https://name.tail-net.ts.net"),
        ("host", "name.tail-net.ts.net"),
    ];
    assert_eq!(send(&a, "POST", "/echo", &h).await.0, StatusCode::OK);
    // URL.host semantics: lowercased, default port dropped.
    let h = [("origin", "https://NAS.local:443"), ("host", "nas.local")];
    assert_eq!(send(&a, "POST", "/echo", &h).await.0, StatusCode::OK);
}

#[tokio::test]
async fn cross_host_origins_still_fail_closed() {
    let a = app(&[], true, Gate::Safe);
    for origin in [
        ATTACKER,
        "http://nas.local:5173",
        "null",
        "http://user@nas.local:3001.evil",
    ] {
        let h = [("origin", origin), ("host", "nas.local:3001")];
        assert_eq!(
            send(&a, "POST", "/echo", &h).await.0,
            StatusCode::FORBIDDEN,
            "{origin}"
        );
    }
    // A matching Origin with no Host header is not same-host.
    let (status, _) = send(&a, "POST", "/echo", &[("origin", "http://nas.local:3001")]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn same_host_pass_applies_to_require_trusted_origin() {
    let a = app(&[], true, Gate::Trusted);
    let h = [
        ("origin", "http://nas.local:3001"),
        ("host", "nas.local:3001"),
    ];
    assert_eq!(send(&a, "GET", "/echo", &h).await.0, StatusCode::OK);
}

// ---- unconfigured allowlist --------------------------------------------------

#[tokio::test]
async fn empty_allowlist_passes_in_dev_and_fails_closed_in_prod() {
    let dev = app(&[], false, Gate::Safe);
    assert_eq!(send(&dev, "POST", "/echo", &[]).await.0, StatusCode::OK);
    let (status, body) = send(&app(&[], true, Gate::Safe), "POST", "/echo", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, forbidden("csrf_misconfigured"));
}

// ---- ?t= stream-token exemption ----------------------------------------------

#[tokio::test]
async fn token_authed_cookieless_post_passes_on_the_transcode_session_route() {
    let a = prod();
    let uri = "/api/transcode/session/abc/heartbeat?t=streamtoken";
    let h = [("origin", "https://www.app.example")];
    assert_eq!(send(&a, "POST", uri, &h).await.0, StatusCode::OK);
    assert_eq!(send(&a, "POST", uri, &[]).await.0, StatusCode::OK);
    // An empty token is no token.
    let uri = "/api/transcode/session/abc/heartbeat?t=";
    assert_eq!(send(&a, "POST", uri, &[]).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn t_does_not_open_the_cookie_minting_auth_paths() {
    let a = prod();
    for uri in [
        "/api/auth/device/link/claim?t=x",
        "/api/auth/plex/check?t=x",
    ] {
        let (status, body) = send(&a, "POST", uri, &[("origin", ATTACKER)]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(body, forbidden("bad_origin"));
    }
}

#[tokio::test]
async fn t_with_a_cookie_stays_gated() {
    let a = prod();
    for uri in [
        "/echo?t=streamtoken",
        "/api/transcode/session/abc/heartbeat?t=s",
    ] {
        let h = [("origin", ATTACKER), ("cookie", "eex.session=x")];
        assert_eq!(
            send(&a, "POST", uri, &h).await.0,
            StatusCode::FORBIDDEN,
            "{uri}"
        );
    }
}

// ---- allowlist ----------------------------------------------------------------

#[tokio::test]
async fn mismatched_origin_is_rejected_for_every_state_changing_method() {
    let a = prod();
    for method in STATE_CHANGING {
        let (status, body) = send(&a, method, "/echo", &[("origin", ATTACKER)]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method}");
        assert_eq!(body, forbidden("bad_origin"));
    }
}

#[tokio::test]
async fn post_without_origin_is_rejected() {
    let (status, body) = send(&prod(), "POST", "/echo", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, forbidden("bad_origin"));
}

#[tokio::test]
async fn post_with_an_allowed_origin_passes() {
    let a = app(&[APP, "https://staging.example"], true, Gate::Safe);
    let h = [("origin", "https://staging.example")];
    assert_eq!(send(&a, "POST", "/echo", &h).await.0, StatusCode::OK);
}

// ---- bearer-only exemption ---------------------------------------------------

#[tokio::test]
async fn bearer_without_cookie_passes_every_method_without_origin() {
    let a = prod();
    for method in STATE_CHANGING {
        let h = [("authorization", "Bearer device.jwe.token")];
        assert_eq!(
            send(&a, method, "/echo", &h).await.0,
            StatusCode::OK,
            "{method}"
        );
    }
}

#[tokio::test]
async fn bearer_with_a_cookie_stays_gated() {
    let h = [
        ("authorization", "Bearer device.jwe.token"),
        ("cookie", "eex_session=abc"),
    ];
    let (status, body) = send(&prod(), "POST", "/echo", &h).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, forbidden("bad_origin"));
}

#[tokio::test]
async fn other_authorization_schemes_are_not_exempt() {
    let a = prod();
    for value in ["Basic dXNlcjpwYXNz", "Bearer", "bearer device.jwe.token"] {
        let h = [("authorization", value)];
        assert_eq!(
            send(&a, "POST", "/echo", &h).await.0,
            StatusCode::FORBIDDEN,
            "{value}"
        );
    }
    assert_eq!(
        send(&a, "POST", "/echo", &[]).await.0,
        StatusCode::FORBIDDEN
    );
}

// ---- native bootstrap ----------------------------------------------------------

#[tokio::test]
async fn cookieless_originless_post_passes_every_bootstrap_path() {
    let a = prod();
    for path in NATIVE_BOOTSTRAP_PATHS {
        assert_eq!(
            send(&a, "POST", path, &[]).await.0,
            StatusCode::OK,
            "{path}"
        );
    }
}

#[tokio::test]
async fn hostile_origin_is_rejected_on_every_bootstrap_path() {
    let a = prod();
    for path in NATIVE_BOOTSTRAP_PATHS {
        let (status, body) = send(&a, "POST", path, &[("origin", ATTACKER)]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(body, forbidden("bad_origin"));
    }
}

#[tokio::test]
async fn google_bootstrap_applies_normal_origin_validation() {
    let a = prod();
    let cases: [(&[(&str, &str)], StatusCode); 6] = [
        (&[("origin", APP)], StatusCode::OK),
        (
            &[
                ("origin", "https://nas.local:3001"),
                ("host", "nas.local:3001"),
            ],
            StatusCode::OK,
        ),
        (&[("origin", ATTACKER)], StatusCode::FORBIDDEN),
        (&[("origin", "not a url")], StatusCode::FORBIDDEN),
        (&[("origin", "")], StatusCode::FORBIDDEN),
        (&[("origin", "null")], StatusCode::FORBIDDEN),
    ];
    for (headers, expected) in cases {
        let (status, _) = send(&a, "POST", "/api/auth/google", headers).await;
        assert_eq!(status, expected, "{headers:?}");
    }
}

#[tokio::test]
async fn bootstrap_with_a_cookie_is_gated() {
    let a = prod();
    let cases: [&[(&str, &str)]; 3] = [
        &[("cookie", "eex.session=abc")],
        &[("cookie", "")],
        &[("cookie", "eex.session=abc"), ("origin", ATTACKER)],
    ];
    for headers in cases {
        let (status, body) = send(&a, "POST", "/api/auth/google", headers).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{headers:?}");
        assert_eq!(body, forbidden("bad_origin"));
    }
    let h = [("cookie", "eex.session=abc"), ("origin", ATTACKER)];
    let (status, _) = send(&a, "POST", "/api/auth/device/link/poll", &h).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn non_bootstrap_auth_paths_stay_gated() {
    let a = prod();
    // The cookie-authed claim, and the dropped Plex paths.
    for path in [
        "/api/auth/device/link/claim",
        "/api/auth/device/poll",
        "/api/auth/plex/check",
        "/echo",
    ] {
        let (status, body) = send(&a, "POST", path, &[]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(body, forbidden("bad_origin"));
    }
}

// ---- require_trusted_origin ----------------------------------------------------

#[tokio::test]
async fn trusted_gate_exempts_bearer_only_reads() {
    let a = app(&[APP], true, Gate::Trusted);
    let h = [("authorization", "Bearer device.jwe.token")];
    assert_eq!(send(&a, "GET", "/echo", &h).await.0, StatusCode::OK);
    let h = [
        ("authorization", "Bearer device.jwe.token"),
        ("cookie", "eex_session=abc"),
    ];
    assert_eq!(send(&a, "GET", "/echo", &h).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn trusted_gate_checks_reads_too() {
    let a = app(&[APP], true, Gate::Trusted);
    for method in ["GET", "HEAD", "POST"] {
        let (status, body) = send(&a, method, "/echo", &[("origin", ATTACKER)]).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method}");
        if method != "HEAD" {
            assert_eq!(body["reason"], "bad_origin");
        }
    }
    assert_eq!(send(&a, "GET", "/echo", &[]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        send(&a, "GET", "/echo", &[("origin", APP)]).await.0,
        StatusCode::OK
    );
    // No bootstrap or ?t= bypass on the trusted gate.
    let (status, _) = send(&a, "POST", "/api/auth/google", &[]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let uri = "/api/transcode/session/abc/heartbeat?t=s";
    assert_eq!(send(&a, "POST", uri, &[]).await.0, StatusCode::FORBIDDEN);
    let dev = app(&[], false, Gate::Trusted);
    assert_eq!(send(&dev, "GET", "/echo", &[]).await.0, StatusCode::OK);
}

// ---- app composition (app.csrf.test.ts) ----------------------------------------

const ALLOWED: &str = "https://app.example.test";
const HOSTILE: &str = "https://attacker.example.test";
const COOKIE: &str = "eex.session=x";

/// auth::router plus stand-ins for the routes the gateway will mount, under
/// the global gate, with the suggestions read behind the trusted gate.
async fn composed() -> (crate::testutil::TestDb, Router) {
    let db = crate::testutil::pool().await;
    let mut cfg = crate::testutil::config(&[]);
    cfg.allowed_origins = vec![ALLOWED.into()];
    cfg.is_prod = true;
    let state = crate::AuthState::new(db.clone(), cfg);
    let config = state.config.clone();
    // A body extractor: proves the gate answers before any parsing.
    async fn google(Json(_): Json<Value>) -> Json<Value> {
        Json(json!({ "ok": true }))
    }
    let app = crate::router(state)
        .route("/api/health", get(ok))
        .route(
            "/api/suggestions/{type}",
            get(ok).route_layer(from_fn_with_state(config.clone(), require_trusted_origin)),
        )
        .route("/api/auth/logout", post(ok))
        .route("/api/auth/google", post(google))
        .route("/api/sab/api/queue/{id}/pause", post(ok))
        .route("/api/sab/api/queue/{id}/resume", post(ok))
        .route("/api/sab/api/queue/{id}", axum::routing::delete(ok))
        .route("/api/radarr/api/v3/movie/{id}", axum::routing::delete(ok))
        .route("/api/sonarr/api/v3/series/{id}", axum::routing::delete(ok))
        .route("/api/feedback", post(ok))
        .route(
            "/api/feedback/{type}/{id}/{signal}",
            axum::routing::delete(ok),
        )
        .layer(from_fn_with_state(config, require_safe_origin));
    (db, app)
}

#[tokio::test]
async fn app_safe_gets_pass_through() {
    let (_db, a) = composed().await;
    assert_eq!(send(&a, "GET", "/api/health", &[]).await.0, StatusCode::OK);
    let h = [("origin", HOSTILE)];
    assert_eq!(send(&a, "GET", "/api/health", &h).await.0, StatusCode::OK);
    // No session: 401 for the right reason, never 403 bad_origin.
    let (status, body) = send(&a, "GET", "/api/me", &h).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthenticated");
}

#[tokio::test]
async fn app_suggestions_get_is_origin_gated() {
    let (_db, a) = composed().await;
    for kind in ["movie", "tv"] {
        let h = [("cookie", COOKIE), ("origin", HOSTILE)];
        let (status, body) = send(&a, "GET", &format!("/api/suggestions/{kind}"), &h).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["reason"], "bad_origin");
    }
    let h = [("cookie", COOKIE)];
    let (status, body) = send(&a, "GET", "/api/suggestions/movie", &h).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["reason"], "bad_origin");
}

#[tokio::test]
async fn app_state_changing_routes_reject_bad_or_missing_origin() {
    let (_db, a) = composed().await;
    let cases = [
        ("POST", "/api/auth/logout"),
        ("POST", "/api/sab/api/queue/foo/pause"),
        ("POST", "/api/sab/api/queue/foo/resume"),
        ("DELETE", "/api/sab/api/queue/foo"),
        ("DELETE", "/api/radarr/api/v3/movie/42"),
        ("DELETE", "/api/sonarr/api/v3/series/42"),
        ("POST", "/api/feedback"),
        ("DELETE", "/api/feedback/movie/1/like"),
    ];
    for (method, path) in cases {
        for headers in [
            &[("cookie", COOKIE), ("origin", HOSTILE)][..],
            &[("cookie", COOKIE)][..],
        ] {
            let (status, body) = send(&a, method, path, headers).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path} {headers:?}");
            assert_eq!(body["reason"], "bad_origin");
        }
    }
}

#[tokio::test]
async fn app_bootstrap_rejects_browser_login_csrf_before_parsing() {
    let (_db, a) = composed().await;
    let h = [("origin", HOSTILE), ("content-type", "text/plain")];
    let (status, body) = send(&a, "POST", "/api/auth/google", &h).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, forbidden("bad_origin"));
}

#[tokio::test]
async fn app_state_changing_routes_accept_the_allowed_origin() {
    let (_db, a) = composed().await;
    let h = [("origin", ALLOWED)];
    assert_eq!(
        send(&a, "POST", "/api/auth/logout", &h).await.0,
        StatusCode::OK
    );
    let h = [("cookie", COOKIE), ("origin", ALLOWED)];
    let (status, _) = send(&a, "DELETE", "/api/radarr/api/v3/movie/42", &h).await;
    assert_ne!(status, StatusCode::FORBIDDEN);
}
