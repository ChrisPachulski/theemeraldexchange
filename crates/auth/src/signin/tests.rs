//! auth.test.ts's Apple, Google and /apple/nonce cases, devicePair.test.ts and
//! the Apple/Google rows of "structured browser login outcomes". The TS suite
//! mocked the verifiers; here real RS256 tokens signed by the committed test
//! key go through the real verifier against a local JWKS server, and authZ
//! runs on a real server.db.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use super::*;
use crate::invites::IssueOptions;
use crate::jwks::Jwks;
use crate::testutil::*;

const APPLE_AUD: &str = "com.example.eex";
const GOOGLE_AUD: &str = "123-abc.apps.googleusercontent.com";
const APPLE_SUB: &str = "apple:000000.0123456789abcdef0123456789abcdef.0000";
const GOOGLE_SUB: &str = "google:104223294318414512345";
const ADMIN: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
const DEVICE: [(&str, &str); 3] = [
    ("device_id", "01HABCDEFGHJKMNPQRSTVWXYZ0"),
    ("device_name", "Living Room Apple TV"),
    ("device_platform", "tvos"),
];

struct Harness {
    db: TestDb,
    st: AuthState,
    jwks: JwksServer,
}

impl Harness {
    fn app(&self) -> axum::Router {
        crate::router(self.st.clone())
    }
}

async fn harness(extra: &[(&str, &str)]) -> Harness {
    let db = pool().await;
    let mut st = AuthState::new((*db).clone(), config(extra));
    let jwks = jwks_server(vec![jwk(&test_key(), TEST_KID)]).await;
    st.apple_jwks = Arc::new(Jwks::apple_at(&jwks.url));
    st.google_jwks = Arc::new(Jwks::google_at(&jwks.url));
    Harness { db, st, jwks }
}

async fn configured() -> Harness {
    harness(&[
        ("APPLE_CLIENT_ID", APPLE_AUD),
        ("GOOGLE_CLIENT_ID", GOOGLE_AUD),
    ])
    .await
}

fn apple_token(extra: Value) -> String {
    let now = unix_now();
    let mut claims = json!({
        "iss": "https://appleid.apple.com",
        "aud": APPLE_AUD,
        "sub": APPLE_SUB.strip_prefix("apple:").unwrap(),
        "email": "mom@example.com",
        "iat": now,
        "exp": now + 300,
    });
    for (k, v) in extra.as_object().unwrap() {
        claims[k] = v.clone();
    }
    sign(
        &test_key(),
        &json!({ "alg": "RS256", "kid": TEST_KID }),
        &claims,
    )
}

fn google_token(extra: Value) -> String {
    let now = unix_now();
    let mut claims = json!({
        "iss": "https://accounts.google.com",
        "aud": GOOGLE_AUD,
        "sub": GOOGLE_SUB.strip_prefix("google:").unwrap(),
        "email": "gary@example.com",
        "name": "Gary G",
        "iat": now,
        "exp": now + 300,
    });
    for (k, v) in extra.as_object().unwrap() {
        claims[k] = v.clone();
    }
    sign(
        &test_key(),
        &json!({ "alg": "RS256", "kid": TEST_KID }),
        &claims,
    )
}

fn forged(sub: &str) -> String {
    let claims = json!({ "iss": "https://appleid.apple.com", "aud": APPLE_AUD, "sub": sub, "exp": unix_now() + 300 });
    sign(
        &other_key(),
        &json!({ "alg": "RS256", "kid": TEST_KID }),
        &claims,
    )
}

struct Reply {
    status: u16,
    body: Value,
    cookie: Option<String>,
    retry_after: Option<String>,
}

async fn send(
    app: &axum::Router,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> Reply {
    let mut req = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let body = match body {
        Some(b) => {
            req = req.header(header::CONTENT_TYPE, "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let get = |h| {
        res.headers()
            .get(h)
            .map(|v: &axum::http::HeaderValue| v.to_str().unwrap().to_string())
    };
    let (cookie, retry_after) = (get(header::SET_COOKIE), get(header::RETRY_AFTER));
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
        retry_after,
    }
}

async fn post(h: &Harness, path: &str, body: Value) -> Reply {
    send(&h.app(), "POST", path, &[], Some(body)).await
}

fn with_device(mut body: Value) -> Value {
    for (k, v) in DEVICE {
        body[k] = v.into();
    }
    body
}

async fn invite(h: &Harness) -> String {
    crate::invites::issue(
        &h.db,
        ADMIN,
        IssueOptions {
            label: None,
            role: Role::User,
            expires_in_days: None,
            max_uses: 1,
        },
    )
    .await
    .unwrap()
    .code
}

async fn member_row(h: &Harness, sub: &str) -> Option<(Option<String>, String)> {
    sqlx::query_as("SELECT display_name, auth_mode FROM members WHERE sub = ?")
        .bind(sub)
        .fetch_optional(&*h.db)
        .await
        .unwrap()
}

async fn device_token_count(h: &Harness) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM device_tokens")
        .fetch_one(&*h.db)
        .await
        .unwrap()
}

fn sha256_hex(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}

// ── GET /api/auth/methods ──

#[tokio::test]
async fn methods_lists_the_configured_providers_without_a_plex_key() {
    let h = harness(&[]).await;
    let r = send(&h.app(), "GET", "/api/auth/methods", &[], None).await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        json!({ "apple": false, "google": false, "workos": false })
    );
    let r = send(
        &configured().await.app(),
        "GET",
        "/api/auth/methods",
        &[],
        None,
    )
    .await;
    assert_eq!(
        r.body,
        json!({ "apple": true, "google": true, "workos": false })
    );
}

// ── POST /api/auth/apple ──

#[tokio::test]
async fn apple_503s_when_not_configured() {
    let h = harness(&[]).await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "identityToken": apple_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, json!({ "error": "apple_not_configured" }));
}

#[tokio::test]
async fn apple_400s_a_browser_sign_in_without_a_nonce_before_verifying() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    for nonce in [None, Some("")] {
        let mut body = json!({ "identityToken": apple_token(json!({ "nonce": "n" })) });
        if let Some(n) = nonce {
            body["nonce"] = n.into();
        }
        let r = post(&h, "/api/auth/apple", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.body, json!({ "error": "invalid_nonce" }));
        assert_eq!(r.cookie, None);
    }
    assert_eq!(h.jwks.hits(), 0, "never reached the verifier");
}

#[tokio::test]
async fn apple_400s_a_missing_identity_token() {
    let h = configured().await;
    for body in [
        json!({}),
        json!({ "identityToken": "" }),
        json!({ "identityToken": 7 }),
    ] {
        let r = post(&h, "/api/auth/apple", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.body, json!({ "error": "missing identity_token" }));
    }
    // Unparseable JSON reads as an empty body.
    let req = Request::post("/api/auth/apple")
        .body(Body::from("{not json"))
        .unwrap();
    let res = h.app().oneshot(req).await.unwrap();
    assert_eq!(res.status().as_u16(), 400);
}

#[tokio::test]
async fn apple_413s_a_body_over_8_kb() {
    let h = configured().await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": "x".repeat(8200) }),
    )
    .await;
    assert_eq!(r.status, 413);
    assert_eq!(r.body, json!({ "error": "body_too_large" }));
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": "x".repeat(8000) }),
    )
    .await;
    assert_eq!(r.status, 401, "under the cap reaches the verifier");
}

#[tokio::test]
async fn apple_401s_an_invalid_identity_token() {
    let h = configured().await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": forged(APPLE_SUB.strip_prefix("apple:").unwrap()) }),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(
        r.body,
        json!({ "error": "invalid_identity_token", "reason": "invalid_signature" })
    );
    assert_eq!(r.cookie, None);
}

#[tokio::test]
async fn apple_admin_subs_identity_gets_an_admin_session() {
    let h = harness(&[("APPLE_CLIENT_ID", APPLE_AUD), ("ADMIN_SUBS", APPLE_SUB)]).await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })) }),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["user"]["role"], "admin");
    assert!(r.cookie.unwrap().starts_with("eex.session="));
}

#[tokio::test]
async fn apple_503s_when_the_key_set_is_unavailable() {
    let mut h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    h.st.apple_jwks = Arc::new(Jwks::apple_at(&dead_url().await));
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })) }),
    )
    .await;
    assert_eq!(r.status, 503);
    assert_eq!(
        r.body,
        json!({ "error": "invalid_identity_token", "reason": "jwks_unavailable" })
    );
}

#[tokio::test]
async fn apple_throttles_one_identity_even_with_untrusted_ip_headers() {
    let h = configured().await;
    assert!(!h.st.config.trust_client_ip_headers);
    let app = h.app();
    let stuffed = forged("001234.deadbeefdeadbeefdeadbeefdeadbeef.5678");
    for i in 0..20 {
        let ip = format!("203.0.113.{i}");
        let r = send(
            &app,
            "POST",
            "/api/auth/apple",
            &[("cf-connecting-ip", &ip)],
            Some(json!({ "nonce": "n", "identityToken": stuffed })),
        )
        .await;
        assert_eq!(r.status, 401);
    }
    let limited = send(
        &app,
        "POST",
        "/api/auth/apple",
        &[("cf-connecting-ip", "203.0.113.250")],
        Some(json!({ "nonce": "n", "identityToken": stuffed })),
    )
    .await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.body, json!({ "error": "rate_limited" }));
    assert!(limited.retry_after.is_some());
    // Another identity is not collateral damage.
    let other = forged("009999.feedfacefeedfacefeedfacefeedface.1111");
    let r = send(
        &app,
        "POST",
        "/api/auth/apple",
        &[],
        Some(json!({ "nonce": "n", "identityToken": other })),
    )
    .await;
    assert_eq!(r.status, 401);
}

#[tokio::test]
async fn apple_token_without_a_parseable_sub_still_reaches_the_verifier() {
    let h = configured().await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": "not-a-jwt-at-all" }),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.body["reason"], "malformed_token");
}

#[tokio::test]
async fn apple_identity_with_a_valid_invite_becomes_a_member_with_a_session() {
    let h = configured().await;
    let code = invite(&h).await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })), "inviteCode": code }),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        json!({ "status": "authorized", "user": {
            "sub": APPLE_SUB, "username": "mom", "email": "mom@example.com", "role": "user" } })
    );
    assert!(r.cookie.unwrap().starts_with("eex.session="));
    assert_eq!(
        member_row(&h, APPLE_SUB).await,
        Some((Some("mom".into()), "apple".into()))
    );
}

#[tokio::test]
async fn apple_member_re_login_needs_no_invite_and_burns_none() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    let code = invite(&h).await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })), "inviteCode": code }),
    )
    .await;
    assert_eq!(r.status, 200);
    let used: i64 = sqlx::query_scalar("SELECT used_count FROM invites")
        .fetch_one(&*h.db)
        .await
        .unwrap();
    assert_eq!(used, 0);
}

#[tokio::test]
async fn apple_identity_without_membership_or_invite_is_denied() {
    let h = configured().await;
    for code in [None, Some("bogus-code"), Some("")] {
        let mut body =
            json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })) });
        if let Some(c) = code {
            body["inviteCode"] = c.into();
        }
        let r = post(&h, "/api/auth/apple", body).await;
        assert_eq!(r.status, 403);
        assert_eq!(r.body, json!({ "status": "denied", "reason": "no_invite" }));
        assert_eq!(r.cookie, None);
    }
    // A revoked member stays out without an invite.
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    set_revoked(&h.db, APPLE_SUB).await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })) }),
    )
    .await;
    assert_eq!(r.status, 403);
}

#[tokio::test]
async fn apple_session_reports_auth_mode_apple_on_api_me() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "nonce": "n", "identityToken": apple_token(json!({ "nonce": "n" })) }),
    )
    .await;
    let cookie = r.cookie.unwrap();
    let pair = cookie.split(';').next().unwrap();
    let me = send(&h.app(), "GET", "/api/me", &[("cookie", pair)], None).await;
    assert_eq!(me.status, 200);
    assert_eq!(me.body["user"]["sub"], APPLE_SUB);
    assert_eq!(me.body["user"]["auth_mode"], "apple");
}

// ── POST /api/auth/google ──

#[tokio::test]
async fn google_503s_when_not_configured() {
    let h = harness(&[]).await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, json!({ "error": "google_not_configured" }));
}

#[tokio::test]
async fn google_400s_a_missing_identity_token() {
    let h = configured().await;
    // identityToken wins when it is a string, even an empty one.
    for body in [
        json!({}),
        json!({ "identityToken": "", "idToken": google_token(json!({})) }),
    ] {
        let r = post(&h, "/api/auth/google", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.body, json!({ "error": "missing identity_token" }));
    }
}

#[tokio::test]
async fn google_accepts_the_id_token_field_name() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "idToken": google_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["status"], "authorized");
}

#[tokio::test]
async fn google_401s_an_invalid_identity_token() {
    let h = configured().await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": forged("1") }),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(
        r.body,
        json!({ "error": "invalid_identity_token", "reason": "invalid_signature" })
    );
}

#[tokio::test]
async fn google_503s_when_the_key_set_is_unavailable() {
    let h = configured().await;
    h.jwks.status.store(500, Ordering::SeqCst);
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body["reason"], "jwks_unavailable");
}

#[tokio::test]
async fn google_compares_an_optional_nonce_as_sent() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let t = google_token(json!({ "nonce": "g-nonce" }));
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": t, "nonce": "other" }),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.body["reason"], "nonce_mismatch");
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": t, "nonce": "g-nonce" }),
    )
    .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn google_identity_with_a_valid_invite_becomes_a_member_with_a_session() {
    let h = configured().await;
    let code = invite(&h).await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})), "inviteCode": code }),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body,
        json!({ "status": "authorized", "user": {
            "sub": GOOGLE_SUB, "username": "Gary G", "email": "gary@example.com", "role": "user" } })
    );
    assert!(r.cookie.unwrap().starts_with("eex.session="));
    assert_eq!(
        member_row(&h, GOOGLE_SUB).await,
        Some((Some("Gary G".into()), "google".into()))
    );
}

#[tokio::test]
async fn google_display_name_falls_back_to_the_email_then_the_sub() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({ "name": null })) }),
    )
    .await;
    assert_eq!(r.body["user"]["username"], "gary");
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({ "name": null, "email": null })) }),
    )
    .await;
    assert_eq!(r.body["user"]["username"], GOOGLE_SUB);
    assert!(r.body["user"].get("email").is_none());
}

#[tokio::test]
async fn google_member_re_login_needs_no_invite() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn google_identity_without_membership_or_invite_is_denied() {
    let h = configured().await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})) }),
    )
    .await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body, json!({ "status": "denied", "reason": "no_invite" }));
}

#[tokio::test]
async fn google_session_cookie_round_trips_through_api_me() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})) }),
    )
    .await;
    let cookie = r.cookie.unwrap();
    let me = send(
        &h.app(),
        "GET",
        "/api/me",
        &[("cookie", cookie.split(';').next().unwrap())],
        None,
    )
    .await;
    assert_eq!(me.status, 200);
    assert_eq!(me.body["user"]["sub"], GOOGLE_SUB);
    assert_eq!(me.body["user"]["auth_mode"], "google");
}

// ── structured browser login outcomes ──

#[tokio::test]
async fn one_redacted_cookie_authorization_per_provider() {
    capture_logs();
    for (provider, path, sub, token) in [
        (
            "apple",
            "/api/auth/apple",
            APPLE_SUB,
            apple_token(json!({ "nonce": "n" })),
        ),
        (
            "google",
            "/api/auth/google",
            GOOGLE_SUB,
            google_token(json!({ "nonce": "n" })),
        ),
    ] {
        let h = configured().await;
        add_member(&h.db, sub, "user", provider).await;
        capture_logs();
        let request_id = format!("{provider}-cookie-outcome");
        let r = send(
            &h.app(),
            "POST",
            path,
            &[("x-request-id", &request_id)],
            Some(json!({ "nonce": "n", "identityToken": token })),
        )
        .await;
        assert_eq!(r.status, 200);
        let out = logs();
        let lines: Vec<&str> = out.lines().filter(|l| l.contains("auth_outcome")).collect();
        assert_eq!(lines.len(), 1, "{out}");
        for want in [
            format!("provider=\"{provider}\""),
            "phase=\"identity_verify\"".into(),
            "outcome=\"authorized\"".into(),
            "reason=\"cookie\"".into(),
            request_id.clone(),
        ] {
            assert!(lines[0].contains(&want), "{want} in {}", lines[0]);
        }
        assert!(!out.contains(&token) && !out.contains(sub), "{out}");
    }
}

#[tokio::test]
async fn a_store_failure_is_one_bounded_transient_event_and_a_500() {
    for (provider, path, token) in [
        (
            "apple",
            "/api/auth/apple",
            apple_token(json!({ "nonce": "n" })),
        ),
        (
            "google",
            "/api/auth/google",
            google_token(json!({ "nonce": "n" })),
        ),
    ] {
        let h = configured().await;
        h.db.close().await;
        capture_logs();
        let r = send(
            &h.app(),
            "POST",
            path,
            &[("x-request-id", "verifier-error")],
            Some(json!({ "nonce": "n", "identityToken": token })),
        )
        .await;
        assert_eq!(r.status, 500);
        let out = logs();
        let lines: Vec<&str> = out.lines().filter(|l| l.contains("auth_outcome")).collect();
        assert_eq!(lines.len(), 1, "{out}");
        for want in [
            format!("provider=\"{provider}\""),
            "outcome=\"transient\"".into(),
            "reason=\"server_error\"".into(),
            "verifier-error".into(),
        ] {
            assert!(lines[0].contains(&want), "{want} in {}", lines[0]);
        }
        assert!(!out.contains(&token), "{out}");
    }
}

// ── GET /api/auth/apple/nonce and the device-pair nonce ──

async fn issue(h: &Harness) -> String {
    let r = send(&h.app(), "GET", "/api/auth/apple/nonce", &[], None).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["expires_in"], 300);
    r.body["nonce"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn nonce_503s_when_apple_is_not_configured() {
    let h = harness(&[]).await;
    let r = send(&h.app(), "GET", "/api/auth/apple/nonce", &[], None).await;
    assert_eq!(r.status, 503);
    assert_eq!(r.body, json!({ "error": "apple_not_configured" }));
}

#[tokio::test]
async fn nonce_is_fresh_per_call() {
    let h = configured().await;
    let (a, b) = (issue(&h).await, issue(&h).await);
    assert_ne!(a, b);
    assert!(a.len() >= 43);
}

#[tokio::test]
async fn device_pair_without_a_server_issued_nonce_is_400_before_verifying() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    for nonce in [None, Some("made-up-by-the-client")] {
        let mut body = with_device(json!({ "identityToken": apple_token(json!({})) }));
        if let Some(n) = nonce {
            body["nonce"] = n.into();
        }
        let r = post(&h, "/api/auth/apple", body).await;
        assert_eq!(r.status, 400);
        assert_eq!(r.body, json!({ "error": "invalid_nonce" }));
    }
    assert_eq!(h.jwks.hits(), 0);
}

#[tokio::test]
async fn device_pair_matches_sha256_of_the_nonce_and_burns_it_on_first_use() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;

    // The claim holds the raw nonce, not its hash: rejected, and the nonce is spent.
    let nonce = issue(&h).await;
    let raw_claim = apple_token(json!({ "nonce": nonce }));
    let r = post(
        &h,
        "/api/auth/apple",
        with_device(json!({ "identityToken": raw_claim, "nonce": nonce })),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.body["reason"], "nonce_mismatch");
    let hashed = apple_token(json!({ "nonce": sha256_hex(&nonce) }));
    let r = post(
        &h,
        "/api/auth/apple",
        with_device(json!({ "identityToken": hashed, "nonce": nonce })),
    )
    .await;
    assert_eq!(r.status, 400, "burned by the failed attempt");

    let nonce = issue(&h).await;
    let token = apple_token(json!({ "nonce": sha256_hex(&nonce) }));
    let body = with_device(json!({ "identityToken": token, "nonce": nonce }));
    let r = post(&h, "/api/auth/apple", body.clone()).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(r.body["status"], "authorized");
    assert_eq!(r.cookie, None, "a device gets a Bearer, not a cookie");
    let replay = post(&h, "/api/auth/apple", body).await;
    assert_eq!(replay.status, 400);
    assert_eq!(replay.body, json!({ "error": "invalid_nonce" }));
    assert_eq!(device_token_count(&h).await, 1);
}

#[tokio::test]
async fn browser_flow_compares_the_client_nonce_as_sent() {
    let h = configured().await;
    add_member(&h.db, APPLE_SUB, "user", "apple").await;
    let hashed = apple_token(json!({ "nonce": sha256_hex("sdk-nonce") }));
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "identityToken": hashed, "nonce": "sdk-nonce" }),
    )
    .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.body["reason"], "nonce_mismatch");
    let as_sent = apple_token(json!({ "nonce": "sdk-nonce" }));
    let r = post(
        &h,
        "/api/auth/apple",
        json!({ "identityToken": as_sent, "nonce": "sdk-nonce" }),
    )
    .await;
    assert_eq!(r.status, 200);
}

#[test]
fn nonce_store_is_single_use_with_a_five_minute_ttl() {
    let nonces = Nonces::default();
    let t0 = Instant::now();
    let a = nonces.issue_at(t0);
    assert!(nonces.consume_at(&a, t0 + Duration::from_secs(299)));
    assert!(
        !nonces.consume_at(&a, t0 + Duration::from_secs(1)),
        "single use"
    );
    let b = nonces.issue_at(t0);
    assert!(
        !nonces.consume_at(&b, t0 + Duration::from_secs(300)),
        "expired"
    );
    assert!(!nonces.consume_at("never-issued", t0));
    // Expired entries are swept on the next issue.
    nonces.issue_at(t0);
    nonces.issue_at(t0 + Duration::from_secs(301));
    assert_eq!(nonces.len(), 1);
}

#[test]
fn nonce_store_evicts_the_oldest_at_10k() {
    let nonces = Nonces::default();
    let t0 = Instant::now();
    let first = nonces.issue_at(t0);
    let second = nonces.issue_at(t0 + Duration::from_nanos(1));
    for i in 2..NONCE_CAP as u64 {
        nonces.issue_at(t0 + Duration::from_nanos(i));
    }
    assert_eq!(nonces.len(), NONCE_CAP);
    let last = nonces.issue_at(t0 + Duration::from_millis(1));
    assert_eq!(nonces.len(), NONCE_CAP);
    let now = t0 + Duration::from_secs(1);
    assert!(!nonces.consume_at(&first, now), "oldest evicted");
    assert!(nonces.consume_at(&second, now));
    assert!(nonces.consume_at(&last, now));
}

// ── devicePair.test.ts (maybe_mint_device_token) ──

fn identity() -> DeviceIdentity<'static> {
    DeviceIdentity {
        sub: APPLE_SUB,
        role: Role::User,
        auth_mode: AuthMode::Apple,
        username: "mom",
    }
}

async fn reply(r: Response) -> (u16, Value) {
    let status = r.status().as_u16();
    let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn no_device_fields_means_the_cookie_path() {
    let h = configured().await;
    let body = json!({ "identityToken": "x", "inviteCode": "y" });
    assert!(
        maybe_mint_device_token(&h.st, &body, &identity())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(device_token_count(&h).await, 0);
}

#[tokio::test]
async fn a_partial_or_blank_triple_is_400_never_a_silent_cookie() {
    let h = configured().await;
    for body in [
        json!({ "device_id": "abc" }),
        json!({ "device_id": "DEV1", "device_name": "   ", "device_platform": "ios" }),
        json!({ "device_id": "DEV1", "device_name": 5, "device_platform": "ios" }),
    ] {
        let r = maybe_mint_device_token(&h.st, &body, &identity())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply(r).await,
            (400, json!({ "error": "incomplete_device_fields" }))
        );
    }
    assert_eq!(device_token_count(&h).await, 0);
}

#[tokio::test]
async fn a_full_triple_mints_a_device_token_in_the_device_wire_shape() {
    let h = configured().await;
    let body =
        json!({ "device_id": " DEV1 ", "device_name": "Mom's iPhone", "device_platform": "ios" });
    let r = maybe_mint_device_token(&h.st, &body, &identity())
        .await
        .unwrap()
        .unwrap();
    let (status, body) = reply(r).await;
    assert_eq!(status, 200);
    let server_id = crate::ensure_server_id(&h.db).await.unwrap();
    let token = body["token"].as_str().unwrap();
    assert_eq!(
        body,
        json!({ "status": "authorized", "token": token, "server_id": server_id,
                "user": { "sub": APPLE_SUB, "username": "mom", "role": "user" } })
    );
    let claims = device_tokens::verify(
        &h.db,
        h.st.device_keys.as_deref().unwrap(),
        token,
        unix_now(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        (
            claims.sub.as_str(),
            claims.auth_mode.as_str(),
            claims.device_id.as_str(),
            claims.device_platform.as_str()
        ),
        (APPLE_SUB, "apple", "DEV1", "ios")
    );
    let row: (String, Option<String>, String) =
        sqlx::query_as("SELECT device_name, username, platform FROM device_tokens")
            .fetch_one(&*h.db)
            .await
            .unwrap();
    assert_eq!(
        row,
        ("Mom's iPhone".into(), Some("mom".into()), "ios".into())
    );
}

#[tokio::test]
async fn google_device_pair_end_to_end() {
    let h = configured().await;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        with_device(json!({ "identityToken": google_token(json!({})) })),
    )
    .await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.body["user"],
        json!({ "sub": GOOGLE_SUB, "username": "Gary G", "role": "user" })
    );
    assert!(r.body["token"].is_string());
    let r = post(
        &h,
        "/api/auth/google",
        json!({ "identityToken": google_token(json!({})), "device_id": "only-one" }),
    )
    .await;
    assert_eq!(r.status, 400);
    assert_eq!(r.body, json!({ "error": "incomplete_device_fields" }));
}

#[tokio::test]
async fn a_device_pair_without_a_device_secret_is_a_500() {
    let mut h = configured().await;
    h.st.device_keys = None;
    add_member(&h.db, GOOGLE_SUB, "user", "google").await;
    let r = post(
        &h,
        "/api/auth/google",
        with_device(json!({ "identityToken": google_token(json!({})) })),
    )
    .await;
    assert_eq!(r.status, 500);
}
