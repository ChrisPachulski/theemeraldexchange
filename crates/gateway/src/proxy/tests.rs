//! Route tests carried from media.test.ts, transcode.test.ts, iptv.test.ts,
//! app.media-gate/iptv-disabled.test.ts, watchSignal.test.ts and
//! localMediaWatchSignal.test.ts that the goldens cannot express (the dev
//! posture, an unmounted proxy, the readiness wall clock, the gzip pass-through)
//! plus the pure helpers.

use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::Request;
use serde_json::{Value, json};

use super::fake::{Fake, Route};
use super::media::{WatchPoint, crossed_watch_threshold, resolve_watched, watch_qualified};
use super::transcode::append_token_to_manifest;
use super::*;
use crate::testutil::{ADMIN, ALICE, json_req, member, send, state_in};

const SECRET: &str = "gateway-test-internal-secret-0123456789ab";

async fn state(fake: &Fake, dir: &tempfile::TempDir, extra: &[(&str, &str)]) -> AppState {
    let urls = [
        ("USE_MEDIA_CORE", "1".to_string()),
        ("MEDIA_CORE_URL", format!("{}/mc", fake.url)),
        ("MEDIA_TRANSCODER_URL", format!("{}/tc", fake.url)),
        ("IPTV_SERVICE_URL", format!("{}/iptv", fake.url)),
        (
            "MEDIA_DB_PATH",
            dir.path().join("media.db").to_str().unwrap().to_string(),
        ),
        (
            "USER_POLICIES_PATH",
            dir.path()
                .join("policies.json")
                .to_str()
                .unwrap()
                .to_string(),
        ),
    ];
    let mut env: Vec<(&str, &str)> = urls.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.extend_from_slice(extra);
    state_in(dir, &env).await
}

// --- the manifest rewrite (appendTokenToManifest) --------------------------------------

#[test]
fn appends_the_token_to_relative_segment_lines_only() {
    let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg_00000.ts\n\n#EXTINF:6.0,\nseg_00001.ts\n#EXT-X-ENDLIST";
    assert_eq!(
        append_token_to_manifest(m, "TOK"),
        "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg_00000.ts?t=TOK\n\n#EXTINF:6.0,\nseg_00001.ts?t=TOK\n#EXT-X-ENDLIST"
    );
}

#[test]
fn uses_an_ampersand_after_an_existing_query_and_leaves_absolute_urls() {
    assert_eq!(
        append_token_to_manifest("seg.ts?x=1", "TOK"),
        "seg.ts?x=1&t=TOK"
    );
    assert_eq!(
        append_token_to_manifest("https://cdn.example/seg.ts\nHTTP://CDN.EXAMPLE/b.ts", "TOK"),
        "https://cdn.example/seg.ts\nHTTP://CDN.EXAMPLE/b.ts"
    );
}

#[test]
fn tokenizes_the_fmp4_init_map() {
    let m = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg_00000.m4s";
    assert_eq!(
        append_token_to_manifest(m, "TOK"),
        "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4?t=TOK\"\n#EXTINF:6.0,\nseg_00000.m4s?t=TOK"
    );
}

#[test]
fn tokenizes_both_renditions_of_a_trickplay_master() {
    let m = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nmedia.m3u8\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI=\"iframe.m3u8\"";
    assert_eq!(
        append_token_to_manifest(m, "TOK"),
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nmedia.m3u8?t=TOK\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI=\"iframe.m3u8?t=TOK\""
    );
}

#[test]
fn tokenizes_single_quoted_uris_and_leaves_an_absolute_one() {
    let m = "#EXT-X-MEDIA:TYPE=AUDIO,URI='a.m3u8',NAME=\"x\"\n#EXT-X-MAP:URI=\"https://cdn/i.mp4\"";
    assert_eq!(
        append_token_to_manifest(m, "TOK"),
        "#EXT-X-MEDIA:TYPE=AUDIO,URI='a.m3u8?t=TOK',NAME=\"x\"\n#EXT-X-MAP:URI=\"https://cdn/i.mp4\""
    );
}

// --- helpers --------------------------------------------------------------------------

#[test]
fn decodes_and_encodes_like_js() {
    assert_eq!(decode_uri_component("%6dovie").as_deref(), Some("movie"));
    assert_eq!(decode_uri_component("a%2Fb%20c").as_deref(), Some("a/b c"));
    assert_eq!(decode_uri_component("%E0%A4%A"), None, "truncated escape");
    assert_eq!(decode_uri_component("%zz"), None);
    assert_eq!(decode_uri_component("%C3%28"), None, "invalid UTF-8");
    assert_eq!(decode_uri_component("%ED%A0%80"), None, "a lone surrogate");
    assert_eq!(
        encode_uri_component("apple:000001.ab_c-d!~*'() /é"),
        "apple%3A000001.ab_c-d!~*'()%20%2F%C3%A9"
    );
}

#[test]
fn removes_dot_segments_as_the_url_parser_does() {
    use crate::app::remove_dot_segments as r;
    assert_eq!(r("/api/transcode/grant"), None);
    assert_eq!(
        r("/api/transcode/session/abc/../../warm").as_deref(),
        Some("/api/transcode/warm")
    );
    assert_eq!(
        r("/api/transcode/session/abc/%2e%2E/%2E./grant").as_deref(),
        Some("/api/transcode/grant")
    );
    assert_eq!(r("/a/./b/.").as_deref(), Some("/a/b/"));
    assert_eq!(r("/a/b/..").as_deref(), Some("/a/"));
    assert_eq!(r("/../../x").as_deref(), Some("/x"));
    assert_eq!(r("/a/...").as_deref(), None, "three dots is a name");
}

#[test]
fn query_loses_every_t_and_reserializes_as_url_search_params() {
    let uri: axum::http::Uri = "/x?page=2&t=a&q=a+b%20c&t=b".parse().unwrap();
    assert_eq!(query_without_token(&uri), "?page=2&q=a+b+c");
    let uri: axum::http::Uri = "/x?t=only".parse().unwrap();
    assert_eq!(query_without_token(&uri), "");
}

// --- the watched signal (watchSignal.test.ts, localMediaWatchSignal.test.ts) ------------

fn point(position: f64, duration: Option<f64>, completed: bool) -> WatchPoint {
    WatchPoint {
        position_secs: position,
        duration_secs: duration,
        completed,
    }
}

#[test]
fn watch_qualifies_at_forty_percent_or_completion() {
    assert!(watch_qualified(&point(0.0, Some(100.0), true)));
    assert!(watch_qualified(&point(0.0, None, true)));
    assert!(watch_qualified(&point(40.0, Some(100.0), false)));
    assert!(watch_qualified(&point(90.0, Some(100.0), false)));
    assert!(!watch_qualified(&point(39.0, Some(100.0), false)));
    assert!(!watch_qualified(&point(5000.0, None, false)), "no duration");
    assert!(
        !watch_qualified(&point(5000.0, Some(0.0), false)),
        "no divide by zero"
    );
    assert_eq!(super::media::WATCH_QUALIFY_FRACTION, 0.4);
}

#[test]
fn the_signal_fires_once_on_the_crossing() {
    let under = point(10.0, Some(100.0), false);
    let over = point(50.0, Some(100.0), false);
    assert!(
        crossed_watch_threshold(None, &over),
        "first qualifying report"
    );
    assert!(!crossed_watch_threshold(None, &under));
    assert!(
        crossed_watch_threshold(Some(&under), &over),
        "under to qualified"
    );
    assert!(
        !crossed_watch_threshold(Some(&over), &point(60.0, Some(100.0), false)),
        "every tick after"
    );
    assert!(
        crossed_watch_threshold(Some(&point(0.0, Some(100.0), false)), &over),
        "a re-watch fires again"
    );
}

async fn media_db() -> sqlx::SqlitePool {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    for sql in [
        "CREATE TABLE movies (id INTEGER PRIMARY KEY, tmdb_id INTEGER, title TEXT)",
        "CREATE TABLE shows (id INTEGER PRIMARY KEY, tmdb_id INTEGER, title TEXT)",
        "CREATE TABLE episodes (id INTEGER PRIMARY KEY, show_id INTEGER)",
        "CREATE TABLE media_watch_state (sub TEXT, media_kind TEXT, media_id INTEGER, position_secs INTEGER, duration_secs INTEGER, completed INTEGER)",
        "INSERT INTO movies VALUES (1, 550, 'Fight Club'), (2, NULL, 'Home video')",
        "INSERT INTO shows VALUES (10, 1399, 'GoT')",
        "INSERT INTO episodes VALUES (100, 10), (101, 10)",
        "INSERT INTO media_watch_state VALUES ('u', 'episode', 101, 50, 100, 0)",
    ] {
        sqlx::query(sql).execute(&pool).await.unwrap();
    }
    pool
}

#[tokio::test]
async fn resolves_a_movie_crossing_to_its_tmdb_id() {
    let db = media_db().await;
    let body =
        json!({ "media_kind": "movie", "media_id": 1, "position_secs": 41, "duration_secs": 100 });
    assert_eq!(
        resolve_watched(&db, "u", &body).await,
        Some((crate::stores::Kind::Movie, 550))
    );
}

#[tokio::test]
async fn maps_an_episode_to_its_show_and_skips_an_existing_crossing() {
    let db = media_db().await;
    let ep = |id: u64| json!({ "media_kind": "episode", "media_id": id, "position_secs": 60, "duration_secs": 100 });
    assert_eq!(
        resolve_watched(&db, "u", &ep(100)).await,
        Some((crate::stores::Kind::Tv, 1399))
    );
    assert_eq!(
        resolve_watched(&db, "u", &ep(101)).await,
        None,
        "already qualified"
    );
    assert_eq!(
        resolve_watched(&db, "other", &ep(101)).await,
        Some((crate::stores::Kind::Tv, 1399)),
        "another member's row is not this member's"
    );
}

#[tokio::test]
async fn ignores_under_threshold_and_titles_without_an_identity() {
    let db = media_db().await;
    for body in [
        json!({ "media_kind": "movie", "media_id": 1, "position_secs": 10, "duration_secs": 100 }),
        json!({ "media_kind": "movie", "media_id": 2, "completed": true }),
        json!({ "media_kind": "movie", "media_id": 99, "completed": true }),
        json!({ "media_kind": "movie", "media_id": "1", "completed": true }),
        json!({ "media_kind": "track", "media_id": 1, "completed": true }),
        json!({ "media_kind": "movie", "media_id": 1, "position_secs": "x", "completed": true }),
        json!([1]),
    ] {
        assert_eq!(resolve_watched(&db, "u", &body).await, None, "{body}");
    }
}

// --- postures and mounts --------------------------------------------------------------

#[tokio::test]
async fn proxies_without_a_principal_in_the_dev_posture() {
    let fake = Fake::start(SECRET).await;
    fake.set_routes(vec![
        Route::json("GET", "/mc/api/media/movies", 200, json!([])),
        Route::json("GET", "/tc/api/transcode/sessions", 200, json!([])),
        Route::json("GET", "/iptv/api/iptv/categories", 200, json!([])),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(&fake, &dir, &[]).await;
    let mut config = (*st.config).clone();
    config.auth.internal_principal_secret = None;
    st.config = std::sync::Arc::new(config);
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    for path in [
        "/api/media/movies",
        "/api/transcode/sessions",
        "/api/iptv/categories",
    ] {
        let r = send(&app, json_req("GET", path, Some(&cookie), None)).await;
        assert_eq!(r.status, 200, "{path}");
    }
    let calls = fake.settle().await;
    assert_eq!(calls.len(), 3);
    assert!(calls.iter().all(|c| c.principal.is_null()), "{calls:?}");
}

#[tokio::test]
async fn media_and_transcode_404_without_media_core() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[]).await;
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    for path in [
        "/api/media/movies",
        "/api/transcode/sessions",
        "/api/media/playback/movie/1",
    ] {
        let r = send(&app, json_req("GET", path, Some(&cookie), None)).await;
        assert_eq!(
            (r.status.as_u16(), r.body.as_str()),
            (404, r#"{"error":"not_found"}"#),
            "{path}"
        );
    }
}

#[tokio::test]
async fn iptv_and_dvr_404_when_disabled_and_dvr_needs_its_flag() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[("IPTV_DISABLED", "1"), ("DVR_ENABLED", "1")]).await;
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    for path in [
        "/api/iptv/categories",
        "/api/iptv/playlist.m3u",
        "/api/dvr/recordings",
    ] {
        let r = send(&app, json_req("GET", path, Some(&cookie), None)).await;
        assert_eq!(r.status, 404, "{path}");
    }
    assert_eq!(
        send(&app, json_req("GET", "/api/health", None, None))
            .await
            .status,
        200
    );

    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[]).await;
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    let r = send(
        &app,
        json_req("GET", "/api/dvr/recordings", Some(&cookie), None),
    )
    .await;
    assert_eq!(r.status, 404, "DVR off by default");
    let r = send(&app, json_req("GET", "/api/iptv/categories", None, None)).await;
    assert_eq!(r.status, 401, "IPTV on by default");
}

#[tokio::test]
async fn the_iptv_proxy_passes_a_gzipped_body_through_untouched() {
    let fake = Fake::start(SECRET).await;
    // A gzip-labelled body: the gateway must neither inflate nor re-encode it.
    let mut route = Route::json("GET", "/iptv/api/iptv/epg/grid", 200, json!(null))
        .header("content-encoding", "gzip")
        .header("connection", "keep-alive");
    route.body = "\u{1f}compressed-bytes-as-sent".into();
    let raw = route.body.clone().into_bytes();
    fake.set_routes(vec![route]);
    let dir = tempfile::tempdir().unwrap();
    let st = state(&fake, &dir, &[]).await;
    let cookie = member(&st, ALICE, "alice", "user").await;
    let app = crate::router(st);
    let req = Request::get("/api/iptv/epg/grid")
        .header("cookie", &cookie)
        .header("accept-encoding", "gzip")
        .body(Body::empty())
        .unwrap();
    let res = tower::ServiceExt::oneshot(app, req).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-encoding"], "gzip");
    assert_eq!(
        res.headers()["content-length"],
        raw.len().to_string().as_str()
    );
    assert!(
        res.headers().get("connection").is_none(),
        "hop-by-hop stripped"
    );
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        body.as_ref(),
        raw.as_slice(),
        "the bytes as the service sent them"
    );
    let calls = fake.settle().await;
    assert_eq!(
        calls[0].headers.get("accept-encoding").map(String::as_str),
        Some("gzip")
    );
}

#[tokio::test]
async fn the_readiness_poll_is_bounded_by_wall_clock() {
    let fake = Fake::start(SECRET).await;
    fake.set_routes(vec![
        Route::json(
            "POST",
            "/mc/api/media/play/movie/7/grant",
            200,
            json!({ "directPlay": false }),
        ),
        Route::json(
            "GET",
            "/mc/api/media/stream/movie/7",
            200,
            json!({ "sessionId": "s9", "manifestUrl": "/api/transcode/session/s9/index.m3u8" }),
        ),
        // Never lists a segment.
        Route::json(
            "GET",
            "/tc/api/transcode/session/s9/index.m3u8",
            200,
            json!("#EXTM3U"),
        ),
    ]);
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(&fake, &dir, &[]).await;
    st.proxy = std::sync::Arc::new(Proxy::new(Timings {
        ready_deadline: Duration::from_millis(400),
        ready_poll: Duration::from_millis(50),
    }));
    let cookie = member(&st, ADMIN, "admin", "admin").await;
    let app = crate::router(st);
    let started = Instant::now();
    let r = send(
        &app,
        json_req(
            "POST",
            "/api/media/playback/movie/7",
            Some(&cookie),
            Some(&json!({})),
        ),
    )
    .await;
    let took = started.elapsed();
    assert_eq!(r.status, 200, "{}", r.body);
    assert!(took < Duration::from_secs(3), "{took:?}");
    let b: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(b["delivery"], "hls");
    assert_eq!(
        b["trickplayUrl"],
        Value::Null,
        "no iframe probe for a session never ready"
    );
    let probes = fake
        .settle()
        .await
        .iter()
        .filter(|c| c.path.ends_with("index.m3u8"))
        .count();
    assert!((2..=10).contains(&probes), "{probes} probes");
}

// --- an unreachable upstream never logs the stream token -------------------------------

#[tokio::test]
async fn an_unreachable_upstream_logs_no_url_or_token() {
    crate::testutil::capture_logs();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = format!("http://127.0.0.1:{port}/api/iptv/stream/1?t=SECRET-STREAM-TOKEN");
    let r = Proxy::default()
        .send(
            "iptv",
            Method::GET,
            &url,
            HeaderMap::new(),
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
    assert_eq!(r.status(), StatusCode::GATEWAY_TIMEOUT);
    let logs = crate::testutil::logs();
    assert!(logs.contains("iptv upstream_unreachable"), "{logs}");
    assert!(!logs.contains("SECRET-STREAM-TOKEN"), "{logs}");
    assert!(!logs.contains(&url), "{logs}");
}
