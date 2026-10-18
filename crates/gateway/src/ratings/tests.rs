//! ratings.test.ts (parsers, id validation, the merged shape, repeats from
//! server.db) plus the fill queue's in-flight dedupe, its concurrency cap and
//! the pending list. Every upstream is the loopback fake, and each test
//! asserts the fake's hits.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::*;
use crate::testutil::*;
use crate::tmdb::fake::{Fake, Route, Stubs};

const RT_HTML: &str = r#"<script>{"audienceScore":{"bandedRatingCount":"25,000+ Ratings","score":"97","title":"Avg. Popcornmeter"},"criticsScore":{"averageRating":"9.20","score":"96","title":"Avg. Tomatometer"}}</script>"#;

fn bb_omdb() -> Value {
    json!({ "Response": "True", "imdbRating": "9.5", "Metascore": "87",
            "Ratings": [{ "Source": "Rotten Tomatoes", "Value": "90%" }] })
}

fn omdb(id: &str, body: &Value) -> Route {
    Route::json("/omdb/", 200, body).query("i", id)
}

fn wikidata(pairs: &[(&str, &str)]) -> Route {
    let bindings: Vec<Value> = pairs
        .iter()
        .map(|(i, r)| json!({ "imdb": { "value": i }, "rt": { "value": r } }))
        .collect();
    Route::json(
        "/wikidata/sparql",
        200,
        &json!({ "results": { "bindings": bindings } }),
    )
}

async fn setup(
    routes: Vec<Route>,
    sync_wait: Duration,
) -> (Fake, Stubs, tempfile::TempDir, axum::Router, String) {
    let fake = Fake::start(routes).await;
    let stubs = Stubs::new();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("server.db").to_str().unwrap().to_string();
    let mut cfg = config(&[("SERVER_DB_PATH", &db), ("OMDB_API_KEY", "k")]);
    stubs.wire(&mut cfg.ext, &fake.url);
    let pool = auth::db::open(&db).await.unwrap();
    let mut st = crate::AppState::new(pool, cfg);
    st.ratings = Arc::new(Ratings::new(sync_wait));
    let cookie = member(&st, ALICE, "alice", "user").await;
    (fake, stubs, dir, crate::router(st), cookie)
}

async fn ratings(app: &axum::Router, cookie: &str, ids: &str) -> (u16, Value) {
    let path = format!("/api/ratings?ids={ids}");
    let r = send(app, json_req("GET", &path, Some(cookie), None)).await;
    (r.status.as_u16(), serde_json::from_str(&r.body).unwrap())
}

#[test]
fn parse_omdb_maps_na_to_null_and_reads_the_rt_critic_score() {
    let got = parse_omdb(&json!({ "imdbRating": "8.1", "Metascore": "N/A",
        "Ratings": [{ "Source": "Rotten Tomatoes", "Value": "77%" }] }));
    assert_eq!(
        got,
        TitleRatings {
            imdb: Some(8.1),
            rt: Some(77.0),
            rt_audience: None,
            metacritic: None
        }
    );
    assert_eq!(
        parse_omdb(&json!({ "Response": "False" })),
        TitleRatings::default()
    );
    // parseFloat reads a leading number.
    assert_eq!(
        parse_omdb(&json!({ "imdbRating": " 7.5/10" })).imdb,
        Some(7.5)
    );
}

#[test]
fn parse_rt_page_reads_tomatometer_and_popcornmeter() {
    assert_eq!(
        parse_rt_page(RT_HTML),
        RtScores {
            rt: Some(96.0),
            rt_audience: Some(97.0)
        }
    );
    assert_eq!(parse_rt_page("<html>no scores</html>"), RtScores::default());
    let empty = r#"{"criticsScore":{"score":""},"audienceScore":{"score":"55"}}"#;
    assert_eq!(
        parse_rt_page(empty),
        RtScores {
            rt: None,
            rt_audience: Some(55.0)
        }
    );
}

#[test]
fn id_and_slug_shapes() {
    assert!(imdb_id("tt0903747") && imdb_id("tt12345") && imdb_id("tt1234567890"));
    assert!(!imdb_id("tt1234") && !imdb_id("tt12345678901") && !imdb_id("breaking-bad"));
    assert!(rt_slug("tv/breaking_bad") && rt_slug("m/the-matrix_1999"));
    assert!(!rt_slug("tv/") && !rt_slug("x/a") && !rt_slug("m/Upper") && !rt_slug("m/a b"));
}

#[tokio::test]
async fn malformed_ids_are_400_without_upstream_calls() {
    let (fake, _s, _d, app, cookie) = setup(vec![], SYNC_WAIT).await;
    assert_eq!(ratings(&app, &cookie, "breaking-bad").await.0, 400);
    assert!(fake.take().is_empty());
}

#[tokio::test]
async fn merges_omdb_and_rt_caches_misses_and_serves_repeats_from_server_db() {
    let routes = vec![
        wikidata(&[("tt0903747", "tv/breaking_bad")]),
        Route::html("/rt/tv/breaking_bad", 200, RT_HTML),
        omdb("tt0903747", &bb_omdb()),
        omdb(
            "tt0000001",
            &json!({ "Response": "False", "Error": "Incorrect IMDb ID." }),
        ),
    ];
    let (fake, _s, _d, app, cookie) = setup(routes, SYNC_WAIT).await;
    let (status, body) = ratings(&app, &cookie, "tt0903747,tt0000001").await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({
            "ratings": {
                "tt0903747": { "imdb": 9.5, "rt": 96, "rtAudience": 97, "metacritic": 87 },
                "tt0000001": { "imdb": null, "rt": null, "rtAudience": null, "metacritic": null },
            },
            "pending": [],
        })
    );
    assert_eq!(fake.count("/wikidata/sparql"), 1);
    assert_eq!(fake.count("/rt/tv/breaking_bad"), 1);
    assert_eq!(fake.take().len(), 4);
    let (_, again) = ratings(&app, &cookie, "tt0903747,tt0000001").await;
    assert_eq!(again, body);
    assert!(fake.take().is_empty());
}

#[tokio::test]
async fn an_id_already_filling_is_not_fetched_twice() {
    let routes = vec![
        wikidata(&[("tt0000008", "m/slow")]),
        Route::html("/rt/m/slow", 200, RT_HTML).held(),
        omdb("tt0000008", &bb_omdb()),
    ];
    let (fake, _s, _d, app, cookie) = setup(routes, Duration::from_millis(200)).await;
    let (a, b) = tokio::join!(
        ratings(&app, &cookie, "tt0000008"),
        ratings(&app, &cookie, "tt0000008")
    );
    for (status, body) in [a, b] {
        assert_eq!(status, 200);
        assert_eq!(body, json!({ "ratings": {}, "pending": ["tt0000008"] }));
    }
    fake.release(1);
    fake.until(|f| f.count("/omdb/") == 1).await;
    let mut done = json!(null);
    for _ in 0..50 {
        done = ratings(&app, &cookie, "tt0000008").await.1;
        if done["pending"] == json!([]) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(done["ratings"]["tt0000008"]["rt"], json!(96));
    assert_eq!(fake.count("/wikidata/sparql"), 1);
    assert_eq!(fake.count("/rt/m/slow"), 1);
    assert_eq!(fake.count("/omdb/"), 1);
}

#[tokio::test]
async fn at_most_three_titles_fill_at_once() {
    let ids: Vec<String> = (1..=5).map(|i| format!("tt000010{i}")).collect();
    let mut routes = vec![wikidata(&[])];
    routes.extend(ids.iter().map(|id| omdb(id, &bb_omdb()).held()));
    let (fake, _s, _d, app, cookie) = setup(routes, Duration::from_millis(100)).await;
    let (status, body) = ratings(&app, &cookie, &ids.join(",")).await;
    assert_eq!(status, 200);
    assert_eq!(body["pending"].as_array().unwrap().len(), 5);
    fake.until(|f| f.count("/omdb/") == 3).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fake.count("/omdb/"), 3, "the fourth waits for a permit");
    fake.release(5);
    fake.until(|f| f.count("/omdb/") == 5).await;
}

#[tokio::test]
async fn a_failing_write_or_read_never_reaches_the_client_as_a_panic() {
    // A transport failure leaves nothing cached and nothing pending.
    let routes = vec![wikidata(&[]), Route::json("/omdb/", 500, &json!("down"))];
    let (fake, _s, _d, app, cookie) = setup(routes, SYNC_WAIT).await;
    let (status, body) = ratings(&app, &cookie, "tt0000001").await;
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "ratings": {}, "pending": [] }));
    assert_eq!(fake.take().len(), 2);
}
