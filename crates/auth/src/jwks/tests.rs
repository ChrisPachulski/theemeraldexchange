//! appleAuth.test.ts and googleAuth.test.ts, against a local JWKS server and
//! the committed test keys (never appleid.apple.com or googleapis.com), plus
//! the key-set cache rules jose's createRemoteJWKSet gave the TS verifier.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;
use crate::testutil::*;

const APPLE_AUD: &str = "com.theemeraldexchange.app";
const APPLE_SUBJECT: &str = "000000.0123456789abcdef0123456789abcdef.0000";
const GOOGLE_AUD: &str = "123456789-abcdef.apps.googleusercontent.com";
const GOOGLE_SUBJECT: &str = "104223294318414512345";

fn header(kid: &str) -> Value {
    json!({ "alg": "RS256", "kid": kid })
}

fn apple_claims() -> Value {
    let now = unix_now();
    json!({
        "iss": "https://appleid.apple.com",
        "aud": APPLE_AUD,
        "sub": APPLE_SUBJECT,
        "iat": now,
        "exp": now + 300,
    })
}

fn google_claims() -> Value {
    let mut c = apple_claims();
    c["iss"] = "https://accounts.google.com".into();
    c["aud"] = GOOGLE_AUD.into();
    c["sub"] = GOOGLE_SUBJECT.into();
    c
}

fn with(mut claims: Value, k: &str, v: Value) -> Value {
    if v.is_null() {
        claims.as_object_mut().unwrap().remove(k);
    } else {
        claims[k] = v;
    }
    claims
}

fn token(claims: &Value) -> String {
    sign(&test_key(), &header(TEST_KID), claims)
}

async fn apple() -> (JwksServer, Jwks) {
    let server = jwks_server(vec![jwk(&test_key(), TEST_KID)]).await;
    let jwks = Jwks::apple_at(&server.url);
    (server, jwks)
}

async fn google() -> (JwksServer, Jwks) {
    let server = jwks_server(vec![jwk(&test_key(), TEST_KID)]).await;
    let jwks = Jwks::google_at(&server.url);
    (server, jwks)
}

async fn verify_apple(
    jwks: &Jwks,
    token: &str,
    nonce: Option<&str>,
) -> Result<Identity, VerifyError> {
    jwks.verify(token, &[APPLE_AUD.to_string()], nonce, unix_now())
        .await
}

async fn verify_google(
    jwks: &Jwks,
    token: &str,
    nonce: Option<&str>,
) -> Result<Identity, VerifyError> {
    jwks.verify(token, &[GOOGLE_AUD.to_string()], nonce, unix_now())
        .await
}

// ── appleAuth.test.ts ──

#[tokio::test]
async fn apple_verifies_a_well_formed_token_and_returns_the_apple_sub() {
    let (_s, jwks) = apple().await;
    let t = token(&with(apple_claims(), "email", "a@example.com".into()));
    let id = verify_apple(&jwks, &t, None).await.unwrap();
    assert_eq!(id.sub, format!("apple:{APPLE_SUBJECT}"));
    assert_eq!(id.email.as_deref(), Some("a@example.com"));
    assert_eq!(id.name, None);
}

#[tokio::test]
async fn apple_accepts_a_matching_nonce() {
    let (_s, jwks) = apple().await;
    let t = token(&with(apple_claims(), "nonce", "abc123nonce".into()));
    assert!(verify_apple(&jwks, &t, Some("abc123nonce")).await.is_ok());
}

#[tokio::test]
async fn apple_rejections() {
    let (_s, jwks) = apple().await;
    let now = unix_now();
    let cases: Vec<(&str, String, Option<&str>, VerifyError)> = vec![
        (
            "expired",
            token(&with(apple_claims(), "exp", (now - 600).into())),
            None,
            VerifyError::Expired,
        ),
        (
            "another audience",
            token(&with(apple_claims(), "aud", "com.someone.else".into())),
            None,
            VerifyError::WrongAud,
        ),
        (
            "wrong issuer",
            token(&with(
                apple_claims(),
                "iss",
                "https://evil.example.com".into(),
            )),
            None,
            VerifyError::WrongIss,
        ),
        (
            "Google's issuer",
            token(&with(
                apple_claims(),
                "iss",
                "https://accounts.google.com".into(),
            )),
            None,
            VerifyError::WrongIss,
        ),
        (
            "another key",
            sign(&other_key(), &header(TEST_KID), &apple_claims()),
            None,
            VerifyError::InvalidSignature,
        ),
        (
            "kid not in the set",
            sign(&test_key(), &header("unknown-kid"), &apple_claims()),
            None,
            VerifyError::UnknownKey,
        ),
        (
            "expected nonce absent",
            token(&apple_claims()),
            Some("expected"),
            VerifyError::NonceMismatch,
        ),
        (
            "nonce differs",
            token(&with(apple_claims(), "nonce", "actual".into())),
            Some("different"),
            VerifyError::NonceMismatch,
        ),
        (
            "nonce is a prefix",
            token(&with(apple_claims(), "nonce", "abc".into())),
            Some("abcd"),
            VerifyError::NonceMismatch,
        ),
        (
            "uppercase hex sub",
            token(&with(
                apple_claims(),
                "sub",
                "000000.0123456789ABCDEF0123456789abcdef.0000".into(),
            )),
            None,
            VerifyError::BadSubject,
        ),
        (
            "no sub",
            token(&with(apple_claims(), "sub", Value::Null)),
            None,
            VerifyError::BadSubject,
        ),
        (
            "not a JWT",
            "not-a-jwt".into(),
            None,
            VerifyError::MalformedToken,
        ),
        ("empty", String::new(), None, VerifyError::MalformedToken),
    ];
    for (name, t, nonce, want) in cases {
        assert_eq!(verify_apple(&jwks, &t, nonce).await, Err(want), "{name}");
    }
}

#[tokio::test]
async fn apple_fails_closed_without_an_audience() {
    let (s, jwks) = apple().await;
    let r = jwks
        .verify(&token(&apple_claims()), &[], None, unix_now())
        .await;
    assert_eq!(r, Err(VerifyError::NotConfigured));
    assert_eq!(s.hits(), 0);
}

// ── algorithm pinning ──

#[tokio::test]
async fn alg_none_and_hs256_confusion_are_rejected_before_any_key_fetch() {
    let (s, jwks) = apple().await;
    assert_eq!(
        verify_apple(&jwks, &unsigned(&apple_claims()), None).await,
        Err(VerifyError::InvalidSignature)
    );
    // HS256 keyed by the public modulus: the classic RS/HS confusion.
    let modulus = jwk(&test_key(), TEST_KID)["n"]
        .as_str()
        .unwrap()
        .to_string();
    for secret in [modulus.as_bytes(), b"attacker-controlled-secret".as_slice()] {
        let t = sign_hs256(
            secret,
            &json!({ "alg": "HS256", "kid": TEST_KID }),
            &apple_claims(),
        );
        assert_eq!(
            verify_apple(&jwks, &t, None).await,
            Err(VerifyError::InvalidSignature)
        );
    }
    assert_eq!(s.hits(), 0, "alg is pinned before the key lookup");
}

#[tokio::test]
async fn header_without_a_kid_or_alg_is_malformed() {
    let (_s, jwks) = apple().await;
    for h in [json!({ "alg": "RS256" }), json!({ "kid": TEST_KID })] {
        let t = sign(&test_key(), &h, &apple_claims());
        assert_eq!(
            verify_apple(&jwks, &t, None).await,
            Err(VerifyError::MalformedToken)
        );
    }
}

// ── claim rules beyond the TS cases ──

#[tokio::test]
async fn exp_has_60_seconds_of_tolerance_and_is_required() {
    let (_s, jwks) = apple().await;
    let now = unix_now();
    let at = async |exp: i64| {
        let t = token(&with(apple_claims(), "exp", exp.into()));
        jwks.verify(&t, &[APPLE_AUD.to_string()], None, now).await
    };
    assert!(at(now - 59).await.is_ok());
    assert_eq!(at(now - 60).await, Err(VerifyError::Expired));
    let no_exp = token(&with(apple_claims(), "exp", Value::Null));
    assert_eq!(
        verify_apple(&jwks, &no_exp, None).await,
        Err(VerifyError::MalformedToken)
    );
    let string_exp = token(&with(apple_claims(), "exp", "9999999999".into()));
    assert_eq!(
        verify_apple(&jwks, &string_exp, None).await,
        Err(VerifyError::MalformedToken)
    );
}

#[tokio::test]
async fn nbf_beyond_the_tolerance_is_rejected() {
    let (_s, jwks) = apple().await;
    let now = unix_now();
    let t = |nbf: i64| token(&with(apple_claims(), "nbf", nbf.into()));
    assert!(verify_apple(&jwks, &t(now + 60), None).await.is_ok());
    assert_eq!(
        verify_apple(&jwks, &t(now + 120), None).await,
        Err(VerifyError::MalformedToken)
    );
}

#[tokio::test]
async fn missing_iss_or_aud_and_audience_arrays() {
    let (_s, jwks) = apple().await;
    let no_iss = token(&with(apple_claims(), "iss", Value::Null));
    assert_eq!(
        verify_apple(&jwks, &no_iss, None).await,
        Err(VerifyError::WrongIss)
    );
    let no_aud = token(&with(apple_claims(), "aud", Value::Null));
    assert_eq!(
        verify_apple(&jwks, &no_aud, None).await,
        Err(VerifyError::WrongAud)
    );
    let listed = token(&with(apple_claims(), "aud", json!(["other", APPLE_AUD])));
    assert!(verify_apple(&jwks, &listed, None).await.is_ok());
    let unlisted = token(&with(apple_claims(), "aud", json!(["other"])));
    assert_eq!(
        verify_apple(&jwks, &unlisted, None).await,
        Err(VerifyError::WrongAud)
    );
}

// ── googleAuth.test.ts ──

#[tokio::test]
async fn google_verifies_a_well_formed_token_and_returns_the_google_sub() {
    let (_s, jwks) = google().await;
    let t = token(&with(
        with(google_claims(), "email", "gary@example.com".into()),
        "name",
        "Gary G".into(),
    ));
    let id = verify_google(&jwks, &t, None).await.unwrap();
    assert_eq!(id.sub, format!("google:{GOOGLE_SUBJECT}"));
    assert_eq!(id.email.as_deref(), Some("gary@example.com"));
    assert_eq!(id.name.as_deref(), Some("Gary G"));
}

#[tokio::test]
async fn google_accepts_both_issuer_forms_a_nonce_and_any_listed_audience() {
    let (_s, jwks) = google().await;
    let bare = token(&with(google_claims(), "iss", "accounts.google.com".into()));
    assert!(verify_google(&jwks, &bare, None).await.is_ok());
    let t = token(&with(google_claims(), "nonce", "n1".into()));
    assert!(verify_google(&jwks, &t, Some("n1")).await.is_ok());
    let r = jwks
        .verify(
            &token(&google_claims()),
            &["web.example".to_string(), GOOGLE_AUD.to_string()],
            None,
            unix_now(),
        )
        .await;
    assert!(r.is_ok());
}

#[tokio::test]
async fn google_rejections() {
    let (_s, jwks) = google().await;
    let now = unix_now();
    let cases: Vec<(&str, String, Option<&str>, VerifyError)> = vec![
        (
            "expired",
            token(&with(google_claims(), "exp", (now - 600).into())),
            None,
            VerifyError::Expired,
        ),
        (
            "another audience",
            token(&with(google_claims(), "aud", "com.someone.else".into())),
            None,
            VerifyError::WrongAud,
        ),
        (
            "wrong issuer",
            token(&with(
                google_claims(),
                "iss",
                "https://evil.example.com".into(),
            )),
            None,
            VerifyError::WrongIss,
        ),
        (
            "Apple's issuer",
            token(&with(
                google_claims(),
                "iss",
                "https://appleid.apple.com".into(),
            )),
            None,
            VerifyError::WrongIss,
        ),
        (
            "another key",
            sign(&other_key(), &header(TEST_KID), &google_claims()),
            None,
            VerifyError::InvalidSignature,
        ),
        (
            "kid not in the set",
            sign(&test_key(), &header("unknown-kid"), &google_claims()),
            None,
            VerifyError::UnknownKey,
        ),
        (
            "expected nonce absent",
            token(&google_claims()),
            Some("x"),
            VerifyError::NonceMismatch,
        ),
        (
            "nonce differs",
            token(&with(google_claims(), "nonce", "real".into())),
            Some("fake"),
            VerifyError::NonceMismatch,
        ),
        (
            "not a JWT",
            "not-a-jwt".into(),
            None,
            VerifyError::MalformedToken,
        ),
        (
            "non-numeric sub",
            token(&with(google_claims(), "sub", "not-numeric!".into())),
            None,
            VerifyError::BadSubject,
        ),
    ];
    for (name, t, nonce, want) in cases {
        assert_eq!(verify_google(&jwks, &t, nonce).await, Err(want), "{name}");
    }
    let r = jwks.verify(&token(&google_claims()), &[], None, now).await;
    assert_eq!(r, Err(VerifyError::NotConfigured));
}

// ── key-set cache: 10 min max age, one refetch per kid miss, 30 s cooldown ──

async fn at(jwks: &Jwks, kid: &str, clock: Instant) -> Result<Identity, VerifyError> {
    let t = sign(&test_key(), &header(kid), &apple_claims());
    jwks.verify_at(&t, &[APPLE_AUD.to_string()], None, unix_now(), clock)
        .await
}

#[tokio::test]
async fn unknown_kid_refetches_once_outside_the_cooldown() {
    let (s, jwks) = apple().await;
    let t0 = Instant::now();
    assert!(at(&jwks, TEST_KID, t0).await.is_ok());
    assert_eq!(s.hits(), 1);
    // A cached kid is served from memory.
    assert!(
        at(&jwks, TEST_KID, t0 + Duration::from_secs(5))
            .await
            .is_ok()
    );
    assert_eq!(s.hits(), 1);
    // A miss inside the cooldown does not fetch.
    let miss = at(&jwks, "rotated", t0 + Duration::from_secs(29)).await;
    assert_eq!(miss, Err(VerifyError::UnknownKey));
    assert_eq!(s.hits(), 1);
    // Outside it: exactly one refetch, then the cooldown applies again.
    let miss = at(&jwks, "rotated", t0 + Duration::from_secs(31)).await;
    assert_eq!(miss, Err(VerifyError::UnknownKey));
    assert_eq!(s.hits(), 2);
    for _ in 0..5 {
        assert_eq!(
            at(&jwks, "rotated", t0 + Duration::from_secs(40)).await,
            Err(VerifyError::UnknownKey)
        );
    }
    assert_eq!(s.hits(), 2);
}

#[tokio::test]
async fn a_rotated_key_is_picked_up_by_the_refetch() {
    let (s, jwks) = apple().await;
    let t0 = Instant::now();
    assert!(at(&jwks, TEST_KID, t0).await.is_ok());
    s.keys.lock().unwrap().push(jwk(&test_key(), "rotated"));
    assert!(
        at(&jwks, "rotated", t0 + Duration::from_secs(31))
            .await
            .is_ok()
    );
    assert_eq!(s.hits(), 2);
}

#[tokio::test]
async fn the_set_is_refetched_after_ten_minutes() {
    let (s, jwks) = apple().await;
    let t0 = Instant::now();
    assert!(at(&jwks, TEST_KID, t0).await.is_ok());
    assert!(
        at(&jwks, TEST_KID, t0 + Duration::from_secs(599))
            .await
            .is_ok()
    );
    assert_eq!(s.hits(), 1);
    assert!(
        at(&jwks, TEST_KID, t0 + Duration::from_secs(600))
            .await
            .is_ok()
    );
    assert_eq!(s.hits(), 2);
    // A failed refresh of a stale set is an outage, not a stale answer.
    s.status.store(500, Ordering::SeqCst);
    assert_eq!(
        at(&jwks, TEST_KID, t0 + Duration::from_secs(1300)).await,
        Err(VerifyError::JwksUnavailable)
    );
}

// ── jwks_unavailable (503) ──

#[tokio::test]
async fn an_unreachable_or_broken_key_set_is_jwks_unavailable() {
    let dead = Jwks::apple_at(&dead_url().await);
    assert_eq!(
        verify_apple(&dead, &token(&apple_claims()), None).await,
        Err(VerifyError::JwksUnavailable)
    );
    assert_eq!(VerifyError::JwksUnavailable.status().as_u16(), 503);
    assert_eq!(VerifyError::UnknownKey.status().as_u16(), 401);

    let (s, jwks) = apple().await;
    s.status.store(500, Ordering::SeqCst);
    assert_eq!(
        verify_apple(&jwks, &token(&apple_claims()), None).await,
        Err(VerifyError::JwksUnavailable)
    );
}

#[tokio::test]
async fn a_slow_key_set_times_out() {
    let (s, mut jwks) = apple().await;
    jwks.timeout = Duration::from_millis(100);
    s.delay_ms.store(2_000, Ordering::SeqCst);
    assert_eq!(
        verify_apple(&jwks, &token(&apple_claims()), None).await,
        Err(VerifyError::JwksUnavailable)
    );
}

#[test]
fn non_signing_keys_are_skipped() {
    let good = jwk(&test_key(), "a");
    let mut enc = jwk(&test_key(), "b");
    enc["use"] = "enc".into();
    let mut ec = jwk(&test_key(), "c");
    ec["kty"] = "EC".into();
    let mut hs = jwk(&test_key(), "d");
    hs["alg"] = "HS256".into();
    let body = json!({ "keys": [good, enc, ec, hs, { "kty": "RSA", "n": "AQAB" }] });
    let keys = parse_jwks(body.to_string().as_bytes()).unwrap();
    assert_eq!(keys.keys().collect::<Vec<_>>(), ["a"]);
    assert!(parse_jwks(b"not json").is_none());
    assert!(parse_jwks(b"{\"keys\":1}").is_none());
}
