//! What the goldens cannot drive: the background TV grab's reservation held
//! open on purpose (sonarr.test.ts "season-grab in-flight reservation"),
//! released after a failed or a successful grab, never taken for a zero-byte
//! plan; the 180 s search/grab budgets; a grab that errors; the timings.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::super::fake::{Fake, Route};
use super::super::shared::{Folder, GB, Held, Ledger, Timings};
use crate::AppState;
use crate::testutil::*;

const FOUR_GB: f64 = 4.0 * GB;
/// One 4 GB reservation fits above the 100 GB floor; a second does not.
const TIGHT_FREE: f64 = 107.0 * GB;
const MONITOR: &str = "/api/sonarr/api/v3/series/7/seasons/1/monitor";

fn fast() -> Timings {
    Timings {
        tv_settle: Duration::ZERO,
        tv_poll: Duration::ZERO,
        ..Timings::default()
    }
}

async fn sonarr_state(
    dir: &tempfile::TempDir,
    fake: &Fake,
    timings: Timings,
) -> (AppState, String) {
    let p = |f: &str| dir.path().join(f).to_str().unwrap().to_string();
    let sonarr = format!("{}/sonarr", fake.url);
    let (grabs, policies) = (p("grabs.jsonl"), p("policies.json"));
    let mut st = state_in(
        dir,
        &[
            ("SONARR_URL", &sonarr),
            ("SONARR_API_KEY", "k"),
            ("GRAB_LOG_PATH", &grabs),
            ("USER_POLICIES_PATH", &policies),
        ],
    )
    .await;
    st.arr = Arc::new(super::super::ArrState::new(&st.config, timings));
    let cookie = member(&st, ADMIN, "admin", "admin").await;
    (st, cookie)
}

/// Series 7 on `path`, season 1 unmonitored with one episode, one 4 GB
/// release (none with `no_releases`), and the grab POST.
fn routes(path: &str, free: f64, grab_status: u16, no_releases: bool) -> Vec<Route> {
    let release = if no_releases {
        json!([])
    } else {
        json!([{ "guid": "g-7", "indexerId": 1, "size": FOUR_GB, "qualityWeight": 100,
                 "title": "Reserved Show S01E01", "seasonNumber": 1, "episodeNumbers": [1] }])
    };
    vec![
        Route::new(
            "GET",
            "/sonarr/api/v3/rootfolder",
            200,
            &json!([{ "id": 1, "path": path, "freeSpace": free }]),
        ),
        Route::new(
            "GET",
            "/sonarr/api/v3/series/7",
            200,
            &json!({ "id": 7, "title": "Reserved Show", "rootFolderPath": path,
                     "seasons": [{ "seasonNumber": 1, "monitored": false }] }),
        ),
        Route::new("PUT", "/sonarr/api/v3/series/7", 200, &json!({ "id": 7 })),
        Route::new(
            "GET",
            "/sonarr/api/v3/episode",
            200,
            &json!([{ "seasonNumber": 1, "episodeNumber": 1, "hasFile": false }]),
        ),
        Route::new("GET", "/sonarr/api/v3/release", 200, &release),
        Route::new(
            "POST",
            "/sonarr/api/v3/release",
            grab_status,
            &json!({ "ok": grab_status < 400 }),
        ),
        Route::new(
            "POST",
            "/sonarr/api/v3/series",
            201,
            &json!({ "id": 8, "title": "Another Show" }),
        ),
    ]
}

async fn monitor(app: &axum::Router, cookie: &str) -> Reply {
    send(app, json_req("POST", MONITOR, Some(cookie), None)).await
}

fn grab_posts(fake: &Fake) -> usize {
    fake.count("POST", "/sonarr/api/v3/release")
}

fn grab_types(dir: &tempfile::TempDir) -> Vec<String> {
    std::fs::read_to_string(dir.path().join("grabs.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

fn pending(st: &AppState, path: &str) -> f64 {
    let folder = Folder {
        path: path.into(),
        free_space: TIGHT_FREE,
    };
    st.arr.sonarr_ledger.pending_bytes(&folder)
}

#[tokio::test]
async fn a_held_reservation_refuses_a_second_monitor_and_a_search_add() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-overcommit";
    let mut routes = routes(path, TIGHT_FREE, 200, false);
    routes
        .iter_mut()
        .find(|r| r.method == "POST" && r.path.ends_with("/release"))
        .unwrap()
        .hold = true;
    fake.set_routes(routes);

    // #1 reserves 4 GB and its grab POST hangs.
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    fake.until(|f| grab_posts(f) == 1).await;
    assert_eq!(pending(&st, path), FOUR_GB);

    // #2 is refused before any grab of its own.
    let second = monitor(&app, &cookie).await;
    assert_eq!(second.status, 409, "{}", second.body);
    let body: Value = serde_json::from_str(&second.body).unwrap();
    assert_eq!(body["error"], "root_folder_reservation_in_flight");
    assert_eq!(body["reserved_bytes"].as_f64(), Some(FOUR_GB));
    assert_eq!(body["free_bytes"].as_f64(), Some(TIGHT_FREE - FOUR_GB));
    let add = json!({ "title": "Another Show", "rootFolderPath": path, "qualityProfileId": 7,
                      "addOptions": { "searchForMissingEpisodes": true } });
    let added = send(
        &app,
        json_req(
            "POST",
            "/api/sonarr/api/v3/series",
            Some(&cookie),
            Some(&add),
        ),
    )
    .await;
    assert_eq!(added.status, 409, "{}", added.body);
    assert_eq!(fake.count("POST", "/sonarr/api/v3/series"), 0);
    assert_eq!(grab_posts(&fake), 1);

    // #1 finishes: the bytes are released and the next monitor grabs.
    fake.release_held(1);
    st.arr.idle().await;
    assert_eq!(pending(&st, path), 0.0);
    fake.release_held(1);
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 2);
}

/// A leaked reservation would 409 the follow-up (and TIGHT_FREE leaves no
/// room for a second plan either way).
#[tokio::test]
async fn the_reservation_is_released_after_a_failed_grab() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-failrelease";
    fake.set_routes(routes(path, TIGHT_FREE, 500, false));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 1);
    assert_eq!(pending(&st, path), 0.0);

    fake.set_routes(routes(path, TIGHT_FREE, 200, false));
    let r = monitor(&app, &cookie).await;
    assert_eq!(r.status, 200, "{}", r.body);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 2);
    assert_eq!(
        grab_types(&dir),
        [
            "grab_started",
            "grab_failed",
            "grab_started",
            "grab_succeeded"
        ]
    );
}

#[tokio::test]
async fn the_reservation_settles_after_a_full_success() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-fullsuccess";
    fake.set_routes(routes(path, TIGHT_FREE, 200, false));
    for n in 1..=2 {
        assert_eq!(monitor(&app, &cookie).await.status, 200);
        st.arr.idle().await;
        assert_eq!(grab_posts(&fake), n);
    }
    assert_eq!(pending(&st, path), 0.0);
    assert!(
        !grab_types(&dir)
            .iter()
            .any(|t| t == "planned_size_exceeds_free_space")
    );
}

#[tokio::test]
async fn a_zero_byte_plan_reserves_nothing() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-zerobytes";
    fake.set_routes(routes(path, TIGHT_FREE, 200, true));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 0);
    assert_eq!(pending(&st, path), 0.0);

    fake.set_routes(routes(path, TIGHT_FREE, 200, false));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 1);
    assert_eq!(
        grab_types(&dir),
        [
            "grab_started",
            "no_releases",
            "grab_started",
            "grab_succeeded"
        ]
    );
}

/// The interactive budget is far shorter than the fake's delay; the
/// background grab runs on its own (180 s in production).
#[tokio::test]
async fn a_slow_season_search_and_a_slow_grab_still_grab() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let timings = Timings {
        search: Duration::from_millis(50),
        tv_search: Duration::from_secs(5),
        ..fast()
    };
    let (st, cookie) = sonarr_state(&dir, &fake, timings).await;
    let app = crate::router(st.clone());
    let mut routes = routes("/data/tv-slow", 500.0 * GB, 200, false);
    for r in routes.iter_mut().filter(|r| r.path.ends_with("/release")) {
        r.delay_ms = 300;
    }
    fake.set_routes(routes);
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_types(&dir), ["grab_started", "grab_succeeded"]);
}

#[tokio::test]
async fn an_unreadable_episode_list_is_grab_failed() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv";
    let mut routes = routes(path, 500.0 * GB, 200, false);
    let episodes = routes
        .iter_mut()
        .find(|r| r.path.ends_with("/episode"))
        .unwrap();
    episodes.text = "<html>busy</html>".into();
    fake.set_routes(routes);
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;
    assert_eq!(grab_posts(&fake), 0);
    assert_eq!(pending(&st, path), 0.0);
    let log = std::fs::read_to_string(dir.path().join("grabs.jsonl")).unwrap();
    let last: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(last["type"], "grab_failed");
    assert_eq!(last["itemId"], 7);
    assert_eq!(last["title"], "Reserved Show");
    assert!(
        last["error"]
            .as_str()
            .unwrap()
            .starts_with("episode list is not JSON"),
        "{last}"
    );
    assert!(last.get("capGb").is_none());
}

#[test]
fn a_dropped_hold_releases_its_bytes() {
    let ledger = Ledger::new("sonarr", 100.0 * GB);
    let folder = Folder {
        path: "/data/tv".into(),
        free_space: TIGHT_FREE,
    };
    assert!(ledger.reserve(&folder, FOUR_GB));
    drop(Held {
        ledger: &ledger,
        folder: &folder,
        bytes: FOUR_GB,
    });
    assert_eq!(ledger.pending_bytes(&folder), 0.0);
}

#[test]
fn the_tv_waits_match_the_ts() {
    let t = Timings::default();
    assert_eq!(t.tv_settle, Duration::from_secs(2));
    assert_eq!(t.tv_poll, Duration::from_millis(1500));
    assert_eq!(t.tv_search, Duration::from_secs(180));
}

/// A hang-up while Sonarr is still committing the add itself: the capped
/// grab must still run.
#[tokio::test]
async fn a_hang_up_during_the_add_post_still_grabs() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-hangup-add";
    let mut routes = routes(path, TIGHT_FREE, 200, false);
    let add_route = routes
        .iter_mut()
        .find(|r| r.method == "POST" && r.path.ends_with("/series"))
        .unwrap();
    *add_route = Route::new(
        "POST",
        "/sonarr/api/v3/series",
        201,
        &json!({ "id": 7, "title": "Reserved Show", "rootFolderPath": path,
                 "seasons": [{ "seasonNumber": 1, "monitored": true }] }),
    );
    add_route.hold = true;
    fake.set_routes(routes);

    let body = json!({ "title": "Reserved Show", "rootFolderPath": path, "qualityProfileId": 7,
                       "addOptions": { "searchForMissingEpisodes": true } });
    let req = tokio::spawn({
        let (app, cookie) = (app.clone(), cookie.clone());
        async move {
            send(
                &app,
                json_req(
                    "POST",
                    "/api/sonarr/api/v3/series",
                    Some(&cookie),
                    Some(&body),
                ),
            )
            .await
        }
    });
    fake.until(|f| f.count("POST", "/sonarr/api/v3/series") == 1)
        .await;
    req.abort();
    assert!(req.await.is_err_and(|e| e.is_cancelled()));

    fake.release_held(1);
    fake.until(|f| grab_posts(f) == 1).await;
    st.arr.idle().await;
}

/// With room for more than one capped episode beyond the floor, a held
/// reservation does not refuse a second add: its own plan reserves
/// atomically, so blocking it would only stall the household.
#[tokio::test]
async fn a_held_reservation_with_room_to_spare_lets_a_second_add_through() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-roomy";
    let mut routes = routes(path, 500.0 * GB, 200, false);
    routes
        .iter_mut()
        .find(|r| r.method == "POST" && r.path.ends_with("/release"))
        .unwrap()
        .hold = true;
    fake.set_routes(routes);

    assert_eq!(monitor(&app, &cookie).await.status, 200);
    fake.until(|f| grab_posts(f) == 1).await;
    assert_eq!(pending(&st, path), FOUR_GB);

    let add = json!({ "title": "Another Show", "rootFolderPath": path, "qualityProfileId": 7,
                      "addOptions": { "searchForMissingEpisodes": true } });
    let added = send(
        &app,
        json_req(
            "POST",
            "/api/sonarr/api/v3/series",
            Some(&cookie),
            Some(&add),
        ),
    )
    .await;
    assert_eq!(added.status, 201, "{}", added.body);
    assert_eq!(fake.count("POST", "/sonarr/api/v3/series"), 1);
    fake.release_held(8);
    st.arr.idle().await;
}

const ONE_GB: f64 = GB;

fn release(guid: &str, indexer: u64, weight: u64, ep: u64) -> Value {
    json!({ "guid": guid, "indexerId": indexer, "indexer": format!("ix-{indexer}"),
            "size": ONE_GB, "qualityWeight": weight,
            "title": format!("Show S01E0{ep} {guid}"), "seasonNumber": 1, "episodeNumbers": [ep] })
}

/// Series 7 with `eps` season-1 episodes, the given releases, and one grab
/// route per indexer id answering `status`.
fn indexer_routes(path: &str, eps: u64, releases: Vec<Value>, grabs: &[(u64, u16)]) -> Vec<Route> {
    let mut routes: Vec<Route> = routes(path, 500.0 * GB, 200, false)
        .into_iter()
        .filter(|r| !r.path.ends_with("/release") && !r.path.ends_with("/episode"))
        .collect();
    let episodes: Vec<Value> = (1..=eps)
        .map(|e| json!({ "seasonNumber": 1, "episodeNumber": e, "hasFile": false }))
        .collect();
    routes.push(Route::new(
        "GET",
        "/sonarr/api/v3/episode",
        200,
        &json!(episodes),
    ));
    routes.push(Route::new(
        "GET",
        "/sonarr/api/v3/release",
        200,
        &json!(releases),
    ));
    for (ix, status) in grabs {
        routes.push(
            Route::new("POST", "/sonarr/api/v3/release", *status, &json!({}))
                .body_has("indexerId", json!(ix)),
        );
    }
    routes
}

fn grabbed_guids(fake: &Fake) -> Vec<(String, u64)> {
    fake.take()
        .into_iter()
        .filter(|c| c.method == "POST" && c.path == "/sonarr/api/v3/release")
        .map(|c| {
            (
                c.body["guid"].as_str().unwrap().to_string(),
                c.body["indexerId"].as_u64().unwrap(),
            )
        })
        .collect()
}

fn last_error(dir: &tempfile::TempDir) -> String {
    let log = std::fs::read_to_string(dir.path().join("grabs.jsonl")).unwrap();
    let last: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(last["type"], "grab_failed", "{last}");
    last["error"].as_str().unwrap().to_string()
}

/// The 2026-11-08 Voyager run: the preferred indexer hit its API grab limit
/// and Sonarr answered every grab 409. Each chunk falls back to the other
/// indexer; after two refusals the spent indexer is not asked again.
#[tokio::test]
async fn a_refusing_indexer_falls_back_and_is_skipped_once_spent() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-refusing";
    let releases = vec![
        release("a1", 1, 100, 1),
        release("a2", 1, 100, 2),
        release("a3", 1, 100, 3),
        release("b1", 2, 50, 1),
        release("b2", 2, 50, 2),
        release("b3", 2, 50, 3),
    ];
    fake.set_routes(indexer_routes(path, 3, releases, &[(1, 409), (2, 200)]));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;

    let tried: Vec<String> = grabbed_guids(&fake).into_iter().map(|(g, _)| g).collect();
    assert_eq!(tried, ["a1", "b1", "a2", "b2", "b3"]);
    assert_eq!(pending(&st, path), 0.0);
    let types = grab_types(&dir);
    assert_eq!(types.iter().filter(|t| *t == "grab_succeeded").count(), 3);
    assert_eq!(types.last().unwrap(), "grab_succeeded");
}

/// No fallback: a spent indexer's remaining chunks are skipped without a
/// request, their bytes go straight back, and one summary names it.
#[tokio::test]
async fn a_spent_indexer_with_no_fallback_skips_and_releases() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-spent";
    let releases = (1..=5)
        .map(|e| release(&format!("a{e}"), 1, 100, e))
        .collect();
    fake.set_routes(indexer_routes(path, 5, releases, &[(1, 409)]));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;

    assert_eq!(grabbed_guids(&fake).len(), 2);
    assert_eq!(pending(&st, path), 0.0);
    let why = last_error(&dir);
    assert!(why.starts_with("5 not grabbed"), "{why}");
    assert!(why.contains("ix-1"), "{why}");
}

/// Sonarr itself failing stops the run after three grabs instead of
/// spending the search budget on every remaining chunk.
#[tokio::test]
async fn repeated_grab_failures_stop_the_run() {
    let fake = Fake::start(vec![]).await;
    let dir = tempfile::tempdir().unwrap();
    let (st, cookie) = sonarr_state(&dir, &fake, fast()).await;
    let app = crate::router(st.clone());
    let path = "/data/tv-broken";
    let releases = (1..=5)
        .map(|e| release(&format!("a{e}"), 1, 100, e))
        .collect();
    fake.set_routes(indexer_routes(path, 5, releases, &[(1, 500)]));
    assert_eq!(monitor(&app, &cookie).await.status, 200);
    st.arr.idle().await;

    assert_eq!(grabbed_guids(&fake).len(), 3);
    assert_eq!(pending(&st, path), 0.0);
    let why = last_error(&dir);
    assert!(why.contains("2 not attempted"), "{why}");
}
