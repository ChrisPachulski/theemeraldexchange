//! Carried over from recommender.test.ts, recommenderCaller.test.ts,
//! recommenderEvents.test.ts and recommenderEvents.local.test.ts, against a
//! local fake sidecar.

use std::collections::HashMap;

use emerald_contracts::internal_principal::{DEFAULT_KID, InternalClaims, decrypt};
use serde_json::json;

use super::*;
use crate::testutil::*;

struct T {
    _dir: tempfile::TempDir,
    st: AppState,
    app: Router,
    rec: FakeRecommender,
}

async fn setup(local: bool) -> T {
    let rec = FakeRecommender::start().await;
    let dir = tempfile::tempdir().unwrap();
    let mut env = vec![
        ("RECOMMENDER_URL", rec.url.as_str()),
        ("RECOMMENDER_EVENT_SECRET", "rec-secret"),
    ];
    if local {
        env.push(("USE_LOCAL_RECOMMENDER", "1"));
    }
    let st = user_state(&dir, &env).await;
    let app = crate::router(st.clone());
    T {
        _dir: dir,
        st,
        app,
        rec,
    }
}

fn open(st: &AppState, token: &str) -> InternalClaims {
    let secret = st.config.auth.internal_principal_secret.as_deref().unwrap();
    let key = emerald_contracts::hkdf::derive_key(
        secret.as_bytes(),
        emerald_contracts::hkdf::INFO_INTERNAL_PRINCIPAL,
    );
    decrypt(&HashMap::from([(DEFAULT_KID.to_string(), key)]), token).unwrap()
}

async fn caller(st: &AppState, sub: &str, role: &str) -> Caller {
    add_member(st, sub, "u", role).await;
    let principal = auth::Principal {
        session: auth::session::Session {
            sub: sub.into(),
            username: "u".into(),
            role: auth::Role::parse(role).unwrap(),
            auth_mode: auth::AuthMode::parse(sub.split(':').next().unwrap()).unwrap(),
        },
        device: None,
    };
    Caller {
        principal,
        req_id: Some("req-42".into()),
    }
}

// --- the client ----------------------------------------------------------------------

#[tokio::test]
async fn score_posts_the_request_and_returns_the_body() {
    let t = setup(true).await;
    let req = json!({ "sub": ALICE, "kind": "movie", "n": 10, "exclude_recently_shown": true,
                      "library": [{ "tmdb_id": 550, "title": "Fight Club" }], "household_rejections": [9] });
    let out: Value = score_once(&t.st, &req, None).await.unwrap();
    assert_eq!(out, json!({}));
    let calls = t.rec.settle().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(
        (calls[0].method.as_str(), calls[0].path.as_str()),
        ("POST", "/score")
    );
    assert_eq!(calls[0].body, req);
    assert_eq!(calls[0].secret.as_deref(), Some("rec-secret"));
    assert!(calls[0].bearer.is_none(), "no caller, no principal");
}

#[tokio::test]
async fn score_errors_carry_the_status_and_a_bounded_body() {
    let t = setup(true).await;
    t.rec.fail("/score", 503, "boom");
    let e = score_once::<Value>(&t.st, &json!({}), None)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(503));
    assert!(
        e.message.contains("recommender /score 503") && e.message.contains("boom"),
        "{}",
        e.message
    );

    t.rec.fail("/score", 500, &"x".repeat(1000));
    let e = score_once::<Value>(&t.st, &json!({}), None)
        .await
        .unwrap_err();
    assert!(e.message.len() < 300);

    let dead = tempfile::tempdir().unwrap();
    let st = user_state(&dead, &[("RECOMMENDER_URL", "http://127.0.0.1:1")]).await;
    let e = score_once::<Value>(&st, &json!({}), None)
        .await
        .unwrap_err();
    assert_eq!(e.status, None, "never reached: {}", e.message);
}

#[tokio::test]
async fn mirrors_post_their_bodies_and_swallow_failures() {
    let t = setup(true).await;
    let c = caller(&t.st, ALICE, "user").await;
    post_feedback(&t.st, "u-1", Kind::Movie, 7, "like", Some(&c));
    post_rejection(&t.st, Kind::Tv, 42, None);
    post_shown(&t.st, ALICE, Kind::Movie, &[1, 2, 3], None);
    post_shown(&t.st, ALICE, Kind::Tv, &[], None);
    let item = Impression {
        tmdb_id: 1,
        rank: 1,
        score: 0.9,
        provenance: "personalized".into(),
        model_version: "v1".into(),
    };
    post_impressions(&t.st, ALICE, Kind::Movie, std::slice::from_ref(&item), None);
    post_impressions(&t.st, ALICE, Kind::Tv, &[], None);
    let mut calls: Vec<(String, Value)> = t
        .rec
        .settle()
        .await
        .into_iter()
        .map(|c| (c.path, c.body))
        .collect();
    calls.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        calls,
        vec![
            (
                "/events/feedback".into(),
                json!({ "sub": "u-1", "kind": "movie", "tmdb_id": 7, "signal": "like" })
            ),
            (
                "/events/impressions".into(),
                json!({ "sub": ALICE, "kind": "movie", "items": [
                { "tmdb_id": 1, "rank": 1, "score": 0.9, "provenance": "personalized", "model_version": "v1" }] })
            ),
            (
                "/events/rejection".into(),
                json!({ "kind": "tv", "tmdb_id": 42 })
            ),
            (
                "/events/shown".into(),
                json!({ "sub": ALICE, "kind": "movie", "tmdb_ids": [1, 2, 3] })
            ),
        ]
    );

    // A refusing or unreachable sidecar never reaches the caller; it is logged.
    capture_logs();
    t.rec.fail("/events/feedback", 500, "nope");
    mirror(
        &t.st,
        "/events/feedback",
        json!({}),
        "recommender.postFeedback",
        None,
    )
    .await;
    let dead = tempfile::tempdir().unwrap();
    let st = user_state(&dead, &[("RECOMMENDER_URL", "http://127.0.0.1:1")]).await;
    mirror(
        &st,
        "/events/rejection",
        json!({}),
        "recommender.postRejection",
        None,
    )
    .await;
    let logs = logs();
    assert!(
        logs.contains("mirror POST failed") && logs.contains("status=500"),
        "{logs}"
    );
    assert!(logs.contains("status=504"), "{logs}");
}

#[tokio::test]
async fn the_principal_names_the_caller_and_the_server() {
    let t = setup(true).await;
    let c = caller(&t.st, ALICE, "admin").await;
    post_rejection(&t.st, Kind::Movie, 1, Some(&c));
    post_rejection(&t.st, Kind::Movie, 2, Some(&c));
    let calls = t.rec.settle().await;
    let server_id = auth::ensure_server_id(&t.st.auth.pool).await.unwrap();
    for call in &calls {
        let claims = open(&t.st, call.bearer.as_deref().unwrap());
        assert_eq!(
            (
                claims.sub.as_str(),
                claims.role.as_str(),
                claims.auth_mode.as_str(),
                claims.req_id.as_str()
            ),
            (ALICE, "admin", "apple", "req-42")
        );
        assert_eq!(claims.server_id, server_id);
    }
    assert_eq!(t.st.server_id.get(), Some(&server_id), "memoized");
}

#[tokio::test]
async fn a_server_id_failure_degrades_to_no_bearer_and_retries() {
    let t = setup(true).await;
    let c = caller(&t.st, ALICE, "user").await;
    sqlx::query("DROP TABLE server_state")
        .execute(&t.st.auth.pool)
        .await
        .unwrap();
    post_rejection(&t.st, Kind::Movie, 1, Some(&c));
    let calls = t.rec.settle().await;
    assert!(calls[0].bearer.is_none());
    assert_eq!(calls[0].secret.as_deref(), Some("rec-secret"));
    sqlx::query(
        "CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts TEXT NOT NULL)",
    )
    .execute(&t.st.auth.pool)
    .await
    .unwrap();
    post_rejection(&t.st, Kind::Movie, 1, Some(&c));
    assert!(t.rec.settle().await[0].bearer.is_some(), "recovered");
}

#[test]
fn windows_clamp() {
    assert_eq!(clamp_window(30.0), 30);
    assert_eq!(clamp_window(0.0), 1);
    assert_eq!(clamp_window(1000.0), 365);
    assert_eq!(clamp_window(7.9), 7);
    assert_eq!(clamp_window(f64::NAN), 30);
}

// --- /api/recommender/event ------------------------------------------------------------

async fn click(t: &T, cookie: Option<&str>, body: Value) -> Reply {
    send(
        &t.app,
        json_req("POST", "/api/recommender/event", cookie, Some(&body)),
    )
    .await
}

#[tokio::test]
async fn event_validation() {
    let t = setup(false).await;
    assert_eq!(
        click(
            &t,
            None,
            json!({ "kind": "movie", "tmdbId": 1, "signal": "clicked" })
        )
        .await
        .status,
        401
    );
    let c = member(&t.st, ALICE, "guest", "user").await;
    for (body, code) in [
        (
            json!({ "kind": "audio", "tmdbId": 1, "signal": "clicked" }),
            "invalid_kind",
        ),
        (
            json!({ "kind": "movie", "tmdbId": 1.5, "signal": "clicked" }),
            "invalid_tmdbId",
        ),
        (
            json!({ "kind": "movie", "tmdbId": 0, "signal": "clicked" }),
            "invalid_tmdbId",
        ),
        (
            json!({ "kind": "movie", "tmdbId": -42, "signal": "clicked" }),
            "invalid_tmdbId",
        ),
        (
            json!({ "kind": "movie", "tmdbId": "123", "signal": "clicked" }),
            "invalid_tmdbId",
        ),
        (
            json!({ "kind": "movie", "tmdbId": null, "signal": "clicked" }),
            "invalid_tmdbId",
        ),
        (
            json!({ "kind": "movie", "tmdbId": 1, "signal": "like" }),
            "invalid_signal",
        ),
        (json!(false), "invalid_body"),
    ] {
        let r = click(&t, Some(&c), body.clone()).await;
        assert_eq!(
            (r.status.as_u16(), r.body),
            (400, format!(r#"{{"error":"{code}"}}"#)),
            "{body}"
        );
    }
    let r = send(
        &t.app,
        axum::http::Request::post("/api/recommender/event")
            .header("cookie", &c)
            .body(Body::from("not json"))
            .unwrap(),
    )
    .await;
    assert_eq!(r.body, r#"{"error":"invalid_body"}"#);
}

#[tokio::test]
async fn event_mirrors_a_click_only_with_the_local_recommender() {
    let off = setup(false).await;
    let c = member(&off.st, ALICE, "guest", "user").await;
    let body = json!({ "kind": "movie", "tmdbId": 12345, "signal": "clicked" });
    let r = click(&off, Some(&c), body.clone()).await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_str()),
        (200, r#"{"ok":true}"#)
    );
    assert!(off.rec.settle().await.is_empty());

    let on = setup(true).await;
    let c = member(&on.st, ALICE, "guest", "user").await;
    assert_eq!(click(&on, Some(&c), body).await.status, 200);
    let calls = on.rec.settle().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(
        (calls[0].method.as_str(), calls[0].path.as_str()),
        ("POST", "/events/feedback")
    );
    assert_eq!(
        calls[0].body,
        json!({ "sub": ALICE, "kind": "movie", "tmdb_id": 12345, "signal": "clicked" })
    );

    // Validation runs before the gate.
    click(
        &on,
        Some(&c),
        json!({ "kind": "movie", "tmdbId": 1.5, "signal": "clicked" }),
    )
    .await;
    assert!(on.rec.settle().await.is_empty());
}

// --- /api/recommender/metrics ------------------------------------------------------------

#[tokio::test]
async fn metrics_is_admin_only_and_passes_the_funnel_through() {
    let off = setup(false).await;
    assert_eq!(
        send(
            &off.app,
            json_req("GET", "/api/recommender/metrics", None, None)
        )
        .await
        .status,
        401
    );
    let user = member(&off.st, ALICE, "guest", "user").await;
    assert_eq!(
        send(
            &off.app,
            json_req("GET", "/api/recommender/metrics", Some(&user), None)
        )
        .await
        .status,
        403
    );
    let admin = member(&off.st, ADMIN, "admin", "admin").await;
    let r = send(
        &off.app,
        json_req("GET", "/api/recommender/metrics", Some(&admin), None),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_str()),
        (503, r#"{"error":"recommender_disabled"}"#)
    );

    let t = setup(true).await;
    let admin = member(&t.st, ADMIN, "admin", "admin").await;
    for (query, wd) in [
        ("", 30),
        ("?windowDays=7.9", 7),
        ("?windowDays=1000", 365),
        ("?windowDays=abc", 30),
        ("?windowDays=", 1),
    ] {
        let r = send(
            &t.app,
            json_req(
                "GET",
                &format!("/api/recommender/metrics{query}"),
                Some(&admin),
                None,
            ),
        )
        .await;
        assert_eq!(r.status, 200, "{query}");
        assert_eq!(
            r.body,
            format!(
                r#"{{"window_days":{wd},"impressions":10,"rates":{{"added":0.25,"clicked":0.5}}}}"#
            )
        );
        assert_eq!(r.headers["content-type"], "application/json");
    }
    let calls = t.rec.settle().await;
    assert_eq!(calls[0].path, "/metrics/funnel?window_days=30");
    assert_eq!(calls[0].method, "GET");
    assert_eq!(
        open(&t.st, calls[0].bearer.as_deref().unwrap()).role,
        "admin"
    );

    t.rec.fail("/metrics/funnel", 500, "boom");
    let r = send(
        &t.app,
        json_req("GET", "/api/recommender/metrics", Some(&admin), None),
    )
    .await;
    assert_eq!(
        (r.status.as_u16(), r.body.as_str()),
        (
            502,
            r#"{"error":"metrics_unavailable","detail":"funnel metrics 500: boom"}"#
        )
    );
}
