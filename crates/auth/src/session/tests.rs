//! Carried over from session.test.ts; the cross-language cases replay
//! tests/fixtures/auth-goldens.json (see gen-auth-goldens.ts).

use super::*;
use crate::testutil::{config, goldens};
use serde_json::json;

fn key() -> SessionKey {
    SessionKey::from_secret(goldens()["session_secret"].as_str().unwrap())
}

fn sample(sub: &str, auth_mode: AuthMode, role: Role) -> Session {
    Session {
        sub: sub.into(),
        username: "someone".into(),
        role,
        auth_mode,
    }
}

const APPLE: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const WORKOS: &str = "workos:user_01E4ZCR3C56J083X43JQXF3JK5";
const NOW: i64 = 1_790_000_000;

/// TS accepts these and Rust deliberately does not: Plex is dropped
/// (decisions.md), and Rust requires the exp every minted cookie carries.
const REJECTED_ON_PURPOSE: &[&str] = &["ts plex session", "no exp"];

#[test]
fn cookies_minted_by_ts_verify_in_rust() {
    let g = goldens();
    let at = g["minted_at"].as_i64().unwrap();
    let cookies = g["cookies"].as_array().unwrap();
    assert!(cookies.len() > 20);
    for c in cookies {
        let name = c["name"].as_str().unwrap();
        let expected = if REJECTED_ON_PURPOSE.contains(&name) {
            assert!(!c["ts"].is_null(), "{name}: TS accepted it");
            json!(null)
        } else {
            c["ts"].clone()
        };
        let got = verify(&key(), c["token"].as_str().unwrap(), at);
        assert_eq!(json!(got), expected, "{name}");
    }
}

#[test]
fn cookies_minted_by_rust_verify_in_jose() {
    let fresh = mint(&key(), &sample(APPLE, AuthMode::Apple, Role::User), NOW);
    let fresh_claims = jwe::decrypt_with_key(&key().0, &fresh).unwrap();
    let keys_of = |b: &[u8]| -> Vec<String> {
        let m: Map<String, Value> = serde_json::from_slice(b).unwrap();
        m.keys().cloned().collect()
    };
    let rust = goldens()["rust_minted"].as_array().unwrap();
    assert_eq!(rust.len(), 4);
    for r in rust {
        let name = r["name"].as_str().unwrap();
        let token = r["token"].as_str().unwrap();
        // jose's verdict, recorded by the generator.
        assert_eq!(r["ts"], r["session"], "{name}: jose verdict");
        let at = r["minted_at"].as_i64().unwrap();
        assert_eq!(json!(verify(&key(), token, at)), r["session"], "{name}");
        // Today's mint still has the shape jose accepted: same header, same claims.
        assert_eq!(token.split('.').next(), fresh.split('.').next(), "{name}");
        let claims = jwe::decrypt_with_key(&key().0, token).unwrap();
        assert_eq!(keys_of(&claims), keys_of(&fresh_claims), "{name}");
    }
}

#[test]
fn set_cookie_matches_set_session_cookie_in_every_posture() {
    let prod = [
        ("NODE_ENV", "production"),
        ("ALLOWED_ORIGINS", "https://app.example"),
    ];
    let postures = [
        ("dev_split", config(&[])),
        ("prod_split", config(&prod)),
        ("dev_same_origin", config(&[("SERVE_SPA", "1")])),
        (
            "prod_same_origin",
            config(&[("SERVE_SPA", "1"), ("NODE_ENV", "production")]),
        ),
    ];
    for (name, cfg) in postures {
        for (scheme, https) in [("http", false), ("https", true)] {
            assert_eq!(
                set_cookie(&cfg, "<token>", https),
                goldens()["set_cookie"][name][scheme].as_str().unwrap(),
                "{name} {scheme}"
            );
        }
    }
}

#[test]
fn round_trips_every_auth_mode() {
    for s in [
        sample(APPLE, AuthMode::Apple, Role::User),
        sample(WORKOS, AuthMode::Workos, Role::Admin),
        sample("google:1234567890", AuthMode::Google, Role::User),
        sample(
            "local:01ARZ3NDEKTSV4RRFFQ69G5FAV",
            AuthMode::Local,
            Role::User,
        ),
    ] {
        assert_eq!(verify(&key(), &mint(&key(), &s, NOW), NOW), Some(s));
    }
}

#[test]
fn expires_after_thirty_days() {
    let token = mint(&key(), &sample(APPLE, AuthMode::Apple, Role::User), NOW);
    assert!(verify(&key(), &token, NOW + TTL_SECS - 1).is_some());
    assert!(verify(&key(), &token, NOW + TTL_SECS).is_none());
}

#[test]
fn rejects_garbage_a_foreign_kid_and_a_foreign_key() {
    for t in ["not-a-jwt", "", "a.b.c", "a.b.c.d.e"] {
        assert_eq!(verify(&key(), t, NOW), None, "{t:?}");
    }
    // A pre-JWE signed cookie (JWS, HS256). Built here, not in the goldens:
    // a literal JWT trips the secret scanner.
    let b64 = |v: &str| URL_SAFE_NO_PAD.encode(v);
    let jws = format!(
        "{}.{}.{}",
        b64(r#"{"alg":"HS256"}"#),
        b64(
            &json!({ "sub": APPLE, "username": "x", "role": "user", "auth_mode": "apple" })
                .to_string()
        ),
        b64("signature")
    );
    assert_eq!(verify(&key(), &jws, NOW), None);
    let claims = json!({ "sub": APPLE, "username": "x", "role": "user",
                         "auth_mode": "apple", "iat": NOW, "exp": NOW + 60 })
    .to_string();
    assert!(verify(&key(), &jwe::encrypt(&key().0, KID, claims.as_bytes()), NOW).is_some());
    // A rotated-in kid this build does not hold.
    assert!(
        verify(
            &key(),
            &jwe::encrypt(&key().0, "session-v2", claims.as_bytes()),
            NOW
        )
        .is_none()
    );
    // Same key, wrong derivation (the HKDF info is part of the key).
    let other = SessionKey(derive_key(b"other", INFO_SESSION));
    assert!(
        verify(
            &other,
            &mint(&key(), &sample(APPLE, AuthMode::Apple, Role::User), NOW),
            NOW
        )
        .is_none()
    );
}

#[test]
fn reads_the_cookie_like_hono() {
    let read = |v: &str| {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_str(v).unwrap());
        read_cookie(&h).map(String::from)
    };
    assert_eq!(read("eex.session=abc.def"), Some("abc.def".into()));
    assert_eq!(read("a=1; eex.session=tok ; b=2"), Some("tok".into()));
    assert_eq!(read("eex.session=\"tok\""), Some("tok".into()));
    // A malformed first pair does not hide a later well-formed one.
    assert_eq!(
        read("eex.session=bad\\value; eex.session=tok"),
        Some("tok".into())
    );
    assert_eq!(read("eex.sessionx=tok; other=1"), None);
    assert_eq!(read_cookie(&HeaderMap::new()), None);
}

/// Writes tests/fixtures/rust-minted-cookies.json, the Rust half of the
/// rollback check: gen-auth-goldens.ts verifies these with jose and records
/// the verdicts in auth-goldens.json. Run, then rerun the generator:
///   cargo test -p auth -- --ignored write_rust_minted_cookies
#[test]
#[ignore]
fn write_rust_minted_cookies() {
    let now = chrono::Utc::now().timestamp();
    let cases = [
        (
            "rust apple user",
            sample(APPLE, AuthMode::Apple, Role::User),
        ),
        (
            "rust workos admin",
            sample(WORKOS, AuthMode::Workos, Role::Admin),
        ),
        (
            "rust google user",
            sample("google:1234567890", AuthMode::Google, Role::User),
        ),
        (
            "rust local user",
            sample(
                "local:01ARZ3NDEKTSV4RRFFQ69G5FAV",
                AuthMode::Local,
                Role::User,
            ),
        ),
    ];
    let out: Vec<_> = cases
        .iter()
        .map(|(name, s)| {
            json!({ "name": name, "minted_at": now, "session": s, "token": mint(&key(), s, now) })
        })
        .collect();
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/rust-minted-cookies.json"
    );
    std::fs::write(path, serde_json::to_string_pretty(&out).unwrap() + "\n").unwrap();
}
