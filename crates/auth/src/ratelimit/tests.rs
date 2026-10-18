//! auth.test.ts's rate-limit cases, minus the Plex PIN ones, against a test
//! router that runs the limiter the way the sign-in routes will.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::Request;
use axum::routing::post;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::*;
use crate::outcome::{Outcome, Phase, Provider, Reason};
use crate::testutil::{capture_logs, logs};

fn kind(s: &str) -> Kind {
    match s {
        "pin" => Kind::Pin,
        "check" => Kind::Check,
        "apple" => Kind::Apple,
        "google" => Kind::Google,
        "workos" => Kind::Workos,
        _ => unreachable!(),
    }
}

/// Limit first, then key the identity bucket on the body's unverified sub,
/// then "verify" (always rejects, as a forged token would).
async fn sign_in(
    State(limiter): State<Arc<Limiter>>,
    Path(k): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let k = kind(&k);
    let outcome = Reporter::new(&headers, Provider::Link, Phase::Check);
    if let Err(r) = limiter.check(&headers, k, &outcome) {
        return r;
    }
    if let Err(r) = limiter.check_identity(k, unverified_jwt_sub(&body).as_deref(), &outcome) {
        return r;
    }
    outcome.record(Outcome::Invalid, Reason::IdentityTokenInvalid);
    StatusCode::UNAUTHORIZED.into_response()
}

fn app(trust: bool) -> Router {
    Router::new()
        .route("/{kind}", post(sign_in))
        .with_state(Arc::new(Limiter::new(trust)))
}

async fn send(
    app: &Router,
    kind: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (StatusCode, Option<u64>, Value) {
    let mut req = Request::builder().method("POST").uri(format!("/{kind}"));
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let retry = res
        .headers()
        .get(header::RETRY_AFTER)
        .map(|v| v.to_str().unwrap().parse().unwrap());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        retry,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn fake_jwt(sub: &str) -> String {
    let b64 = |v: Value| URL_SAFE_NO_PAD.encode(v.to_string());
    format!(
        "{}.{}.sig",
        b64(json!({ "alg": "RS256" })),
        b64(json!({ "sub": sub }))
    )
}

fn rate_limited_lines() -> Vec<String> {
    logs()
        .lines()
        .filter(|l| l.contains("outcome=\"rate_limited\""))
        .map(String::from)
        .collect()
}

#[tokio::test]
async fn throttles_one_identity_even_with_untrusted_ip_headers() {
    // TRUST_CLIENT_IP_HEADERS off: no client bucket, so only the identity
    // bucket stops a stuffing run below the 200/min global one.
    let a = app(false);
    let stuffed = fake_jwt("001234.deadbeefdeadbeefdeadbeefdeadbeef.5678");
    for i in 0..20 {
        let ip = format!("203.0.113.{i}");
        let (status, _, _) = send(&a, "apple", &[("cf-connecting-ip", &ip)], &stuffed).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "attempt {i}");
    }
    capture_logs();
    let h = [("cf-connecting-ip", "203.0.113.250")];
    let (status, retry, body) = send(&a, "apple", &h, &stuffed).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, json!({ "error": "rate_limited" }));
    assert!(retry.is_some_and(|r| (1..=60).contains(&r)));
    let lines = rate_limited_lines();
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("scope=\"identity\""), "{}", lines[0]);
    assert!(!lines[0].contains("001234") && !lines[0].contains("203.0.113"));

    // A different identity is not collateral damage.
    let other = fake_jwt("009999.feedfacefeedfacefeedfacefeedface.1111");
    assert_eq!(
        send(&a, "apple", &[], &other).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Kinds keep separate buckets.
    assert_eq!(
        send(&a, "google", &[], &stuffed).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_token_without_a_parseable_sub_gets_the_global_bucket_only() {
    let a = app(false);
    for _ in 0..25 {
        let (status, _, _) = send(&a, "apple", &[], "not-a-jwt-at-all").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn caps_a_trusted_client_even_while_it_rotates_forwarded_for() {
    let a = app(true);
    for i in 0..300 {
        let xff = format!("203.0.113.{}", i % 256);
        let h = [
            ("cf-connecting-ip", "198.51.100.20"),
            ("x-forwarded-for", &xff),
        ];
        assert_eq!(send(&a, "check", &h, "").await.0, StatusCode::UNAUTHORIZED);
    }
    let h = [
        ("cf-connecting-ip", "198.51.100.20"),
        ("x-forwarded-for", "203.0.113.250"),
    ];
    let (status, retry, body) = send(&a, "check", &h, "").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body, json!({ "error": "rate_limited" }));
    assert!(retry.is_some_and(|r| r > 0));
    // Another client still has its own bucket (global 600 not reached).
    let h = [("cf-connecting-ip", "198.51.100.21")];
    assert_eq!(send(&a, "check", &h, "").await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn untrusted_client_headers_never_key_a_bucket() {
    let a = app(false);
    for _ in 0..301 {
        let h = [("cf-connecting-ip", "198.51.100.20")];
        assert_eq!(send(&a, "check", &h, "").await.0, StatusCode::UNAUTHORIZED);
    }
}

#[tokio::test]
async fn the_global_bucket_caps_rotating_identities() {
    let a = app(false);
    for i in 0..200 {
        let token = fake_jwt(&format!("sub-{i}"));
        assert_eq!(
            send(&a, "apple", &[], &token).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    capture_logs();
    let (status, _, _) = send(&a, "apple", &[], &fake_jwt("fresh")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(rate_limited_lines()[0].contains("scope=\"global\""));
    assert_eq!(
        send(&a, "workos", &[], "").await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_refused_request_counts_against_no_bucket() {
    // pin: 10 per client, 120 global. Client 0 fills its bucket, then is
    // refused 5 times; if those counted globally, client 11 would hit 120
    // early.
    let a = app(true);
    let ip = |n: u32| format!("198.51.100.{n}");
    for _ in 0..10 {
        let v = ip(0);
        let (status, _, _) = send(&a, "pin", &[("cf-connecting-ip", &v)], "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    for _ in 0..5 {
        let v = ip(0);
        let (status, _, _) = send(&a, "pin", &[("cf-connecting-ip", &v)], "").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }
    for n in 1..=11 {
        for _ in 0..10 {
            let v = ip(n);
            let (status, _, _) = send(&a, "pin", &[("cf-connecting-ip", &v)], "").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "client {n}");
        }
    }
    capture_logs();
    let v = ip(12);
    let (status, _, _) = send(&a, "pin", &[("cf-connecting-ip", &v)], "").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(rate_limited_lines()[0].contains("scope=\"global\""));
}

#[tokio::test]
async fn a_refusal_logs_one_redacted_warning_with_scope_and_retry_after() {
    let a = app(true);
    for _ in 0..10 {
        let h = [("cf-connecting-ip", "198.51.100.20")];
        assert_eq!(send(&a, "pin", &h, "").await.0, StatusCode::UNAUTHORIZED);
    }
    capture_logs();
    let h = [
        ("x-request-id", "link-start-rate-limit"),
        ("cf-connecting-ip", "198.51.100.20"),
        ("authorization", "Bearer SECRET-TOKEN"),
        ("cookie", "eex.session=SECRET-COOKIE"),
    ];
    let body = json!({ "inviteCode": "SECRET-INVITE", "identity": "SECRET-IDENTITY" });
    let (status, retry, _) = send(&a, "pin", &h, &body.to_string()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    let retry = retry.unwrap();
    assert!(retry > 0);

    let text = logs();
    let lines = rate_limited_lines();
    assert_eq!(lines.len(), 1, "{text}");
    let line = &lines[0];
    assert!(
        line.contains(" WARN ") && line.contains("terminal"),
        "{line}"
    );
    for field in [
        "provider=\"link\"".to_string(),
        "phase=\"check\"".to_string(),
        "reason=\"local_rate_limit\"".to_string(),
        "scope=\"trusted_client\"".to_string(),
        "requestId=\"link-start-rate-limit\"".to_string(),
        format!("retryAfterSeconds={retry}"),
    ] {
        assert!(line.contains(&field), "{field} missing: {line}");
    }
    for secret in [
        "198.51.100.20",
        "SECRET-INVITE",
        "SECRET-TOKEN",
        "SECRET-COOKIE",
        "SECRET-IDENTITY",
    ] {
        assert!(!text.contains(secret), "{secret} leaked: {text}");
    }
}

#[test]
fn windows_reset_and_the_sweep_drops_expired_buckets() {
    let limiter = Limiter::new(true);
    let r = || Reporter::new(&HeaderMap::new(), Provider::Link, Phase::Check);
    let mut h = HeaderMap::new();
    h.insert("cf-connecting-ip", "198.51.100.20".parse().unwrap());
    let t0 = Instant::now();
    for _ in 0..10 {
        assert!(limiter.check_at(t0, &h, Kind::Pin, &r()).is_ok());
    }
    let refused = limiter
        .check_at(t0 + Duration::from_secs(30), &h, Kind::Pin, &r())
        .unwrap_err();
    assert_eq!(refused.headers()[header::RETRY_AFTER], "30");
    assert!(
        limiter
            .check_identity_at(t0, Kind::Pin, Some("someone"), &r())
            .is_ok()
    );
    assert_eq!(limiter.bucket_count(), 3);
    // The window is over: the sweep (due a minute after the last) drops all
    // three expired buckets, and the request opens two fresh ones.
    assert!(limiter.check_at(t0 + WINDOW, &h, Kind::Pin, &r()).is_ok());
    assert_eq!(limiter.bucket_count(), 2);
}

#[test]
fn retry_after_rounds_up_to_whole_seconds_with_a_floor_of_one() {
    assert_eq!(retry_after_seconds(Duration::ZERO), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(1)), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(1000)), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(1001)), 2);
    assert_eq!(retry_after_seconds(WINDOW), 60);
}

#[test]
fn identity_buckets_hash_the_identity() {
    let limiter = Limiter::new(false);
    let r = Reporter::new(&HeaderMap::new(), Provider::Apple, Phase::IdentityVerify);
    limiter
        .check_identity(Kind::Apple, Some("apple:SECRET"), &r)
        .unwrap();
    limiter.check_identity(Kind::Apple, Some(""), &r).unwrap();
    limiter.check_identity(Kind::Apple, None, &r).unwrap();
    let b = limiter.buckets.lock().unwrap();
    let keys: Vec<&String> = b.map.keys().collect();
    assert_eq!(keys.len(), 1);
    let digest = format!("{:x}", Sha256::digest(b"apple:SECRET"));
    assert_eq!(keys[0], &format!("apple:identity:{}", &digest[..16]));
}

#[test]
fn unverified_jwt_sub_reads_the_payload_without_verifying() {
    assert_eq!(unverified_jwt_sub(&fake_jwt("abc")).as_deref(), Some("abc"));
    // Padded base64url, as Buffer.from accepts.
    let padded = format!("h.{}==.s", URL_SAFE_NO_PAD.encode(r#"{"sub":"xy"}"#));
    assert_eq!(unverified_jwt_sub(&padded).as_deref(), Some("xy"));
    let payload = |v: &str| format!("h.{}.s", URL_SAFE_NO_PAD.encode(v));
    for bad in [
        "not-a-jwt-at-all".to_string(),
        "a.b".to_string(),
        format!("{}.extra", fake_jwt("abc")),
        "h.!!!.s".to_string(),
        payload("not json"),
        payload(r#"{"sub":42}"#),
        payload(r#"{"sub":""}"#),
        payload(r#"{"iss":"x"}"#),
    ] {
        assert_eq!(unverified_jwt_sub(&bad), None, "{bad}");
    }
}
