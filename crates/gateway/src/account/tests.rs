//! account.test.ts and the memberErasure step failures. The cookie path and
//! every erasure step's effect are goldens (proxy/goldens.rs); these cover the
//! device-token Bearer, the last-admin rules and the failure log.

use axum::body::Body;
use axum::http::Request;
use serde_json::json;

use super::*;
use crate::proxy::fake::{Fake, Route};
use crate::testutil::{ADMIN, ALICE, BOB, add_member, capture_logs, logs, send, state_in};

async fn state(dir: &tempfile::TempDir, fake: &Fake, extra: &[(&str, &str)]) -> AppState {
    let urls = [
        ("IPTV_SERVICE_URL", format!("{}/iptv", fake.url)),
        ("MEDIA_CORE_URL", format!("{}/mc", fake.url)),
        ("USE_MEDIA_CORE", "1".into()),
        (
            "USER_POLICIES_PATH",
            dir.path()
                .join("policies.json")
                .to_str()
                .unwrap()
                .to_string(),
        ),
        (
            "USER_FEEDBACK_PATH",
            dir.path()
                .join("feedback.json")
                .to_str()
                .unwrap()
                .to_string(),
        ),
        (
            "USER_WATCHLIST_PATH",
            dir.path()
                .join("watchlist.json")
                .to_str()
                .unwrap()
                .to_string(),
        ),
    ];
    let mut env: Vec<(&str, &str)> = urls.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.extend_from_slice(extra);
    state_in(dir, &env).await
}

async fn pair(st: &AppState, sub: &str, device_id: &str) -> String {
    let keys = st.auth.device_keys.as_deref().unwrap();
    let server_id = auth::ensure_server_id(&st.auth.pool).await.unwrap();
    auth::device_tokens::mint(
        &st.auth.pool,
        keys,
        &auth::device_tokens::MintInput {
            sub,
            role: auth::Role::User,
            auth_mode: auth::AuthMode::parse(sub.split(':').next().unwrap()).unwrap(),
            device_id,
            device_platform: "tvos",
            device_name: "Apple TV",
            username: Some("u"),
            server_id: &server_id,
        },
    )
    .await
    .unwrap()
}

fn delete_self(token: Option<&str>) -> Request<Body> {
    let mut b = Request::delete("/api/account/self").header("origin", "https://app.example");
    if let Some(t) = token {
        b = b.header("authorization", format!("Bearer {t}"));
    }
    b.body(Body::empty()).unwrap()
}

async fn revoked_at(st: &AppState, sub: &str) -> Option<String> {
    sqlx::query_scalar("SELECT revoked_at FROM members WHERE sub = ?")
        .bind(sub)
        .fetch_one(&st.auth.pool)
        .await
        .unwrap()
}

const ORIGINS: (&str, &str) = ("ALLOWED_ORIGINS", "https://app.example");

#[tokio::test]
async fn a_device_token_deletes_its_own_account_and_dies_in_the_cascade() {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    fake.set_routes(vec![
        Route::json(
            "DELETE",
            &format!(
                "/iptv/internal/members/{}",
                crate::proxy::encode_uri_component(ALICE)
            ),
            200,
            json!({}),
        ),
        Route::json("DELETE", "/mc/api/media/watch", 200, json!({})),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS]).await;
    add_member(&st, ALICE, "alice", "user").await;
    let token = pair(&st, ALICE, "01HABCDEFGHJKMNPQRSTVWXYZ0").await;
    let other = pair(&st, ALICE, "01HSECONDDEVICESECONDDEV00").await;
    let app = crate::router(st.clone());

    assert_eq!(send(&app, delete_self(None)).await.status, 401);
    assert_eq!(revoked_at(&st, ALICE).await, None);

    let r = send(&app, delete_self(Some(&token))).await;
    assert_eq!((r.status.as_u16(), r.body.as_str()), (204, ""));
    assert!(revoked_at(&st, ALICE).await.is_some());
    assert_eq!(
        send(&app, delete_self(Some(&token))).await.status,
        401,
        "the caller's token died"
    );
    let devices = Request::get("/api/devices/self")
        .header("authorization", format!("Bearer {other}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        send(&app, devices).await.status,
        401,
        "every device token died"
    );
    let calls = fake.settle().await;
    let seen: Vec<String> = calls
        .iter()
        .map(|c| format!("{} {}", c.method, c.path))
        .collect();
    assert_eq!(
        seen,
        [
            format!(
                "DELETE /iptv/internal/members/{}",
                crate::proxy::encode_uri_component(ALICE)
            ),
            "DELETE /mc/api/media/watch".to_string(),
        ]
    );
    assert_eq!(calls[0].principal["role"], "admin");
    assert_eq!(calls[1].principal["sub"], ALICE);
}

#[tokio::test]
async fn the_last_admin_is_refused_and_left_intact() {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS]).await;
    add_member(&st, ADMIN, "admin", "admin").await;
    let token = pair(&st, ADMIN, "01HADMINDEVICEADMINDEVICE0").await;
    let app = crate::router(st.clone());
    let r = send(&app, delete_self(Some(&token))).await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_str()),
        (409, r#"{"error":"last_admin"}"#)
    );
    assert_eq!(revoked_at(&st, ADMIN).await, None);
    let devices = Request::get("/api/devices/self")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&app, devices).await.status, 200);
    assert!(fake.settle().await.is_empty(), "no erasure step ran");
}

#[tokio::test]
async fn an_admin_may_go_while_another_admin_remains() {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS]).await;
    add_member(&st, ADMIN, "admin", "admin").await;
    add_member(&st, BOB, "bob", "admin").await;
    let token = pair(&st, ADMIN, "01HADMINDEVICEADMINDEVICE0").await;
    let app = crate::router(st.clone());
    assert_eq!(send(&app, delete_self(Some(&token))).await.status, 204);
    assert!(revoked_at(&st, ADMIN).await.is_some());
}

#[tokio::test]
async fn admin_subs_count_as_admins_and_an_admin_subs_owner_is_refused() {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    let owner = "apple:000000.0123456789abcdef0123456789abcdef.0000";
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS, ("ADMIN_SUBS", owner)]).await;
    add_member(&st, ADMIN, "admin", "admin").await;
    let token = pair(&st, ADMIN, "01HADMINDEVICEADMINDEVICE0").await;
    let app = crate::router(st.clone());
    assert_eq!(
        send(&app, delete_self(Some(&token))).await.status,
        204,
        "the never-signed-in owner remains"
    );

    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS, ("ADMIN_SUBS", ADMIN)]).await;
    add_member(&st, ADMIN, "admin", "admin").await;
    add_member(&st, BOB, "bob", "admin").await;
    let token = pair(&st, ADMIN, "01HADMINDEVICEADMINDEVICE0").await;
    let app = crate::router(st.clone());
    assert_eq!(
        send(&app, delete_self(Some(&token))).await.status,
        409,
        "the env would re-admit them"
    );
    assert_eq!(revoked_at(&st, ADMIN).await, None);
}

#[tokio::test(flavor = "current_thread")]
async fn failed_steps_are_logged_and_never_surfaced() {
    capture_logs();
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    fake.set_routes(vec![
        Route::json(
            "DELETE",
            &format!(
                "/iptv/internal/members/{}",
                crate::proxy::encode_uri_component(ALICE)
            ),
            503,
            json!({}),
        ),
        Route::json("DELETE", "/mc/api/media/watch", 404, json!({})),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let st = state(&dir, &fake, &[ORIGINS]).await;
    add_member(&st, ALICE, "alice", "user").await;
    // A store file that is not JSON fails its step.
    std::fs::write(dir.path().join("policies.json"), "not json").unwrap();
    let failures = erase(&st, ALICE).await;
    let steps: Vec<&str> = failures.iter().map(|(s, _)| *s).collect();
    assert_eq!(steps, ["iptv", "policy", "media_watch_state"]);
    assert_eq!(failures[0].1, "iptv internal DELETE answered 503");
    assert_eq!(
        failures[2].1,
        "media-core DELETE /api/media/watch answered 404"
    );

    let token = pair(&st, ALICE, "01HABCDEFGHJKMNPQRSTVWXYZ0").await;
    let app = crate::router(st.clone());
    let r = send(&app, delete_self(Some(&token))).await;
    assert_eq!(r.status, 204);
    let out = logs();
    for step in ["iptv", "policy", "media_watch_state"] {
        assert!(
            out.contains("account erasure step failed")
                && out.contains(&format!("step=\"{step}\"")),
            "{step}: {out}"
        );
    }
    assert!(out.contains("account deleted"), "{out}");
}

#[tokio::test]
async fn iptv_disabled_and_no_media_core_skip_their_steps() {
    let fake = Fake::start("gateway-test-internal-secret-0123456789ab").await;
    let dir = tempfile::tempdir().unwrap();
    let st = state(
        &dir,
        &fake,
        &[("IPTV_DISABLED", "1"), ("USE_MEDIA_CORE", "0")],
    )
    .await;
    add_member(&st, ALICE, "alice", "user").await;
    assert!(erase(&st, ALICE).await.is_empty());
    assert!(fake.settle().await.is_empty());
}
