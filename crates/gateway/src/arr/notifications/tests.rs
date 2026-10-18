//! What the goldens cannot drive: concurrent requests serialized by the one
//! lock (notifications.test.ts "serialization"), a hang-up that must not
//! stop a rollback, and the edges where the Rust answer differs from the TS
//! (both lists refused, a non-string webhookUrl).

use serde_json::{Value, json};

use super::super::fake::{Fake, Route};
use crate::AppState;
use crate::testutil::*;

const GOOD: &str = "https://discord.com/api/webhooks/123/abc";
const DISCORD: &str = "/api/notifications/discord";

async fn notif_state(dir: &tempfile::TempDir, fake: &Fake) -> (AppState, String) {
    let (sonarr, radarr) = (
        format!("{}/sonarr", fake.url),
        format!("{}/radarr", fake.url),
    );
    let st = state_in(
        dir,
        &[
            ("SONARR_URL", &sonarr),
            ("SONARR_API_KEY", "k"),
            ("RADARR_URL", &radarr),
            ("RADARR_API_KEY", "k"),
        ],
    )
    .await;
    let cookie = member(&st, ADMIN, "admin", "admin").await;
    (st, cookie)
}

fn conn(id: u64) -> Value {
    json!({ "id": id, "name": "Emerald Exchange Discord", "implementation": "Discord" })
}

fn delayed(method: &str, path: &str, status: u16, body: &Value) -> Route {
    let mut r = Route::new(method, path, status, body);
    r.delay_ms = 30;
    r
}

fn lists(items: &Value) -> Vec<Route> {
    vec![
        Route::new("GET", "/sonarr/api/v3/notification", 200, items),
        Route::new("GET", "/radarr/api/v3/notification", 200, items),
    ]
}

fn configure(cookie: &str) -> axum::http::Request<axum::body::Body> {
    json_req(
        "POST",
        DISCORD,
        Some(cookie),
        Some(&json!({ "webhookUrl": GOOD })),
    )
}

/// The methods of the calls `keep` selects, in arrival order.
fn order(fake: &Fake, keep: impl Fn(&str, &str) -> bool) -> Vec<String> {
    fake.take()
        .into_iter()
        .filter(|c| keep(&c.method, &c.path))
        .map(|c| {
            if c.path.ends_with("/test") {
                "TEST".into()
            } else {
                c.method
            }
        })
        .collect()
}

#[tokio::test]
async fn concurrent_posts_do_not_overlap() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    let mut routes = lists(&json!([]));
    routes.push(delayed(
        "POST",
        "/sonarr/api/v3/notification",
        201,
        &json!({ "id": 50 }),
    ));
    routes.push(delayed(
        "POST",
        "/radarr/api/v3/notification",
        201,
        &json!({ "id": 51 }),
    ));
    fake.set_routes(routes);
    let (a, b) = tokio::join!(
        send(&app, configure(&cookie)),
        send(&app, configure(&cookie))
    );
    assert_eq!(
        (a.status.as_u16(), b.status.as_u16()),
        (200, 200),
        "{} {}",
        a.body,
        b.body
    );
    // Each request lists then creates before the other starts.
    assert_eq!(
        order(&fake, |_, _| true),
        ["GET", "GET", "POST", "POST", "GET", "GET", "POST", "POST"]
    );
}

#[tokio::test]
async fn a_concurrent_post_and_delete_do_not_interleave() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    let mut routes = lists(&json!([conn(7)]));
    for app in ["sonarr", "radarr"] {
        let path = format!("/{app}/api/v3/notification/7");
        routes.push(delayed("PUT", &path, 200, &json!({ "id": 7 })));
        routes.push(delayed("DELETE", &path, 200, &json!({})));
    }
    fake.set_routes(routes);
    let del = json_req("DELETE", DISCORD, Some(&cookie), None);
    let (post, del) = tokio::join!(send(&app, configure(&cookie)), send(&app, del));
    assert_eq!(
        (post.status.as_u16(), del.status.as_u16()),
        (200, 200),
        "{} {}",
        post.body,
        del.body
    );
    assert_eq!(
        serde_json::from_str::<Value>(&del.body).unwrap(),
        json!({ "ok": true, "removed": 2 })
    );
    let seen = order(&fake, |m, _| m != "GET").join(",");
    assert!(
        ["PUT,PUT,DELETE,DELETE", "DELETE,DELETE,PUT,PUT"].contains(&seen.as_str()),
        "{seen}"
    );
}

#[tokio::test]
async fn a_concurrent_test_and_delete_do_not_interleave() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    let mut routes = lists(&json!([conn(7)]));
    routes.push(delayed(
        "POST",
        "/sonarr/api/v3/notification/7/test",
        200,
        &json!({}),
    ));
    routes.push(delayed(
        "DELETE",
        "/sonarr/api/v3/notification/7",
        200,
        &json!({}),
    ));
    routes.push(delayed(
        "DELETE",
        "/radarr/api/v3/notification/7",
        200,
        &json!({}),
    ));
    fake.set_routes(routes);
    let test = json_req(
        "POST",
        "/api/notifications/discord/test",
        Some(&cookie),
        None,
    );
    let del = json_req("DELETE", DISCORD, Some(&cookie), None);
    let (test, del) = tokio::join!(send(&app, test), send(&app, del));
    assert_eq!(
        (test.status.as_u16(), del.status.as_u16()),
        (200, 200),
        "{} {}",
        test.body,
        del.body
    );
    let seen = order(&fake, |m, _| m != "GET").join(",");
    assert!(
        ["TEST,DELETE,DELETE", "DELETE,DELETE,TEST"].contains(&seen.as_str()),
        "{seen}"
    );
}

/// The client goes away after Sonarr's connector is created; Radarr's create
/// then fails and Sonarr's is still rolled back.
#[tokio::test]
async fn a_hang_up_does_not_stop_the_rollback() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    let mut routes = lists(&json!([]));
    routes.push(Route::new(
        "POST",
        "/sonarr/api/v3/notification",
        201,
        &json!({ "id": 50 }),
    ));
    let mut radarr = Route::new(
        "POST",
        "/radarr/api/v3/notification",
        500,
        &json!({ "error": "boom" }),
    );
    radarr.hold = true;
    routes.push(radarr);
    routes.push(Route::new(
        "DELETE",
        "/sonarr/api/v3/notification/50",
        200,
        &json!({}),
    ));
    fake.set_routes(routes);
    let client = tokio::spawn({
        let (app, req) = (app.clone(), configure(&cookie));
        async move { send(&app, req).await }
    });
    fake.until(|f| f.count("POST", "/radarr/api/v3/notification") == 1)
        .await;
    client.abort();
    assert!(client.await.is_err_and(|e| e.is_cancelled()));
    fake.release_held(1);
    fake.until(|f| f.count("DELETE", "/sonarr/api/v3/notification/50") == 1)
        .await;
}

#[tokio::test]
async fn both_lists_refused_names_sonarr() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    fake.set_routes(vec![
        Route::new("GET", "/sonarr/api/v3/notification", 500, &json!({})),
        Route::new("GET", "/radarr/api/v3/notification", 502, &json!({})),
    ]);
    let r = send(&app, json_req("GET", DISCORD, Some(&cookie), None)).await;
    assert_eq!(r.status, 502);
    assert_eq!(
        serde_json::from_str::<Value>(&r.body).unwrap(),
        json!({ "error": "sonarr_list_failed", "status": 500 })
    );
    let r = send(&app, configure(&cookie)).await;
    assert_eq!(r.status, 502);
    assert_eq!(fake.count("POST", "/sonarr/api/v3/notification"), 0);
}

/// The TS threw on `.trim()` of a non-string (500).
#[tokio::test]
async fn a_non_string_webhook_url_is_required() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = notif_state(&dir, &fake).await;
    let app = crate::router(st);
    for url in [json!({}), json!(5), json!(null)] {
        let req = json_req(
            "POST",
            DISCORD,
            Some(&cookie),
            Some(&json!({ "webhookUrl": url })),
        );
        let r = send(&app, req).await;
        assert_eq!(r.status, 400, "{url}");
        assert_eq!(r.body, r#"{"error":"webhookUrl_required"}"#);
    }
    assert!(fake.take().is_empty());
}
