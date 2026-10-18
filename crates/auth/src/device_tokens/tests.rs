//! Carried over from session.deviceToken.test.ts, tokenSweepScheduler.test.ts
//! and reconcileDeviceToken.test.ts (cascadeRevokeForSub).

use super::*;
use crate::testutil::pool;

const SECRET: &str = "test-device-token-secret-at-least-32-bytes-long";
const SUB: &str = "apple:000001.0123456789abcdef0123456789abcdef.0001";

fn input() -> MintInput<'static> {
    MintInput {
        sub: SUB,
        role: Role::User,
        auth_mode: AuthMode::Apple,
        device_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        device_platform: "tvos",
        device_name: "Test Apple TV",
        username: Some("Chris"),
        server_id: "server-test-0001",
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn minted(pool: &SqlitePool) -> (Keys, String, DeviceClaims) {
    let keys = Keys::from_secret(SECRET);
    let token = mint(pool, &keys, &input()).await.unwrap();
    let claims = verify(pool, &keys, &token, now()).await.unwrap().unwrap();
    (keys, token, claims)
}

#[tokio::test]
async fn a_freshly_minted_token_verifies_and_its_row_is_written() {
    let db = pool().await;
    let (_, _, c) = minted(&db).await;
    assert_eq!(
        (c.sub.as_str(), c.role.as_str(), c.auth_mode.as_str()),
        (SUB, "user", "apple")
    );
    assert_eq!((c.aud.as_str(), c.iss.as_str()), ("device", "eex"));
    assert_eq!(c.exp - c.iat, DEFAULT_TTL_SECS);
    let row: (String, String, Option<String>, String, String, String, String) = sqlx::query_as(
        "SELECT sub, device_name, username, platform, kid, issued_at, expires_at FROM device_tokens WHERE jti = ?",
    )
    .bind(&c.jti)
    .fetch_one(&*db)
    .await
    .unwrap();
    assert_eq!(row.0, SUB);
    assert_eq!(row.1, "Test Apple TV");
    assert_eq!(row.2.as_deref(), Some("Chris"));
    assert_eq!((row.3.as_str(), row.4.as_str()), ("tvos", "device-v1"));
    assert_eq!(row.5, iso_secs(c.iat));
    assert_eq!(row.6, iso_secs(c.exp));
    assert!(row.6.ends_with(".000Z"));
}

#[tokio::test]
async fn exp_is_enforced() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    assert!(
        verify(&db, &keys, &token, c.exp + 60)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn nbf_is_enforced_with_30_s_skew() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    assert!(
        verify(&db, &keys, &token, c.nbf - 60)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        verify(&db, &keys, &token, c.nbf - 10)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn the_exp_guard_is_independent_of_the_db_row() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    sqlx::query("UPDATE device_tokens SET expires_at = '2099-01-01T00:00:00.000Z' WHERE jti = ?")
        .bind(&c.jti)
        .execute(&*db)
        .await
        .unwrap();
    assert!(
        verify(&db, &keys, &token, c.exp + 60)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_still_valid_token_is_accepted_near_exp_and_within_the_5_s_skew() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    // The row expires with the token, so push it out to isolate the skew.
    sqlx::query("UPDATE device_tokens SET expires_at = '2099-01-01T00:00:00.000Z' WHERE jti = ?")
        .bind(&c.jti)
        .execute(&*db)
        .await
        .unwrap();
    assert!(
        verify(&db, &keys, &token, c.exp - 60)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        verify(&db, &keys, &token, c.exp + 5)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        verify(&db, &keys, &token, c.exp + 6)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_expired_row_fails_even_while_the_token_is_in_window() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    sqlx::query("UPDATE device_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE jti = ?")
        .bind(&c.jti)
        .execute(&*db)
        .await
        .unwrap();
    assert!(verify(&db, &keys, &token, now()).await.unwrap().is_none());
}

#[tokio::test]
async fn a_missing_row_or_a_revoked_jti_fails() {
    let db = pool().await;
    let (keys, token, c) = minted(&db).await;
    revoke(&db, &c.jti, "user_revoked").await.unwrap();
    revoke(&db, &c.jti, "again").await.unwrap(); // idempotent
    assert!(verify(&db, &keys, &token, now()).await.unwrap().is_none());

    let token2 = mint(&db, &keys, &input()).await.unwrap();
    sqlx::query("DELETE FROM device_tokens")
        .execute(&*db)
        .await
        .unwrap();
    assert!(verify(&db, &keys, &token2, now()).await.unwrap().is_none());
}

#[tokio::test]
async fn another_secret_garbage_or_an_unknown_kid_fails() {
    let db = pool().await;
    let (_, token, c) = minted(&db).await;
    let other = Keys::from_secret("another-device-token-secret-of-32-bytes-plus");
    assert!(verify(&db, &other, &token, now()).await.unwrap().is_none());
    assert!(
        verify(&db, &other, "not.a.jwe", now())
            .await
            .unwrap()
            .is_none()
    );
    let v2 = device_token::encrypt(
        &derive_key(SECRET.as_bytes(), INFO_DEVICE_TOKEN),
        "device-v2",
        &c,
    );
    assert!(
        verify(&db, &Keys::from_secret(SECRET), &v2, now())
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_bad_role_or_an_unknown_auth_mode_fails() {
    let db = pool().await;
    let (keys, _, c) = minted(&db).await;
    let key = keys.keys[DEFAULT_KID];
    for (role, mode) in [("owner", "apple"), ("user", "guest"), ("user", "")] {
        let forged = DeviceClaims {
            role: role.into(),
            auth_mode: mode.into(),
            ..c.clone()
        };
        let t = device_token::encrypt(&key, DEFAULT_KID, &forged);
        assert!(
            verify(&db, &keys, &t, now()).await.unwrap().is_none(),
            "{role}/{mode}"
        );
    }
}

#[tokio::test]
async fn mint_refuses_a_malformed_sub() {
    let db = pool().await;
    let bad = MintInput {
        sub: "12345",
        ..input()
    };
    assert!(matches!(
        mint(&db, &Keys::from_secret(SECRET), &bad).await,
        Err(Error::InvalidSub)
    ));
}

async fn seed(pool: &SqlitePool, jti: &str, sub: &str, expires_at: &str) {
    sqlx::query(
        "INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) \
         VALUES (?, ?, ?, 'dev', 'ios', 'srv', '2026-01-01T00:00:00.000Z', ?)",
    )
    .bind(jti)
    .bind(sub)
    .bind(format!("device-{jti}"))
    .bind(expires_at)
    .execute(pool)
    .await
    .unwrap();
}

async fn jtis(pool: &SqlitePool, table: &str) -> Vec<String> {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT jti FROM {table} ORDER BY jti"
    )))
    .fetch_all(pool)
    .await
    .unwrap()
}

const NOW: &str = "2026-06-17T12:00:00.000Z";
const PAST: &str = "2026-06-17T11:00:00.000Z";
const FUTURE: &str = "2026-06-17T13:00:00.000Z";

#[tokio::test]
async fn sweep_deletes_only_rows_whose_expires_at_is_before_now() {
    let db = pool().await;
    seed(&db, "dead", "plex:1", PAST).await;
    seed(&db, "live", "plex:1", FUTURE).await;
    assert_eq!(sweep_expired(&db, NOW).await.unwrap(), 1);
    assert_eq!(jtis(&db, "device_tokens").await, ["live"]);
}

#[tokio::test]
async fn sweep_is_a_no_op_when_nothing_is_expired() {
    let db = pool().await;
    seed(&db, "live", "plex:1", FUTURE).await;
    assert_eq!(sweep_expired(&db, NOW).await.unwrap(), 0);
}

#[tokio::test]
async fn cascade_revokes_exactly_the_subs_tokens_idempotently() {
    let db = pool().await;
    for j in ["x1", "x2", "x3"] {
        seed(&db, j, "plex:1", FUTURE).await;
    }
    seed(&db, "y1", "plex:2", FUTURE).await;

    assert_eq!(
        cascade_revoke_for_sub(&db, "plex:1", "member_revoked")
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        jtis(&db, "device_token_revocations").await,
        ["x1", "x2", "x3"]
    );
    let reasons: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT reason FROM device_token_revocations")
            .fetch_all(&*db)
            .await
            .unwrap();
    assert_eq!(reasons, ["member_revoked"]);

    // Re-running still reports 3 and neither duplicates nor overwrites the reason.
    assert_eq!(
        cascade_revoke_for_sub(&db, "plex:1", "not_member")
            .await
            .unwrap(),
        3
    );
    assert_eq!(jtis(&db, "device_token_revocations").await.len(), 3);
    assert_eq!(
        cascade_revoke_for_sub(&db, "plex:404", "not_member")
            .await
            .unwrap(),
        0
    );
    assert_eq!(jtis(&db, "device_token_revocations").await.len(), 3);
}

#[test]
fn the_sweep_cron_takes_node_cron_syntax_and_falls_back_to_0315() {
    assert!(parse_cron("15 3 * * *").is_some());
    assert!(
        parse_cron("*/5 * * * * *").is_some(),
        "six fields: leading seconds"
    );
    assert!(parse_cron("not a cron").is_none());
    let fallback = sweep_cron("not a cron");
    let now = chrono::Local::now();
    let next = fallback.find_next_occurrence(&now, false).unwrap();
    let default = parse_cron(DEFAULT_TOKEN_SWEEP_CRON).unwrap();
    assert_eq!(next, default.find_next_occurrence(&now, false).unwrap());
    assert_eq!(next.format("%H:%M:%S").to_string(), "03:15:00");
}

#[tokio::test]
async fn spawn_sweep_deletes_expired_rows_on_its_schedule() {
    let db = crate::testutil::pool().await;
    for (jti, expires) in [
        ("dead", "2020-01-01T00:00:00.000Z"),
        ("live", "2099-01-01T00:00:00.000Z"),
    ] {
        sqlx::query(
            "INSERT INTO device_tokens (jti, sub, device_id, device_name, platform, server_id, issued_at, expires_at) \
             VALUES (?, 'google:1', ?, 'dev', 'ios', 'srv', '2019-01-01T00:00:00.000Z', ?)",
        )
        .bind(jti)
        .bind(format!("device-{jti}"))
        .bind(expires)
        .execute(&*db)
        .await
        .unwrap();
    }
    let handle = spawn_sweep((*db).clone(), "* * * * * *");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let left: Vec<String> = sqlx::query_scalar("SELECT jti FROM device_tokens ORDER BY jti")
            .fetch_all(&*db)
            .await
            .unwrap();
        if left == ["live"] {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "sweep never ran: {left:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    handle.abort();
}
