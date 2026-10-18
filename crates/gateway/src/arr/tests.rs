//! Route cases the goldens cannot drive: concurrent adds against one
//! reservation ledger (radarr.test.ts "movie-add in-flight reservation"), a
//! grab POST that outlives its budget, and a release list the TS threw on.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::fake::{Fake, Route};
use super::shared::{GB, Timings};
use crate::AppState;
use crate::testutil::*;

const FOUR_GB: f64 = 4.0 * GB;
/// One 4 GB grab fits above the 100 GB floor; a second does not.
const TIGHT_FREE: f64 = 107.0 * GB;

async fn radarr_state(
    dir: &tempfile::TempDir,
    fake: &Fake,
    timings: Timings,
) -> (AppState, String) {
    let radarr = format!("{}/radarr", fake.url);
    let grabs = dir.path().join("grabs.jsonl").to_str().unwrap().to_string();
    let policies = dir
        .path()
        .join("policies.json")
        .to_str()
        .unwrap()
        .to_string();
    let mut st = state_in(
        dir,
        &[
            ("RADARR_URL", &radarr),
            ("RADARR_API_KEY", "k"),
            ("GRAB_LOG_PATH", &grabs),
            ("USER_POLICIES_PATH", &policies),
        ],
    )
    .await;
    st.arr = Arc::new(super::ArrState::new(&st.config, timings));
    let cookie = member(&st, ADMIN, "admin", "admin").await;
    (st, cookie)
}

fn fast() -> Timings {
    Timings {
        settle: Duration::ZERO,
        ..Timings::default()
    }
}

/// GET rootfolder, POST movie (id from the title), GET release, POST grab.
fn add_routes(
    path: &str,
    free: f64,
    ids: &[(&str, u64)],
    grab_status: u16,
    hold: bool,
) -> Vec<Route> {
    let mut routes = vec![Route::new(
        "GET",
        "/radarr/api/v3/rootfolder",
        200,
        &json!([{ "id": 1, "path": path, "freeSpace": free }]),
    )];
    for (title, id) in ids {
        routes.push(Route::new("GET", "/radarr/api/v3/release", 200, &json!([
            { "guid": format!("g-{id}"), "indexerId": 1, "size": FOUR_GB, "qualityWeight": 100, "title": format!("{title} 1080p") }
        ])).query("movieId", &id.to_string()));
        routes.push(Route::new(
            "DELETE",
            &format!("/radarr/api/v3/movie/{id}"),
            200,
            &json!({}),
        ));
        routes.push(Route::new(
            "PUT",
            &format!("/radarr/api/v3/movie/{id}"),
            200,
            &json!({}),
        ));
    }
    let mut grab = Route::new("POST", "/radarr/api/v3/release", grab_status, &json!({}));
    grab.hold = hold;
    routes.push(grab);
    routes
}

/// The fake answers POST /movie by title, so route it per add.
fn created(title: &str, id: u64) -> Route {
    Route::new(
        "POST",
        "/radarr/api/v3/movie",
        201,
        &json!({ "id": id, "title": title }),
    )
}

fn add_body(path: &str, title: &str) -> Value {
    json!({ "rootFolderPath": path, "title": title, "qualityProfileId": 7, "monitored": true, "addOptions": { "searchForMovie": true } })
}

async fn add(app: &axum::Router, cookie: &str, path: &str, title: &str) -> Reply {
    send(
        app,
        json_req(
            "POST",
            "/api/radarr/api/v3/movie",
            Some(cookie),
            Some(&add_body(path, title)),
        ),
    )
    .await
}

fn grab_posts(fake: &Fake) -> usize {
    fake.count("POST", "/radarr/api/v3/release")
}

#[tokio::test]
async fn a_held_reservation_refuses_a_concurrent_add_on_the_same_folder() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    // A short search budget: without the reservation the second add's grab
    // would hang on the held POST until this times it out.
    let timings = Timings {
        settle: Duration::ZERO,
        search: Duration::from_secs(5),
    };
    let (st, cookie) = radarr_state(&dir, &fake, timings).await;
    let app = crate::router(st);
    let path = "/data/movies-overcommit";
    let mut routes = add_routes(
        path,
        TIGHT_FREE,
        &[("Add One", 101), ("Add Two", 102)],
        200,
        true,
    );
    routes.insert(0, created("Add One", 101));
    fake.set_routes(routes.clone());

    // Add #1 reserves 4 GB and its grab POST hangs.
    let first = tokio::spawn({
        let (app, cookie) = (app.clone(), cookie.clone());
        async move { add(&app, &cookie, path, "Add One").await }
    });
    fake.until(|f| grab_posts(f) == 1).await;

    // Add #2 plans against the reduced headroom: nothing eligible, no POST.
    routes[0] = created("Add Two", 102);
    fake.set_routes(routes);
    let second = add(&app, &cookie, path, "Add Two").await;
    assert_eq!(second.status, 424, "{}", second.body);
    let body: Value = serde_json::from_str(&second.body).unwrap();
    assert_eq!(
        (body["error"].as_str(), body["phase"].as_str()),
        (Some("capped_grab_not_started"), Some("all_rejected_by_cap"))
    );
    assert_eq!(grab_posts(&fake), 1);

    fake.release_held(1);
    assert_eq!(first.await.unwrap().status, 201);
}

#[tokio::test]
async fn the_reservation_is_released_after_a_grab_either_way() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = radarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/movies-release";

    // A failed grab rolls the movie back and frees the bytes...
    let mut routes = add_routes(path, TIGHT_FREE, &[("One", 301)], 500, false);
    routes.insert(0, created("One", 301));
    fake.set_routes(routes);
    let r = add(&app, &cookie, path, "One").await;
    assert_eq!(r.status, 424, "{}", r.body);
    assert_eq!(grab_posts(&fake), 1);

    // ...and so does a successful one: each follow-up add grabs again.
    for (title, id) in [("Two", 302), ("Three", 303)] {
        fake.take();
        let mut routes = add_routes(path, TIGHT_FREE, &[(title, id)], 201, false);
        routes.insert(0, created(title, id));
        fake.set_routes(routes);
        let r = add(&app, &cookie, path, title).await;
        assert_eq!(r.status, 201, "{}", r.body);
        assert_eq!(grab_posts(&fake), 1);
    }
    let folder = super::shared::Folder {
        path: path.into(),
        free_space: TIGHT_FREE,
    };
    assert_eq!(st.arr.radarr_ledger.pending_bytes(&folder), 0.0);
}

#[tokio::test]
async fn a_grab_past_its_budget_is_kept_monitored_never_deleted() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let timings = Timings {
        settle: Duration::ZERO,
        search: Duration::from_millis(200),
    };
    let (st, cookie) = radarr_state(&dir, &fake, timings).await;
    let app = crate::router(st);
    let path = "/data/movies-grabtimeout";
    let mut routes = add_routes(path, 500.0 * GB, &[("Slow", 402)], 200, false);
    routes.insert(0, created("Slow", 402));
    routes.last_mut().unwrap().delay_ms = 1000;
    fake.set_routes(routes);
    let r = add(&app, &cookie, path, "Slow").await;
    assert_eq!(r.status, 200, "{}", r.body);
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(
        (body["status"].as_str(), body["phase"].as_str()),
        (Some("monitoring"), Some("grab_unconfirmed"))
    );
    assert_eq!(fake.count("DELETE", "/radarr/api/v3/movie/402"), 0);
    assert_eq!(fake.count("PUT", "/radarr/api/v3/movie/402"), 1);
    let log = std::fs::read_to_string(dir.path().join("grabs.jsonl")).unwrap();
    assert!(
        log.contains(r#""type":"grab_unconfirmed","status":504"#),
        "{log}"
    );
}

#[tokio::test]
async fn an_unusable_release_list_rolls_back_as_an_exception() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = radarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st);
    let path = "/data/movies";
    fake.set_routes(vec![
        created("Odd", 77),
        Route::new(
            "GET",
            "/radarr/api/v3/rootfolder",
            200,
            &json!([{ "id": 1, "path": path, "freeSpace": 500.0 * GB }]),
        ),
        Route::new(
            "GET",
            "/radarr/api/v3/release",
            200,
            &json!({ "not": "an array" }),
        ),
        Route::new("DELETE", "/radarr/api/v3/movie/77", 500, &json!({})),
    ]);
    let r = add(&app, &cookie, path, "Odd").await;
    assert_eq!(r.status, 424, "{}", r.body);
    let body: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(body["error"], "capped_grab_failed");
    assert_eq!(body["phase"], "exception");
    assert_eq!(body["rollbackStatus"], 500);
    assert!(body.get("movie").is_none());
    let log = std::fs::read_to_string(dir.path().join("grabs.jsonl")).unwrap();
    let last: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(
        (last["type"].as_str(), last["itemId"].as_u64()),
        (Some("grab_failed"), Some(77))
    );
}

#[tokio::test]
async fn the_settle_delay_is_honoured() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let timings = Timings {
        settle: Duration::from_millis(300),
        ..Timings::default()
    };
    let (st, cookie) = radarr_state(&dir, &fake, timings).await;
    let app = crate::router(st);
    let path = "/data/movies";
    let mut routes = add_routes(path, 500.0 * GB, &[("Wait", 5)], 200, false);
    routes.insert(0, created("Wait", 5));
    fake.set_routes(routes);
    let started = std::time::Instant::now();
    assert_eq!(add(&app, &cookie, path, "Wait").await.status, 201);
    assert!(started.elapsed() >= Duration::from_millis(300));
}
