//! Contract tests: status codes and JSON shapes of every route, carried over
//! from server/routes/iptv.test.ts (the cases whose checks moved here, not the
//! policy gates Hono keeps), plus the principal posture, gzip and the internal
//! endpoints.

use super::*;
use crate::catalog::tests::{channel, exec, pool, prog};
use crate::config::test_config;
use axum::http::{HeaderValue, Method};
use std::sync::Mutex;
use tower::ServiceExt;

const PRINCIPAL_SECRET: &str = "pppppppppppppppppppppppppppppppppppppppp";
const SECRET: &str = "ssssssssssssssssssssssssssssssssssssssss";

struct TestApp {
    app: Router,
    pool: SqlitePool,
    _dir: tempfile::TempDir,
}

struct Res {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("not JSON: {:?}", self.body))
    }
    fn text(&self) -> String {
        String::from_utf8(self.body.to_vec()).unwrap()
    }
}

/// Enforce posture unless `pairs` say otherwise.
async fn app_with(pairs: &[(&str, &str)]) -> TestApp {
    let mut all = vec![
        ("MEDIA_INTERNAL_PRINCIPAL_MODE", "enforce"),
        ("INTERNAL_PRINCIPAL_SECRET", PRINCIPAL_SECRET),
    ];
    all.extend_from_slice(pairs);
    let (pool, dir) = pool().await;
    let app = router(AppState::new(pool.clone(), Arc::new(test_config(&all))));
    TestApp {
        app,
        pool,
        _dir: dir,
    }
}

async fn app() -> TestApp {
    app_with(&[]).await
}

fn bearer(sub: &str, role: &str) -> String {
    let now = Utc::now().timestamp();
    let claims = InternalClaims {
        iss: "eex".into(),
        sub: sub.into(),
        role: role.into(),
        auth_mode: "plex".into(),
        server_id: "srv".into(),
        device_id: None,
        req_id: "r1".into(),
        iat: now,
        exp: now + 60,
    };
    format!(
        "Bearer {}",
        internal_principal::encrypt_with_secret(PRINCIPAL_SECRET.as_bytes(), &claims)
    )
}

impl TestApp {
    /// As the admin `plex:42` (iptv.test.ts's default session).
    async fn get(&self, uri: &str) -> Res {
        self.call(Method::GET, uri, Some(("plex:42", "admin")), &[], "")
            .await
    }
    async fn send(&self, method: Method, uri: &str, body: &str) -> Res {
        self.call(method, uri, Some(("plex:42", "admin")), &[], body)
            .await
    }
    async fn call(
        &self,
        method: Method,
        uri: &str,
        who: Option<(&str, &str)>,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Res {
        let mut req = axum::http::Request::builder().method(method).uri(uri);
        if let Some((sub, role)) = who {
            req = req.header(header::AUTHORIZATION, bearer(sub, role));
        }
        for (k, v) in headers {
            req = req.header(*k, HeaderValue::from_str(v).unwrap());
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        Res {
            status,
            headers,
            body,
        }
    }

    /// The iptv.test.ts beforeAll catalog.
    async fn seed(&self) {
        exec(
            &self.pool,
            "INSERT INTO categories (category_id, kind, name, parent_id) VALUES (1, 'live', 'News', 0);
             INSERT INTO vod (stream_id, name, rating, container_extension, tmdb_id, year, plot, director,
               cast_csv, fetched_at) VALUES (20, 'Matrix', 8.7, 'mp4', 603, 1999, 'Neo',
               'Lana Wachowski, Lilly Wachowski', 'Keanu Reeves, Carrie-Anne Moss', 'x');
             INSERT INTO series (series_id, name, tmdb_id, fetched_at) VALUES (30, 'GoT', 1399, 'x');
             INSERT INTO series_episodes (episode_id, series_id, season, episode_num, title, container_extension)
               VALUES ('ep-1', 30, 1, 1, 'Pilot', 'mkv');",
        )
        .await;
        channel(&self.pool, 10, 1, "CNN", None, Some("cnn.us"), 1).await;
    }
}

const AUTHED: &[(&str, &str)] = &[
    ("GET", "/api/iptv/categories?kind=live"),
    ("GET", "/api/iptv/live"),
    ("GET", "/api/iptv/vod"),
    ("GET", "/api/iptv/vod/20"),
    ("GET", "/api/iptv/series"),
    ("GET", "/api/iptv/series/30"),
    ("GET", "/api/iptv/epg/now?channelIds=10"),
    ("GET", "/api/iptv/epg/channel/10"),
    ("GET", "/api/iptv/epg/grid"),
    ("GET", "/api/iptv/epg/search?q=news"),
    ("GET", "/api/iptv/favorites"),
    ("POST", "/api/iptv/favorites"),
    ("DELETE", "/api/iptv/favorites/live/10"),
    ("GET", "/api/iptv/history"),
    ("POST", "/api/iptv/history"),
    ("POST", "/api/iptv/playlist/token"),
    ("GET", "/api/iptv/playlist/tokens"),
    ("DELETE", "/api/iptv/playlist/tokens/j"),
    ("GET", "/api/iptv/playlist.m3u?t=x"),
    ("POST", "/internal/members/plex:9/revoke-playlist-tokens"),
    ("DELETE", "/internal/members/plex:9"),
    ("POST", "/internal/availability"),
];

#[tokio::test]
async fn every_authed_route_is_401_without_a_principal_in_enforce_mode() {
    let t = app().await;
    t.seed().await;
    for (m, uri) in AUTHED {
        let m: Method = m.parse().unwrap();
        for auth in [None, Some("Bearer junk")] {
            let headers: Vec<(&str, &str)> =
                auth.map(|a| ("authorization", a)).into_iter().collect();
            let r = t.call(m.clone(), uri, None, &headers, "{}").await;
            assert_eq!(
                r.status,
                StatusCode::UNAUTHORIZED,
                "{m} {uri} auth={auth:?}"
            );
            assert_eq!(r.json(), json!({"error": "unauthorized"}));
        }
        let ok = t
            .call(m.clone(), uri, Some(("plex:42", "admin")), &[], "{}")
            .await;
        let body: Option<Value> = serde_json::from_slice(&ok.body).ok();
        assert_ne!(
            body,
            Some(json!({"error": "unauthorized"})),
            "{m} {uri} with a principal"
        );
    }
    let health = t.call(Method::GET, "/healthz", None, &[], "").await;
    assert_eq!(
        (health.status, health.text().as_str()),
        (StatusCode::OK, "ok")
    );
}

#[tokio::test]
async fn log_and_off_postures() {
    let t = app_with(&[("MEDIA_INTERNAL_PRINCIPAL_MODE", "log")]).await;
    t.seed().await;
    assert_eq!(
        t.call(Method::GET, "/api/iptv/live", None, &[], "")
            .await
            .status,
        StatusCode::OK
    );
    // No principal, no acting member: per-user routes still refuse.
    assert_eq!(
        t.call(Method::GET, "/api/iptv/favorites", None, &[], "")
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
    let user = t
        .call(
            Method::POST,
            "/internal/availability",
            Some(("plex:9", "user")),
            &[],
            r#"{"tmdb_ids":[]}"#,
        )
        .await;
    assert_eq!(
        (user.status, user.json()),
        (
            StatusCode::FORBIDDEN,
            json!({"error": "forbidden", "reason": "admin_only"})
        )
    );

    let off = app_with(&[("MEDIA_INTERNAL_PRINCIPAL_MODE", "off")]).await;
    let r = off
        .call(
            Method::POST,
            "/internal/availability",
            None,
            &[],
            r#"{"tmdb_ids":[]}"#,
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::OK, json!({"tmdb_ids": []}))
    );
    // Off still reads a valid principal for the acting member.
    assert_eq!(off.get("/api/iptv/favorites").await.status, StatusCode::OK);
    assert_eq!(
        off.call(Method::GET, "/api/iptv/favorites", None, &[], "")
            .await
            .status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn catalog_read_routes() {
    let t = app().await;
    t.seed().await;
    let cats = t.get("/api/iptv/categories?kind=live").await;
    assert_eq!(
        cats.json(),
        json!([{"category_id": 1, "name": "News", "parent_id": 0}])
    );
    let bad_kind = t.get("/api/iptv/categories?kind=music").await;
    assert_eq!(
        (bad_kind.status, bad_kind.json()),
        (StatusCode::BAD_REQUEST, json!({"error": "invalid_kind"}))
    );
    assert_eq!(
        t.get("/api/iptv/categories").await.status,
        StatusCode::BAD_REQUEST
    );

    let live = t.get("/api/iptv/live?q=cnn&limit=10").await.json();
    assert_eq!(
        live,
        json!({"items": [{"stream_id": 10, "num": 1, "name": "CNN", "stream_icon": null, "epg_channel_id": "cnn.us",
            "category_id": 1, "tv_archive": 1, "tv_archive_duration": 7}], "total": 1, "limit": 10, "offset": 0})
    );
    let paged = t
        .get("/api/iptv/live?limit=abc&offset=-4&categoryId=2.9")
        .await
        .json();
    assert_eq!(
        (&paged["total"], &paged["limit"], &paged["offset"]),
        (&json!(0), &json!(50), &json!(0))
    );
    let vod = t.get("/api/iptv/vod").await.json();
    assert_eq!(
        vod["items"][0],
        json!({"stream_id": 20, "name": "Matrix", "stream_icon": null, "rating": 8.7, "category_id": null,
            "year": 1999, "tmdb_id": 603})
    );
    assert_eq!(
        t.get("/api/iptv/series").await.json()["items"][0]["name"],
        "GoT"
    );

    let detail = t.get("/api/iptv/vod/20").await;
    assert_eq!(detail.status, StatusCode::OK);
    assert_eq!(detail.json()["cast_csv"], "Keanu Reeves, Carrie-Anne Moss");
    assert_eq!(detail.json()["container_extension"], "mp4");
    for (uri, status, err) in [
        ("/api/iptv/vod/21", StatusCode::NOT_FOUND, "not_found"),
        ("/api/iptv/vod/20.5", StatusCode::NOT_FOUND, "not_found"),
        ("/api/iptv/vod/abc", StatusCode::BAD_REQUEST, "invalid_id"),
        ("/api/iptv/series/31", StatusCode::NOT_FOUND, "not_found"),
        ("/api/iptv/series/x", StatusCode::BAD_REQUEST, "invalid_id"),
    ] {
        let r = t.get(uri).await;
        assert_eq!(
            (r.status, r.json()),
            (status, json!({"error": err})),
            "{uri}"
        );
    }
    let series = t.get("/api/iptv/series/30").await.json();
    assert_eq!(series["name"], "GoT");
    assert_eq!(series["seasons"][0]["episodes"][0]["episode_id"], "ep-1");
}

#[tokio::test]
async fn favorites_add_list_remove_and_validate() {
    let t = app().await;
    let add = |kind: &str, item: &str| json!({"kind": kind, "itemId": item}).to_string();
    let r = t
        .send(Method::POST, "/api/iptv/favorites", &add("live", "10"))
        .await;
    assert_eq!((r.status, r.body.len()), (StatusCode::CREATED, 0));
    let list = t.get("/api/iptv/favorites").await.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(
        (&list[0]["sub"], &list[0]["kind"], &list[0]["item_id"]),
        (&json!("plex:42"), &json!("live"), &json!("10"))
    );
    assert!(list[0]["added_ts"].as_str().unwrap().ends_with('Z'));
    // Another member sees none of it.
    let other = t
        .call(
            Method::GET,
            "/api/iptv/favorites",
            Some(("plex:7", "user")),
            &[],
            "",
        )
        .await;
    assert_eq!(other.json(), json!([]));

    let del = t
        .send(Method::DELETE, "/api/iptv/favorites/live/10", "")
        .await;
    assert_eq!((del.status, del.body.len()), (StatusCode::NO_CONTENT, 0));
    assert_eq!(t.get("/api/iptv/favorites").await.json(), json!([]));

    for kind in ["live", "vod", "series"] {
        assert_eq!(
            t.send(Method::POST, "/api/iptv/favorites", &add(kind, "99"))
                .await
                .status,
            StatusCode::CREATED
        );
        let path = format!("/api/iptv/favorites/{kind}/99");
        assert_eq!(
            t.send(Method::DELETE, &path, "").await.status,
            StatusCode::NO_CONTENT
        );
    }
    for (body, err) in [
        (add("series_episode", "10"), "invalid_kind"),
        (json!({"itemId": "10"}).to_string(), "invalid_kind"),
        (add("live", ""), "invalid_item"),
        (
            json!({"kind": "live", "itemId": 10}).to_string(),
            "invalid_item",
        ),
        ("not json".to_string(), "invalid_kind"),
    ] {
        let r = t.send(Method::POST, "/api/iptv/favorites", &body).await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": err})),
            "{body}"
        );
    }
    let r = t
        .send(Method::DELETE, "/api/iptv/favorites/series_episode/10", "")
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::BAD_REQUEST, json!({"error": "invalid_kind"}))
    );
}

#[tokio::test]
async fn history_records_and_reads_the_reported_position() {
    let t = app().await;
    let tr = &t;
    let put = move |b: Value| async move {
        tr.send(Method::POST, "/api/iptv/history", &b.to_string())
            .await
    };
    let r = put(json!({"kind": "vod", "itemId": "20", "positionSecs": 90, "durationSecs": 7200, "completed": false})).await;
    assert_eq!((r.status, r.body.len()), (StatusCode::CREATED, 0));
    let hist = t.get("/api/iptv/history?limit=10").await.json();
    assert_eq!(
        (
            &hist[0]["kind"],
            &hist[0]["item_id"],
            &hist[0]["position_secs"],
            &hist[0]["duration_secs"],
            &hist[0]["completed"]
        ),
        (
            &json!("vod"),
            &json!("20"),
            &json!(90),
            &json!(7200),
            &json!(0)
        )
    );
    // JS coercions: strings parse, negatives floor at 0, junk is 0/null, truthy completes.
    put(json!({"kind": "series_episode", "itemId": "ep-1", "positionSecs": "12.9", "durationSecs": "x", "completed": "yes"})).await;
    put(json!({"kind": "live", "itemId": "10", "positionSecs": -5})).await;
    let hist = t.get("/api/iptv/history").await.json();
    let ep = hist
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["item_id"] == "ep-1")
        .unwrap();
    assert_eq!(
        (&ep["position_secs"], &ep["duration_secs"], &ep["completed"]),
        (&json!(12), &json!(null), &json!(1))
    );
    let live = hist
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["item_id"] == "10")
        .unwrap();
    assert_eq!(
        (&live["position_secs"], &live["completed"]),
        (&json!(0), &json!(0))
    );
    assert_eq!(
        t.get("/api/iptv/history?limit=1")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        t.get("/api/iptv/history?limit=0")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1,
        "clamped to 1"
    );
    assert_eq!(
        t.get("/api/iptv/history?limit=nope")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        3,
        "default 50"
    );

    for (body, err) in [
        (json!({"kind": "series", "itemId": "1"}), "invalid_kind"),
        (json!({"kind": "vod"}), "invalid_item"),
    ] {
        let r = put(body).await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": err}))
        );
    }
}

#[test]
fn watch_threshold_fires_exactly_once_on_the_transition() {
    assert!(watch_qualified((0, Some(7200), 1)) && watch_qualified((0, None, 1)));
    assert!(watch_qualified((2880, Some(7200), 0)), "exactly 40%");
    assert!(!watch_qualified((2879, Some(7200), 0)) && !watch_qualified((60, Some(7200), 0)));
    assert!(!watch_qualified((5000, None, 0)) && !watch_qualified((5000, Some(0), 0)));
    let (q, under) = ((3000, Some(7200), 0), (600, Some(7200), 0));
    assert!(crossed_watch_threshold(None, q));
    assert!(!crossed_watch_threshold(None, under) && !crossed_watch_threshold(Some(under), under));
    assert!(crossed_watch_threshold(Some(under), q));
    assert!(
        !crossed_watch_threshold(Some(q), q)
            && !crossed_watch_threshold(Some(q), (7100, Some(7200), 1))
    );
    assert!(
        !crossed_watch_threshold(Some((7100, Some(7200), 1)), under),
        "a re-watch reset"
    );
}

/// A local stand-in for the recommender's /events/feedback.
async fn mock_recommender() -> (String, Arc<Mutex<Vec<(HeaderMap, Value)>>>) {
    let seen: Arc<Mutex<Vec<(HeaderMap, Value)>>> = Arc::default();
    let s = seen.clone();
    let app = Router::new().route(
        "/events/feedback",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let s = s.clone();
            async move {
                s.lock().unwrap().push((headers, body));
                StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

async fn wait_for(seen: &Mutex<Vec<(HeaderMap, Value)>>, n: usize) {
    for _ in 0..200 {
        if seen.lock().unwrap().len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("recommender never got {n} posts");
}

#[tokio::test]
async fn a_qualifying_watch_posts_watched_once_with_a_fresh_principal() {
    let (url, seen) = mock_recommender().await;
    let t = app_with(&[
        ("USE_LOCAL_RECOMMENDER", "1"),
        ("RECOMMENDER_URL", &url),
        ("RECOMMENDER_EVENT_SECRET", "evt"),
    ])
    .await;
    t.seed().await;
    let tr = &t;
    let put = move |kind: &str, item: &str, pos: i64| {
        let body = json!({"kind": kind, "itemId": item, "positionSecs": pos, "durationSecs": 7200})
            .to_string();
        async move {
            assert_eq!(
                tr.send(Method::POST, "/api/iptv/history", &body)
                    .await
                    .status,
                StatusCode::CREATED
            )
        }
    };
    put("vod", "20", 600).await; // under 40%
    put("live", "10", 7000).await; // live never posts
    put("vod", "20", 3000).await; // crosses
    wait_for(&seen, 1).await;
    put("vod", "20", 3100).await; // already qualified
    put("series_episode", "ep-1", 7000).await; // crosses, tv via the series
    wait_for(&seen, 2).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen[0].1,
        json!({"sub": "plex:42", "kind": "movie", "tmdb_id": 603, "signal": "watched"})
    );
    assert_eq!(
        seen[1].1,
        json!({"sub": "plex:42", "kind": "tv", "tmdb_id": 1399, "signal": "watched"})
    );
    let h = &seen[0].0;
    assert_eq!(h["x-recommender-secret"], "evt");
    let jwe = h["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    let claims =
        media_core::auth::verify_principal(PRINCIPAL_SECRET, jwe, Utc::now().timestamp()).unwrap();
    assert_eq!(
        (
            claims.sub.as_str(),
            claims.role.as_str(),
            claims.req_id.as_str()
        ),
        ("plex:42", "admin", "r1")
    );
}

#[tokio::test]
async fn no_watched_post_without_use_local_recommender() {
    let (url, seen) = mock_recommender().await;
    let t = app_with(&[("RECOMMENDER_URL", &url)]).await;
    t.seed().await;
    let body = json!({"kind": "vod", "itemId": "20", "completed": true}).to_string();
    assert_eq!(
        t.send(Method::POST, "/api/iptv/history", &body)
            .await
            .status,
        StatusCode::CREATED
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn epg_now_and_channel_routes() {
    let t = app().await;
    t.seed().await;
    let now = Utc::now();
    prog(
        &t.pool,
        "cnn.us",
        &iso(now - chrono::TimeDelta::minutes(10)),
        &iso(now + chrono::TimeDelta::minutes(20)),
        "Live now",
        None,
    )
    .await;
    let rows = t
        .get("/api/iptv/epg/now?channelIds=10,abc,0,-1,10,99")
        .await
        .json();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(
        (
            &rows[0]["channel_stream_id"],
            &rows[0]["current"]["title"],
            &rows[0]["next"]
        ),
        (&json!(10), &json!("Live now"), &json!(null))
    );
    assert_eq!(t.get("/api/iptv/epg/now").await.json(), json!([]));
    assert_eq!(
        t.get("/api/iptv/epg/channel/10")
            .await
            .json()
            .as_array()
            .unwrap()
            .len(),
        1,
        "default now..+24h"
    );
    for uri in [
        "/api/iptv/epg/channel/0",
        "/api/iptv/epg/channel/x",
        "/api/iptv/epg/channel/1.5",
    ] {
        let r = t.get(uri).await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": "invalid_id"})),
            "{uri}"
        );
    }
}

/// iptv.test.ts "EPG time-window normalization".
#[tokio::test]
async fn channel_grid_and_search_share_a_half_open_window() {
    let t = app().await;
    channel(
        &t.pool,
        80001,
        80001,
        "Window test",
        None,
        Some("window.test"),
        999,
    )
    .await;
    for (start, stop, title) in [
        ("11", "12", "Window past"),
        ("12", "13", "Window current"),
        ("13", "14", "Window future"),
    ] {
        prog(
            &t.pool,
            "window.test",
            &format!("2026-05-24T{start}:00:00.000Z"),
            &format!("2026-05-24T{stop}:00:00.000Z"),
            title,
            None,
        )
        .await;
    }
    for (from, to) in [
        ("2026-05-24T12:00:00Z", "2026-05-24T13:00:00Z"),
        ("2026-05-24T12:00:00.000Z", "2026-05-24T13:00:00.000Z"),
        ("2026-05-24T05:00:00-07:00", "2026-05-24T06:00:00-07:00"),
    ] {
        let q = format!(
            "from={}&to={}",
            from.replace('+', "%2B"),
            to.replace('+', "%2B")
        );
        let ch = t
            .get(&format!("/api/iptv/epg/channel/80001?{q}"))
            .await
            .json();
        assert_eq!(
            ch.as_array()
                .unwrap()
                .iter()
                .map(|r| r["title"].clone())
                .collect::<Vec<_>>(),
            [json!("Window current")],
            "{from}"
        );
        let grid = t
            .get(&format!("/api/iptv/epg/grid?categoryId=999&limit=1&{q}"))
            .await
            .json();
        assert_eq!(grid[0]["programmes"].as_array().unwrap().len(), 1);
        assert_eq!(grid[0]["programmes"][0]["title"], "Window current");
        let search = t
            .get(&format!(
                "/api/iptv/epg/search?q=Window&categoryIds=999&{q}"
            ))
            .await
            .json();
        assert_eq!(search["hits"].as_array().unwrap().len(), 1);
        assert_eq!(search["hits"][0]["programme"]["title"], "Window current");
    }
    for from in ["invalid", "2026-05-24T13:00:00Z", ""] {
        for route in [
            "/api/iptv/epg/channel/80001?",
            "/api/iptv/epg/grid?",
            "/api/iptv/epg/search?q=Window&",
        ] {
            let r = t
                .get(&format!("{route}from={from}&to=2026-05-24T13:00:00Z"))
                .await;
            assert_eq!(
                (r.status, r.json()),
                (StatusCode::BAD_REQUEST, json!({"error": "invalid_window"})),
                "{route} {from}"
            );
        }
    }
}

/// iptv.test.ts "GET /api/iptv/epg/search — server-side programme search".
#[tokio::test]
async fn epg_search_route() {
    let t = app().await;
    channel(&t.pool, 700, 500, "YES Network", None, Some("yes.us"), 5).await;
    channel(&t.pool, 701, 501, "Food Net", None, Some("food.us"), 6).await;
    prog(
        &t.pool,
        "yes.us",
        "2026-07-06T01:00:00Z",
        "2026-07-06T02:00:00Z",
        "Pregame",
        Some("Yankees preview"),
    )
    .await;
    prog(
        &t.pool,
        "yes.us",
        "2026-07-06T02:00:00Z",
        "2026-07-06T04:00:00Z",
        "Yankees vs Red Sox",
        Some("MLB regular season"),
    )
    .await;
    prog(
        &t.pool,
        "food.us",
        "2026-07-06T01:00:00Z",
        "2026-07-06T02:00:00Z",
        "Cooking Show",
        Some("recipes"),
    )
    .await;
    let w = "from=2026-07-06T00:00:00Z&to=2026-07-06T06:00:00Z";
    // Each caller has its own bucket of 10/s.
    let tr = &t;
    let as_user = move |sub: &'static str, uri: String| async move {
        tr.call(Method::GET, &uri, Some((sub, "user")), &[], "")
            .await
    };

    let body = as_user("plex:1", format!("/api/iptv/epg/search?q=Yankees&{w}"))
        .await
        .json();
    assert_eq!(body["total"], 2);
    assert_eq!(
        body["hits"][0],
        json!({"streamId": 700, "channelName": "YES Network", "categoryId": 5, "programIndex": 0,
            "programme": {"channel_id": "yes.us", "start_utc": "2026-07-06T01:00:00Z", "stop_utc": "2026-07-06T02:00:00Z",
                "title": "Pregame", "description": "Yankees preview"}})
    );
    assert_eq!(
        (
            &body["hits"][1]["programIndex"],
            &body["hits"][1]["programme"]["title"]
        ),
        (&json!(1), &json!("Yankees vs Red Sox"))
    );

    for q in ["", "q=e&", "q=%20%20&"] {
        let r = as_user("plex:2", format!("/api/iptv/epg/search?{q}{w}")).await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": "invalid_query"})),
            "{q}"
        );
    }
    let r = as_user(
        "plex:2",
        format!("/api/iptv/epg/search?q=Yankees&limit=0&{w}"),
    )
    .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::BAD_REQUEST, json!({"error": "invalid_limit"}))
    );

    let filtered = as_user(
        "plex:3",
        format!("/api/iptv/epg/search?q=Yankees&{w}&categoryIds=6"),
    )
    .await
    .json();
    assert_eq!(filtered, json!({"hits": [], "total": 0}));
    let limited = as_user(
        "plex:3",
        format!("/api/iptv/epg/search?q=Yankees&{w}&limit=1"),
    )
    .await
    .json();
    assert_eq!(
        (limited["hits"].as_array().unwrap().len(), &limited["total"]),
        (1, &json!(2))
    );

    for _ in 0..10 {
        assert_eq!(
            as_user("plex:4", format!("/api/iptv/epg/search?q=Yankees&{w}"))
                .await
                .status,
            StatusCode::OK
        );
    }
    let limited = as_user("plex:4", format!("/api/iptv/epg/search?q=Yankees&{w}")).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.json()["error"], "rate_limited");
    assert_eq!(limited.headers[header::RETRY_AFTER], "1");
    assert_eq!(
        as_user("plex:5", format!("/api/iptv/epg/search?q=Yankees&{w}"))
            .await
            .status,
        StatusCode::OK,
        "per caller"
    );
}

#[tokio::test]
async fn grid_validates_and_remembers_the_app_guide_scope() {
    let t = app().await;
    t.seed().await;
    for (q, err) in [
        ("categoryId=0", "invalid_category"),
        ("categoryId=abc", "invalid_category"),
        ("limit=-1", "invalid_limit"),
        ("limit=2.5", "invalid_limit"),
    ] {
        let r = t.get(&format!("/api/iptv/epg/grid?{q}")).await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": err})),
            "{q}"
        );
    }
    let pool = t.pool.clone();
    let scope = move || {
        let pool = pool.clone();
        async move {
            crate::sync::get_state(&pool, "feed_check_guide_scope")
                .await
                .unwrap()
        }
    };
    t.get("/api/iptv/epg/grid?categoryIds=1&q=cnn").await;
    assert!(
        scope().await.is_none(),
        "a filtered guide is not the app's guide"
    );
    let rows = t
        .get("/api/iptv/epg/grid?categoryIds=7,1,x,-2&limit=40")
        .await
        .json();
    assert_eq!(rows[0]["stream_id"], 10);
    assert_eq!(
        scope().await.unwrap().0,
        r#"{"categoryIds":[1,7],"limit":40,"hasEpg":false}"#
    );
    t.get("/api/iptv/epg/grid?categoryIds=1,7&hasEpg=true&limit=40")
        .await;
    assert_eq!(
        scope().await.unwrap().0,
        r#"{"categoryIds":[1,7],"limit":40,"hasEpg":true}"#
    );
}

#[tokio::test]
async fn guide_payloads_gzip_only_above_64kb_with_accept_encoding() {
    let t = app().await;
    exec(
        &t.pool,
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
         INSERT INTO channels (stream_id, num, name, category_id, fetched_at)
         SELECT i, i, 'Channel number ' || i || ' with a long enough name', 1, 'x' FROM n;",
    )
    .await;
    let gz = [("accept-encoding", "gzip, deflate, br")];
    let big = t
        .call(
            Method::GET,
            "/api/iptv/epg/grid",
            Some(("plex:42", "admin")),
            &gz,
            "",
        )
        .await;
    assert_eq!(big.headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(big.headers[header::VARY], "Accept-Encoding");
    assert_eq!(big.headers[header::CONTENT_TYPE], JSON_UTF8);
    let mut plain = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&big.body[..]), &mut plain)
        .unwrap();
    assert!(plain.len() > GZIP_MIN_CHARS);

    let unasked = t.get("/api/iptv/epg/grid").await;
    assert!(unasked.headers.get(header::CONTENT_ENCODING).is_none());
    assert_eq!(unasked.text(), plain, "same JSON either way");

    let small = t
        .call(
            Method::GET,
            "/api/iptv/epg/grid?limit=5",
            Some(("plex:42", "admin")),
            &gz,
            "",
        )
        .await;
    assert!(small.headers.get(header::CONTENT_ENCODING).is_none());
    assert_eq!(small.json().as_array().unwrap().len(), 5);
}

fn token_of(url: &str) -> &str {
    url.split("?t=").nth(1).unwrap()
}

/// iptv.test.ts "playlist token lifecycle", minus the membership and policy
/// gates Hono keeps.
#[tokio::test]
async fn playlist_token_lifecycle() {
    let t = app().await;
    t.seed().await;
    let fwd = [
        ("content-type", "application/json"),
        ("host", "internal.local:3001"),
        ("x-forwarded-proto", "https"),
        ("x-forwarded-host", "api.example.com"),
    ];
    let mint = t
        .call(
            Method::POST,
            "/api/iptv/playlist/token",
            Some(("plex:42", "user")),
            &fwd,
            r#"{"deviceName":"  Kitchen TV  "}"#,
        )
        .await;
    assert_eq!(mint.status, StatusCode::OK);
    let m = mint.json();
    assert_eq!(m["deviceName"], "Kitchen TV");
    let url = m["url"].as_str().unwrap();
    assert!(
        url.starts_with("https://api.example.com/api/iptv/playlist.m3u?t="),
        "{url}"
    );
    assert!(m["expiresAt"].as_str().unwrap().ends_with('Z'));
    let jti = m["jti"].as_str().unwrap().to_string();

    let tokens = t
        .call(
            Method::GET,
            "/api/iptv/playlist/tokens",
            Some(("plex:42", "user")),
            &[],
            "",
        )
        .await
        .json();
    assert_eq!(tokens["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(
        (&tokens["tokens"][0]["jti"], &tokens["tokens"][0]["revoked"]),
        (&json!(jti), &json!(false))
    );

    let m3u_path = format!("/api/iptv/playlist.m3u?t={}", token_of(url));
    let ok = t
        .call(
            Method::GET,
            &m3u_path,
            Some(("plex:42", "user")),
            &[("host", "box:3001")],
            "",
        )
        .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.headers[header::CONTENT_TYPE], "audio/x-mpegurl");
    assert_eq!(
        ok.headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"theemeraldexchange.m3u\""
    );
    assert_eq!(ok.headers[header::CACHE_CONTROL], "no-store");
    let body = ok.text();
    assert!(body.starts_with("#EXTM3U\n#EXTINF:-1 tvg-id=\"cnn.us\" tvg-name=\"CNN\" tvg-logo=\"\" group-title=\"News\",CNN\nhttp://box:3001/api/iptv/stream/live/10.ts?t="));

    let mismatch = t
        .call(Method::GET, &m3u_path, Some(("plex:9", "user")), &[], "")
        .await;
    assert_eq!(
        (mismatch.status, mismatch.json()),
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "invalid_token", "detail": "sub_mismatch"})
        )
    );

    let forbidden = t
        .call(
            Method::DELETE,
            &format!("/api/iptv/playlist/tokens/{jti}"),
            Some(("plex:9", "user")),
            &[],
            "",
        )
        .await;
    assert_eq!(
        (forbidden.status, forbidden.json()),
        (StatusCode::FORBIDDEN, json!({"error": "forbidden"}))
    );
    let del = t
        .call(
            Method::DELETE,
            &format!("/api/iptv/playlist/tokens/{jti}"),
            Some(("plex:42", "user")),
            &[],
            "",
        )
        .await;
    assert_eq!(
        (del.status, del.json()),
        (StatusCode::OK, json!({"ok": true}))
    );
    let again = t
        .send(
            Method::DELETE,
            &format!("/api/iptv/playlist/tokens/{jti}"),
            "",
        )
        .await;
    assert_eq!(
        (again.status, again.json()),
        (StatusCode::CONFLICT, json!({"error": "already_revoked"}))
    );
    let missing = t
        .send(Method::DELETE, "/api/iptv/playlist/tokens/nope", "")
        .await;
    assert_eq!(
        (missing.status, missing.json()),
        (StatusCode::NOT_FOUND, json!({"error": "not_found"}))
    );

    let revoked = t
        .call(Method::GET, &m3u_path, Some(("plex:42", "user")), &[], "")
        .await;
    assert_eq!(
        (revoked.status, revoked.json()),
        (StatusCode::UNAUTHORIZED, json!({"error": "token_revoked"}))
    );
}

#[tokio::test]
async fn playlist_m3u_refuses_legacy_rid_unpersisted_jti_and_bad_tokens() {
    let t = app().await;
    let legacy = playlist::sign(
        SECRET,
        emerald_contracts::StreamKind::Playlist,
        "all",
        "plex:42",
        60,
        None,
    );
    let r = t.get(&format!("/api/iptv/playlist.m3u?t={legacy}")).await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "invalid_token", "detail": "resource_mismatch"})
        )
    );
    let no_row = playlist::sign(
        SECRET,
        emerald_contracts::StreamKind::Playlist,
        playlist::PLAYLIST_RID,
        "plex:42",
        60,
        None,
    );
    let r = t.get(&format!("/api/iptv/playlist.m3u?t={no_row}")).await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "token_not_found"})
        )
    );
    let r = t.get("/api/iptv/playlist.m3u").await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::UNAUTHORIZED,
            json!({"error": "invalid_token", "detail": "invalid_signature"})
        )
    );
}

#[tokio::test]
async fn playlist_token_bodies_are_capped_and_optional() {
    let t = app().await;
    let r = t
        .call(
            Method::POST,
            "/api/iptv/playlist/token",
            Some(("plex:42", "user")),
            &[("content-length", "2048")],
            "{}",
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({"error": "body_too_large"})
        )
    );
    let huge = format!(r#"{{"deviceName":"{}"}}"#, "x".repeat(2000));
    let r = t
        .send(Method::POST, "/api/iptv/playlist/token", &huge)
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    let r = t.send(Method::POST, "/api/iptv/playlist/token", "").await;
    assert_eq!(
        (r.status, &r.json()["deviceName"]),
        (StatusCode::OK, &json!(null))
    );
    let long = format!(r#"{{"deviceName":"{}"}}"#, "é".repeat(300));
    assert_eq!(
        t.send(Method::POST, "/api/iptv/playlist/token", &long)
            .await
            .json()["deviceName"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        120
    );
}

#[tokio::test]
async fn minted_urls_only_echo_allowed_forwarded_hosts() {
    let t = app_with(&[("ALLOWED_ORIGINS", "https://theemeraldexchange.example")]).await;
    let tr = &t;
    let mint = move |host: &'static str| async move {
        let h = [
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", host),
            ("host", "internal.local:3001"),
        ];
        tr.call(
            Method::POST,
            "/api/iptv/playlist/token",
            Some(("plex:42", "user")),
            &h,
            "{}",
        )
        .await
        .json()["url"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(
        mint("api.theemeraldexchange.example")
            .await
            .starts_with("https://api.theemeraldexchange.example/")
    );
    assert!(
        mint("evil.example.com")
            .await
            .starts_with("https://theemeraldexchange.example/")
    );
}

#[tokio::test]
async fn internal_member_endpoints() {
    let t = app().await;
    t.seed().await;
    let mint = t
        .call(
            Method::POST,
            "/api/iptv/playlist/token",
            Some(("plex:9", "user")),
            &[],
            "{}",
        )
        .await
        .json();
    let m3u = format!(
        "/api/iptv/playlist.m3u?t={}",
        token_of(mint["url"].as_str().unwrap())
    );
    let fav = json!({"kind": "live", "itemId": "10"}).to_string();
    let hist = json!({"kind": "live", "itemId": "10", "positionSecs": 5}).to_string();
    for (uri, body) in [("/api/iptv/favorites", &fav), ("/api/iptv/history", &hist)] {
        for sub in ["plex:9", "plex:42"] {
            assert_eq!(
                t.call(Method::POST, uri, Some((sub, "user")), &[], body)
                    .await
                    .status,
                StatusCode::CREATED
            );
        }
    }

    // Admin-only.
    let user = t
        .call(
            Method::POST,
            "/internal/members/plex:9/revoke-playlist-tokens",
            Some(("plex:9", "user")),
            &[],
            "",
        )
        .await;
    assert_eq!(user.status, StatusCode::FORBIDDEN);

    // adminInvites: revoking the member kills its playlist tokens.
    let r = t
        .send(
            Method::POST,
            "/internal/members/plex:9/revoke-playlist-tokens",
            "",
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::OK, json!({"ok": true, "revoked": 1}))
    );
    let refused = t
        .call(Method::GET, &m3u, Some(("plex:9", "user")), &[], "")
        .await;
    assert_eq!(refused.json(), json!({"error": "token_revoked"}));

    // memberErasure: tokens, favorites and history for that sub only.
    t.call(
        Method::POST,
        "/api/iptv/playlist/token",
        Some(("plex:9", "user")),
        &[],
        "{}",
    )
    .await;
    let r = t.send(Method::DELETE, "/internal/members/plex:9", "").await;
    assert_eq!((r.status, r.json()), (StatusCode::OK, json!({"ok": true})));
    let pool = &t.pool;
    let count = move |sql: &'static str| async move {
        sqlx::query_scalar::<_, i64>(sql)
            .fetch_one(pool)
            .await
            .unwrap()
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM iptv_favorites WHERE sub = 'plex:9'").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM iptv_watch_history WHERE sub = 'plex:9'").await,
        0
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM iptv_playlist_tokens WHERE sub = 'plex:9' AND revoked_at IS NULL"
        )
        .await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM iptv_favorites WHERE sub = 'plex:42'").await,
        1
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM iptv_watch_history WHERE sub = 'plex:42'").await,
        1
    );

    // tagIptvAvailability: linked, not tombstoned, any kind.
    exec(
        &t.pool,
        "INSERT INTO iptv_title_link (iptv_kind, iptv_id, tmdb_kind, tmdb_id, removed_at) VALUES
           ('vod', 1, 'movie', 603, NULL), ('series', 2, 'tv', 1399, NULL), ('vod', 3, 'movie', 11, 'gone');",
    )
    .await;
    let r = t
        .send(
            Method::POST,
            "/internal/availability",
            r#"{"tmdb_ids":[1399,603,11,5,603,"x",1.5]}"#,
        )
        .await;
    assert_eq!(
        (r.status, r.json()),
        (StatusCode::OK, json!({"tmdb_ids": [603, 1399]}))
    );
    for bad_body in ["", "{}", r#"{"tmdb_ids":5}"#] {
        let r = t
            .send(Method::POST, "/internal/availability", bad_body)
            .await;
        assert_eq!(
            (r.status, r.json()),
            (StatusCode::BAD_REQUEST, json!({"error": "invalid_body"})),
            "{bad_body}"
        );
    }
}

#[test]
fn js_coercions() {
    assert_eq!(js_int("1e1"), Some(10));
    assert_eq!(js_int(" 7 "), Some(7));
    assert_eq!(
        (js_int("1.5"), js_int("x"), js_int("")),
        (None, None, Some(0))
    );
    assert_eq!(
        (
            int_or_undef(Some("-5.7")),
            int_or_undef(Some("")),
            int_or_undef(None)
        ),
        (Some(-5), None, None)
    );
    assert_eq!(js_slice("abc", 2), "ab");
    assert_eq!(js_slice("a😀b", 2), "a", "no half surrogate pair");
    assert_eq!(js_slice("a😀b", 3), "a😀");
    assert!(
        js_date("2026-05-24").is_some()
            && js_date("2026-05-24T12:00").is_some()
            && js_date("nope").is_none()
    );
    assert_eq!(
        iso(js_date("2026-05-24T05:00:00-07:00").unwrap()),
        "2026-05-24T12:00:00.000Z"
    );
    assert!(
        js_truthy(&json!("yes"))
            && !js_truthy(&json!(""))
            && !js_truthy(&json!(0))
            && js_truthy(&json!([]))
    );
    assert_eq!(
        (
            js_number(&json!(true)),
            js_number(&json!("12.5")),
            js_number(&Value::Null)
        ),
        (1.0, 12.5, 0.0)
    );
}
