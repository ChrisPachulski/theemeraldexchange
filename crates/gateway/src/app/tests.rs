//! Edge cases the goldens do not reach. Carried over from
//! app.logRedaction.test.ts, app.onError.test.ts, app.security.test.ts,
//! app.limits-*.test.ts, app.media-gate.test.ts, app.iptv-disabled.test.ts,
//! notConfigured.test.ts and routes/version.test.ts.

use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use serde_json::{Value, json};

use super::*;
use crate::testutil::*;

#[test]
fn redacts_secret_query_values() {
    for (line, want) in [
        (
            "<-- GET /api/iptv/stream/segment?u=eyJhbGciOiJIUzI1NiJ9.SECRET.sig",
            "<-- GET /api/iptv/stream/segment?u=[redacted]",
        ),
        (
            "--> GET /api/iptv/stream/live/42.ts?t=TOPSECRET 200 5ms",
            "--> GET /api/iptv/stream/live/42.ts?t=[redacted] 200 5ms",
        ),
        (
            "<-- GET /api/media/stream?rid=media:9&t=ABC.def.ghi&x=1",
            "<-- GET /api/media/stream?rid=media:9&t=[redacted]&x=1",
        ),
        (
            "<-- POST /api/auth/x?pinId=987654321&inviteCode=INVITE-SECRET&safe=1",
            "<-- POST /api/auth/x?pinId=[redacted]&inviteCode=[redacted]&safe=1",
        ),
        (
            "<-- GET /api/auth/workos/start?invite=INVITE-SECRET&intent=web",
            "<-- GET /api/auth/workos/start?invite=[redacted]&intent=web",
        ),
        (
            "<-- GET /api/auth/workos/callback?code=01JAUTHCODE&state=n0nce",
            "<-- GET /api/auth/workos/callback?code=[redacted]&state=n0nce",
        ),
        (
            "<-- GET /api/x?TOKEN=a&ID_TOKEN=b",
            "<-- GET /api/x?TOKEN=[redacted]&ID_TOKEN=[redacted]",
        ),
        ("--> GET /api/health 200 1ms", "--> GET /api/health 200 1ms"),
        (
            "<-- GET /api/iptv/epg/grid?type=full",
            "<-- GET /api/iptv/epg/grid?type=full",
        ),
    ] {
        assert_eq!(redact_request_secrets(line), want);
    }
}

/// The edge layers around one extra route.
async fn edge_with(route: Router) -> (tempfile::TempDir, Router) {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[("ALLOWED_ORIGINS", "https://app.example")]).await;
    let app = edge(route, &st);
    (dir, app)
}

async fn boom() -> &'static str {
    panic!("boom-secret-detail")
}

#[tokio::test]
async fn a_handler_panic_is_a_generic_500_with_the_request_id() {
    capture_logs();
    let (_dir, app) = edge_with(Router::new().route("/api/boom", get(boom))).await;
    let r = send(
        &app,
        Request::get("/api/boom")
            .header("x-request-id", "panic-1")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(r.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(r.body, r#"{"error":"internal"}"#);
    assert_eq!(r.headers["x-request-id"], "panic-1");
    assert_eq!(r.headers["x-frame-options"], "DENY");
    let logs = logs();
    assert!(
        logs.contains("unhandled error") && logs.contains("panic-1"),
        "{logs}"
    );
    assert!(
        logs.contains("boom-secret-detail"),
        "the detail is logged, not answered"
    );
    assert!(logs.contains("--> GET /api/boom 500"), "{logs}");
}

#[tokio::test]
async fn health_is_503_when_server_db_is_down() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[]).await;
    let app = router(st.clone());
    assert_eq!(
        send(&app, get_req("/api/health")).await.body,
        r#"{"ok":true}"#
    );
    st.auth.pool.close().await;
    let r = send(&app, get_req("/api/health")).await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r.body, r#"{"ok":false,"reason":"db_unavailable"}"#);
}

#[tokio::test]
async fn control_bodies_under_the_limit_reach_the_route() {
    let (_dir, app) = edge_with(Router::new().route(
        "/api/media/echo",
        axum::routing::post(|body: String| async move { body.len().to_string() }),
    ))
    .await;
    let post = |body: Body| {
        Request::post("/api/media/echo")
            .header("origin", "https://app.example")
            .body(body)
            .unwrap()
    };
    let r = send(
        &app,
        post(Body::from(vec![b'x'; SIDECAR_CONTROL_BODY_LIMIT])),
    )
    .await;
    assert_eq!((r.status, r.body.as_str()), (StatusCode::OK, "1048576"));
    let r = send(
        &app,
        post(Body::from(vec![b'x'; SIDECAR_CONTROL_BODY_LIMIT + 1])),
    )
    .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    // Other prefixes are not limited here.
    let (_dir, app) = edge_with(Router::new().route(
        "/api/mediax",
        axum::routing::post(|body: String| async move { body.len().to_string() }),
    ))
    .await;
    let r = send(
        &app,
        Request::post("/api/mediax")
            .header("origin", "https://app.example")
            .body(Body::from(vec![b'x'; SIDECAR_CONTROL_BODY_LIMIT + 1]))
            .unwrap(),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn unknown_paths_and_wrong_methods_are_the_json_404() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_in(&dir, &[]).await);
    for req in [
        get_req("/api/nope"),
        get_req("/settings"), // SPA off
        Request::post("/api/health").body(Body::empty()).unwrap(),
        Request::delete("/api/me").body(Body::empty()).unwrap(),
    ] {
        let r = send(&app, req).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
        assert_eq!(r.body, r#"{"error":"not_found"}"#);
    }
}

#[tokio::test]
async fn tmdb_art_redirects_to_the_cdn_without_media_core() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_in(&dir, &[]).await);
    for (path, want) in [
        ("/api/media/images/tmdb/abc.jpg?w=342", "w342/abc.jpg"),
        ("/api/media/images/tmdb/abc.jpg?w=200", "w342/abc.jpg"),
        ("/api/media/images/tmdb/Ab9.png?w=92", "w92/Ab9.png"),
        ("/api/media/images/tmdb/abc.jpg?w=1280", "original/abc.jpg"),
        ("/api/media/images/tmdb/abc.jpg", "w500/abc.jpg"),
    ] {
        let r = send(&app, get_req(path)).await;
        assert_eq!(r.status, StatusCode::TEMPORARY_REDIRECT, "{path}");
        assert_eq!(
            r.headers[header::LOCATION],
            format!("https://image.tmdb.org/t/p/{want}"),
            "{path}"
        );
    }
    for path in [
        "/api/media/images/tmdb/a.gif",
        "/api/media/images/tmdb/a%2F..%2Fb.jpg",
        "/api/media/images/album/7",
        "/api/media/movies",
    ] {
        let r = send(&app, get_req(path)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn the_spa_never_answers_api_paths_or_writes() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("dist")).unwrap();
    std::fs::write(dir.path().join("dist/index.html"), "<!doctype html>").unwrap();
    let mut st = state_in(&dir, &[]).await;
    st.spa_dir = Some(dir.path().join("dist"));
    let app = router(st);
    assert_eq!(
        send(&app, get_req("/deep/link")).await.body,
        "<!doctype html>"
    );
    for req in [
        get_req("/api/definitely-not-a-route"),
        get_req("/apiary"), // Hono's startsWith('/api') rule
        Request::post("/deep/link").body(Body::empty()).unwrap(),
    ] {
        let r = send(&app, req).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND);
        assert_eq!(r.headers["content-type"], "application/json");
    }
}

#[tokio::test]
async fn request_ids_follow_honos_rule() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_in(&dir, &[]).await);
    let echo = |id: String| {
        let app = app.clone();
        async move {
            let r = send(
                &app,
                Request::get("/api/health")
                    .header("x-request-id", &id)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
            r.headers["x-request-id"].to_str().unwrap().to_string()
        }
    };
    let ok = "a".repeat(255);
    assert_eq!(echo(ok.clone()).await, ok);
    assert_eq!(echo("A_b-c=".into()).await, "A_b-c=");
    for bad in ["a".repeat(256), "a b".into(), "a.b".into(), "".into()] {
        let id = echo(bad.clone()).await;
        assert_ne!(id, bad);
        assert_eq!(id.len(), 36);
    }
}

#[tokio::test]
async fn cors_is_off_without_allowed_origins() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_in(&dir, &[]).await);
    let r = send(
        &app,
        Request::get("/api/health")
            .header("origin", "https://app.example")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(r.headers.get("access-control-allow-origin").is_none());
}

async fn limits_body(extra: &[(&str, &str)], cookie: bool) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, extra).await;
    let mut req = Request::get("/api/limits");
    if cookie {
        let s = auth::session::Session {
            sub: "google:1234567890".into(),
            username: "G".into(),
            role: auth::Role::User,
            auth_mode: auth::AuthMode::Google,
            plex_auth_token: None,
        };
        let token = auth::session::mint(&st.auth.session_key, &s, chrono::Utc::now().timestamp());
        req = req.header("cookie", format!("eex.session={token}"));
    }
    let r = send(&router(st), req.body(Body::empty()).unwrap()).await;
    serde_json::from_str(&r.body).unwrap()
}

#[tokio::test]
async fn limits_flags_follow_the_config() {
    let b = limits_body(&[], false).await;
    assert_eq!(
        b,
        json!({
            "minFreeGb": 100, "maxMovieGb": 10, "maxTvGbPerEpisode": 5,
            "useLocalRecommender": false, "defaultProfileName": "choose me",
            "defaultSonarrRootFolderPath": null, "defaultRadarrRootFolderPath": null,
            "iptvEnabled": true, "mediaEnabled": false, "musicEnabled": false,
            "youtubeEnabled": false, "sonarrEnabled": false, "radarrEnabled": false,
            "sabEnabled": false, "accountDeletionEnabled": true, "dvrEnabled": false,
        })
    );
    // Music and YouTube need the media proxy too.
    let b = limits_body(
        &[
            ("MUSIC_LIBRARY_PATHS", "/m"),
            ("YOUTUBE_LIBRARY_PATHS", "/y"),
        ],
        false,
    )
    .await;
    assert_eq!(
        (b["musicEnabled"].clone(), b["youtubeEnabled"].clone()),
        (json!(false), json!(false))
    );
    let b = limits_body(
        &[("USE_MEDIA_CORE", "1"), ("YOUTUBE_LIBRARY_PATHS", "/y")],
        false,
    )
    .await;
    assert_eq!(
        (
            b["mediaEnabled"].clone(),
            b["musicEnabled"].clone(),
            b["youtubeEnabled"].clone()
        ),
        (json!(true), json!(false), json!(true))
    );
    // DVR needs IPTV.
    let b = limits_body(&[("DVR_ENABLED", "1"), ("IPTV_DISABLED", "1")], false).await;
    assert_eq!(
        (b["iptvEnabled"].clone(), b["dvrEnabled"].clone()),
        (json!(false), json!(false))
    );
    let b = limits_body(&[("SAB_API_KEY", "k"), ("RADARR_API_KEY", "k")], false).await;
    assert_eq!(
        (b["sabEnabled"].clone(), b["radarrEnabled"].clone()),
        (json!(true), json!(true))
    );
}

#[tokio::test]
async fn root_folders_need_a_session() {
    let both = [
        ("DEFAULT_SONARR_ROOT_FOLDER_PATH", "/mnt/tv"),
        ("DEFAULT_RADARR_ROOT_FOLDER_PATH", "/mnt/movies"),
        ("DEFAULT_PROFILE_NAME", "Choose Me"),
    ];
    let b = limits_body(&both, true).await;
    assert_eq!(b["defaultSonarrRootFolderPath"], "/mnt/tv");
    assert_eq!(b["defaultRadarrRootFolderPath"], "/mnt/movies");
    assert_eq!(b["defaultProfileName"], "choose me");
    // Only the two path fields carry them.
    let mut rest = b.clone();
    rest["defaultSonarrRootFolderPath"] = Value::Null;
    rest["defaultRadarrRootFolderPath"] = Value::Null;
    assert!(!rest.to_string().contains("/mnt/"));
    let b = limits_body(&both, false).await;
    assert_eq!(b["defaultSonarrRootFolderPath"], Value::Null);
    assert_eq!(b["defaultRadarrRootFolderPath"], Value::Null);
    let b = limits_body(&[("DEFAULT_ROOT_FOLDER_PATH", "/data/media")], true).await;
    assert_eq!(b["defaultSonarrRootFolderPath"], "/data/media");
    assert_eq!(b["defaultRadarrRootFolderPath"], "/data/media");
    let b = limits_body(&[], true).await;
    assert_eq!(b["defaultSonarrRootFolderPath"], Value::Null);
}

#[test]
fn js_numbers_drop_the_fraction_only_when_whole() {
    assert_eq!(serde_json::to_string(&js_number(100.0)).unwrap(), "100");
    assert_eq!(serde_json::to_string(&js_number(12.5)).unwrap(), "12.5");
    assert_eq!(serde_json::to_string(&js_number(0.1)).unwrap(), "0.1");
}

#[tokio::test]
async fn version_schema_states() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("media.db");
    let missing = missing.to_str().unwrap();
    assert_eq!(
        schema_state(missing).await,
        SchemaState::Absent { present: false }
    );
    assert!(!dir.path().join("media.db").exists(), "never created");
    let junk = dir.path().join("junk.db");
    std::fs::write(&junk, "not a database, just text that is long enough").unwrap();
    assert_eq!(
        schema_state(junk.to_str().unwrap()).await,
        SchemaState::Absent { present: false }
    );
}

#[tokio::test]
async fn version_advertises_configured_sign_ins() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(
        &dir,
        &[
            ("APPLE_CLIENT_ID", "com.example.app"),
            ("GOOGLE_CLIENT_ID", "a.apps.googleusercontent.com"),
            ("DEVICE_TOKEN_SECRET", ""),
        ],
    )
    .await;
    let r = send(&router(st), get_req("/api/version")).await;
    let b: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(b["auth_modes"], json!(["apple", "google"]));
    assert_eq!(b["accepting_device_pairs"], false);
    assert_eq!(b["release"], "dev");
    assert_eq!(b["schemas"]["exchange"], json!({"present": false}));

    // Plex is listed first, and only when PLEX_CLIENT_ID is set.
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[("PLEX_CLIENT_ID", "plex-client")]).await;
    let r = send(&router(st), get_req("/api/version")).await;
    let b: Value = serde_json::from_str(&r.body).unwrap();
    assert_eq!(b["auth_modes"], json!(["plex"]));
}

/// The path is normalized before a route is picked: otherwise a backslash or
/// dot-segment spelling selects one handler and is forwarded as another
/// (`/api/iptv/stream/..\playlist.m3u` would skip the playlist's gates).
#[tokio::test]
async fn routing_sees_the_normalized_path() {
    let dir = tempfile::tempdir().unwrap();
    let st = state_in(&dir, &[]).await;
    let app = router(st);
    let want = send(&app, get_req("/api/version")).await;
    for spelling in ["/api/health\\..\\version", "/api/health/../version"] {
        let r = send(&app, get_req(spelling)).await;
        assert_eq!((r.status, &r.body), (want.status, &want.body), "{spelling}");
    }
}
