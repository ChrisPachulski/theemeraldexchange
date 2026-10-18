//! deviceLink.test.ts carried over (start -> claim with a WorkOS cookie ->
//! poll mints a device token for that member; wrong device_id; double claim;
//! consumed codes), plus expiry, the sweep, verify_url, a Bearer claim and
//! the body guards.

use super::*;
use crate::testutil::*;

const WORKOS: &str = "workos:user_01M12813GMJQQ4DXDWTBRC75G1";
const APPLE: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";
const PLEX: &str = "plex:12345";
const DEVICE: &str =
    r#"{"device_id":"ulid-tv-1","device_name":"Living room","device_platform":"tvos"}"#;

async fn post(
    app: &Router,
    path: &str,
    body: &str,
    extra: &[(&str, &str)],
) -> crate::testutil::Reply {
    let mut headers = vec![("content-type", "application/json")];
    headers.extend_from_slice(extra);
    call(
        app,
        "POST",
        &format!("/api/auth/device/link{path}"),
        &headers,
        Some(body),
    )
    .await
}

async fn started(app: &Router) -> String {
    let r = post(app, "/start", DEVICE, &[]).await;
    assert_eq!(r.status, 200, "{}", r.text);
    r.json()["code"].as_str().unwrap().to_string()
}

fn poll_body(code: &str, device_id: &str) -> String {
    json!({ "code": code, "device_id": device_id }).to_string()
}

async fn insert_code(st: &AuthState, code: &str, expires_at: i64) {
    sqlx::query(
        "INSERT INTO device_link_codes (code, device_id, device_name, device_platform, created_at, expires_at) \
         VALUES (?, 'ulid-tv-1', 'Living room', 'tvos', ?, ?)",
    )
    .bind(code)
    .bind(expires_at - LINK_CODE_TTL_SECS)
    .bind(expires_at)
    .execute(&st.pool)
    .await
    .unwrap();
}

#[test]
fn codes_are_8_chars_from_the_unambiguous_alphabet() {
    for _ in 0..50 {
        let c = generate_code();
        assert!(code_shape(&c), "{c}");
        assert!(!c.contains(['0', 'O', '1', 'I']), "{c}");
    }
}

#[test]
fn codes_normalize_case_spaces_and_dashes() {
    assert_eq!(normalize_code(Some(&json!(" abcd-efgh "))), "ABCDEFGH");
    assert_eq!(normalize_code(Some(&json!("ab cd\u{a0}ef gh"))), "ABCDEFGH");
    assert_eq!(normalize_code(Some(&json!(42))), "");
    assert!(!code_shape("ABCDEFG1") && !code_shape("ABCDEFG") && !code_shape("ABCDEFGHJ"));
}

#[tokio::test]
async fn start_claim_poll_mints_a_device_token_for_the_claiming_member() {
    let (_db, st) = state().await;
    add_member(&st.pool, WORKOS, "user", "workos").await;
    let app = crate::router(st.clone());

    let r = post(&app, "/start", DEVICE, &[]).await;
    assert_eq!(r.status, 200);
    let code = r.json()["code"].as_str().unwrap().to_string();
    assert_eq!(
        r.text,
        format!(
            r#"{{"code":"{code}","verify_url":"/#/link/{code}","expires_in":600,"interval":2}}"#
        ),
        "no Host, no SPA origin: a relative verify_url"
    );

    let pending = post(&app, "/poll", &poll_body(&code, "ulid-tv-1"), &[]).await;
    assert_eq!(pending.text, r#"{"status":"pending"}"#);

    let cookie = cookie(&st, WORKOS, "ana", Role::User);
    let claim = post(
        &app,
        "/claim",
        &json!({ "code": code.to_lowercase() }).to_string(),
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(claim.status, 200);
    assert_eq!(
        claim.text,
        r#"{"ok":true,"device_name":"Living room","device_platform":"tvos"}"#
    );

    let done = post(&app, "/poll", &poll_body(&code, "ulid-tv-1"), &[]).await;
    let body = done.json();
    assert_eq!(body["status"], "authorized");
    assert_eq!(
        body["user"],
        json!({ "sub": WORKOS, "username": "ana", "role": "user" })
    );
    let server_id = crate::ensure_server_id(&st.pool).await.unwrap();
    assert_eq!(body["server_id"], server_id.as_str());
    let token = body["token"].as_str().unwrap();
    let claims = device_tokens::verify(
        &st.pool,
        st.device_keys.as_deref().unwrap(),
        token,
        unix_now(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(claims.sub, WORKOS);
    assert_eq!(claims.auth_mode, "workos");
    assert_eq!(claims.device_id, "ulid-tv-1");
    assert_eq!(claims.device_platform, "tvos");
    let (name, username): (String, Option<String>) =
        sqlx::query_as("SELECT device_name, username FROM device_tokens WHERE jti = ?")
            .bind(&claims.jti)
            .fetch_one(&st.pool)
            .await
            .unwrap();
    assert_eq!(
        (name.as_str(), username.as_deref()),
        ("Living room", Some("ana"))
    );

    // One-shot: a replayed poll is denied, and so is a second claim.
    let replay = post(&app, "/poll", &poll_body(&code, "ulid-tv-1"), &[]).await;
    assert_eq!(
        replay.text,
        r#"{"status":"denied","reason":"unknown_code"}"#
    );
    let again = post(
        &app,
        "/claim",
        &json!({ "code": code }).to_string(),
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(again.status, 409);
    assert_eq!(again.text, r#"{"error":"already_claimed"}"#);
    let tokens: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM device_tokens")
        .fetch_one(&st.pool)
        .await
        .unwrap();
    assert_eq!(tokens, 1);
}

#[tokio::test]
async fn poll_with_another_device_id_looks_like_an_unknown_code() {
    let (_db, st) = state().await;
    let app = crate::router(st);
    let code = started(&app).await;
    let r = post(&app, "/poll", &poll_body(&code, "someone-else"), &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.text, r#"{"status":"denied","reason":"unknown_code"}"#);
    let unknown = post(&app, "/poll", &poll_body("ABCDEFGH", "ulid-tv-1"), &[]).await;
    assert_eq!(unknown.text, r.text);
}

#[tokio::test]
async fn claim_requires_a_session_and_a_real_code() {
    let (_db, st) = state().await;
    add_member(&st.pool, APPLE, "user", "apple").await;
    let app = crate::router(st.clone());
    let none = post(&app, "/claim", r#"{"code":"ABCDEFGH"}"#, &[]).await;
    assert_eq!(none.status, 401);
    let cookie = cookie(&st, APPLE, "p", Role::User);
    let unknown = post(
        &app,
        "/claim",
        r#"{"code":"ABCDEFGH"}"#,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(
        (unknown.status, unknown.text.as_str()),
        (404, r#"{"error":"unknown_code"}"#)
    );
    let bad = post(&app, "/claim", r#"{"code":"nope"}"#, &[("cookie", &cookie)]).await;
    assert_eq!(
        (bad.status, bad.text.as_str()),
        (400, r#"{"error":"invalid_code"}"#)
    );
}

#[tokio::test]
async fn an_expired_code_is_gone_for_claim_and_denied_for_poll() {
    let (_db, st) = state().await;
    add_member(&st.pool, APPLE, "user", "apple").await;
    insert_code(&st, "EXPD2345", st.now() - 1).await;
    let app = crate::router(st.clone());
    let cookie = cookie(&st, APPLE, "p", Role::User);
    let claim = post(
        &app,
        "/claim",
        r#"{"code":"EXPD2345"}"#,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(
        (claim.status, claim.text.as_str()),
        (410, r#"{"error":"expired"}"#)
    );
    let poll = post(&app, "/poll", &poll_body("EXPD2345", "ulid-tv-1"), &[]).await;
    assert_eq!(poll.text, r#"{"status":"denied","reason":"expired"}"#);
}

#[tokio::test]
async fn a_bearer_claim_binds_the_device_name_and_its_provider() {
    let (_db, st) = state().await;
    add_member(&st.pool, APPLE, "user", "apple").await;
    let bearer = device_token(&st, APPLE, "01HABCDEFGHJKMNPQRSTVWXYZ0", "Kitchen iPad").await;
    let app = crate::router(st.clone());
    let code = started(&app).await;
    let auth = format!("Bearer {bearer}");
    let claim = post(
        &app,
        "/claim",
        &json!({ "code": code }).to_string(),
        &[("authorization", &auth)],
    )
    .await;
    assert_eq!(claim.status, 200);
    let row: (String, String, String, String) = sqlx::query_as(
        "SELECT claimed_sub, claimed_username, claimed_role, claimed_auth_mode FROM device_link_codes WHERE code = ?",
    )
    .bind(&code)
    .fetch_one(&st.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            APPLE.into(),
            "Kitchen iPad".into(),
            "user".into(),
            "apple".into()
        )
    );
}

#[tokio::test]
async fn a_plex_members_claim_mints_a_plex_device_token_that_authenticates() {
    let (_db, st) = state().await;
    add_member(&st.pool, PLEX, "user", "plex").await;
    let app = crate::router(st.clone());
    let code = started(&app).await;
    let cookie = cookie(&st, PLEX, "plexuser", Role::User);
    let claim = post(
        &app,
        "/claim",
        &json!({ "code": code }).to_string(),
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(claim.status, 200, "{}", claim.text);
    let done = post(&app, "/poll", &poll_body(&code, "ulid-tv-1"), &[]).await;
    let body = done.json();
    assert_eq!(body["status"], "authorized", "{}", done.text);
    let token = body["token"].as_str().unwrap();
    let claims = device_tokens::verify(
        &st.pool,
        st.device_keys.as_deref().unwrap(),
        token,
        unix_now(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        (claims.sub.as_str(), claims.auth_mode.as_str()),
        (PLEX, "plex")
    );
    let me = call(
        &app,
        "GET",
        "/api/me",
        &[("authorization", &format!("Bearer {token}"))],
        None,
    )
    .await;
    assert_eq!(me.status, 200, "{}", me.text);
    assert_eq!(me.json()["user"]["auth_mode"], "plex");
}

#[tokio::test]
async fn start_sweeps_codes_expired_more_than_a_ttl_ago() {
    let (_db, st) = state().await;
    let now = st.now();
    insert_code(&st, "OLDD2345", now - LINK_CODE_TTL_SECS - 1).await;
    insert_code(&st, "RCNT2345", now - LINK_CODE_TTL_SECS + 5).await;
    started(&crate::router(st.clone())).await;
    let left: Vec<String> = sqlx::query_scalar(
        "SELECT code FROM device_link_codes WHERE code IN ('OLDD2345', 'RCNT2345')",
    )
    .fetch_all(&st.pool)
    .await
    .unwrap();
    assert_eq!(left, ["RCNT2345"]);
}

#[tokio::test]
async fn verify_url_uses_the_spa_origin() {
    let host = [("host", "eex.local:8080")];
    let (_db, st) = state().await;
    let r = post(&crate::router(st), "/start", DEVICE, &host).await;
    let code = r.json()["code"].as_str().unwrap().to_string();
    assert_eq!(
        r.json()["verify_url"],
        format!("http://eex.local:8080/#/link/{code}")
    );

    let db = pool().await;
    let st = AuthState::new(
        (*db).clone(),
        config(&[("ALLOWED_ORIGINS", "https://app.example,https://b.example")]),
    );
    let r = post(&crate::router(st), "/start", DEVICE, &host).await;
    let code = r.json()["code"].as_str().unwrap().to_string();
    assert_eq!(
        r.json()["verify_url"],
        format!("https://app.example/#/link/{code}")
    );

    let db = pool().await;
    let st = AuthState::new(
        (*db).clone(),
        config(&[
            ("SERVE_SPA", "1"),
            ("ALLOWED_ORIGINS", "https://app.example"),
        ]),
    );
    let r = post(&crate::router(st), "/start", DEVICE, &host).await;
    let code = r.json()["code"].as_str().unwrap().to_string();
    assert_eq!(
        r.json()["verify_url"],
        format!("http://eex.local:8080/#/link/{code}")
    );
}

#[tokio::test]
async fn start_and_poll_reject_bad_bodies() {
    capture_logs();
    let (_db, st) = state().await;
    let app = crate::router(st);
    for body in [
        "{}",
        "not json",
        r#"{"device_id":" ","device_name":"x","device_platform":"tvos"}"#,
        r#"{"device_id":1,"device_name":"x","device_platform":"tvos"}"#,
    ] {
        let r = post(&app, "/start", body, &[]).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (400, r#"{"error":"missing_device_fields"}"#),
            "{body}"
        );
    }
    let big = format!(r#"{{"device_id":"{}"}}"#, "a".repeat(2048));
    assert_eq!(post(&app, "/start", &big, &[]).await.status, 413);
    assert_eq!(post(&app, "/poll", &big, &[]).await.status, 413);
    for body in [
        r#"{"code":"ABCDEFGH"}"#,
        r#"{"code":"ABC","device_id":"d"}"#,
        "null",
    ] {
        let r = post(&app, "/poll", body, &[]).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (400, r#"{"error":"invalid_request"}"#),
            "{body}"
        );
    }
    let logs = logs();
    assert!(logs.contains("outcome=\"invalid\""), "{logs}");
    assert!(logs.contains("provider=\"link\""), "{logs}");
}
